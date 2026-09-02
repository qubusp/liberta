// Covers console/server.js's port-collision handling (see the T14 commit
// touching console/server.js's listenWithRetry): a second console started
// on a port the first one already bound must either refuse clearly (no
// raw EADDRINUSE stack trace, a one-line FATAL naming the port, non-zero
// exit) or, with LIBERTA_CONSOLE_PORT_AUTO set, silently move to a
// different free port -- and either way the FIRST console must be
// unaffected: still listening, still answering requests, after the
// second instance is gone.
//
// Every child here gets its OWN throwaway LIBERTA_RUNS_DIR (under
// os.tmpdir()) and its OWN throwaway LIBERTA_CONSOLE_DB sqlite file, so
// this test cannot read or write anything a real operator cares about,
// and two children in the same test cannot trip over each other's run
// store or database.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONSOLE_DIR = fileURLToPath(new URL('../console', import.meta.url));
const SERVER_JS = path.join(CONSOLE_DIR, 'server.js');

const LISTENING_RE = /liberta-console listening on http:\/\/localhost:(\d+)/;
const STACK_LINE_RE = /^\s+at /m;

// Every child spawned by any test in this file lands here so the after
// hook can guarantee it is dead, including when a test throws partway
// through. Never pkill -- only these exact child handles are ever
// touched.
const liveChildren = new Set();

function killChild(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

test.after(() => {
  for (const child of liveChildren) killChild(child);
  liveChildren.clear();
});

// An ephemeral port, bound and immediately released, so we know it was
// free at the moment of the probe. There is an inherent TOCTOU gap
// between release and the child's own bind, but on a normal dev machine
// nothing else claims a freshly-released ephemeral port in that window.
function getEphemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.once('listening', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.listen({ port: 0, host: '127.0.0.1', exclusive: true });
  });
}

function makeTmpRunsDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `liberta-console-port-${label}-`));
  return dir;
}

// Spawns a console child against PORT `port`. Resolves once the child
// either (a) prints its "listening" line on stdout, (b) exits, or (c) the
// timeout elapses -- whichever comes first -- so callers can inspect
// whichever of those three actually happened instead of only handling the
// success path.
function spawnConsoleChild({ port, autoPort, runsDir, dbPath }) {
  const child = spawn(
    process.execPath,
    [SERVER_JS],
    {
      cwd: CONSOLE_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        LIBERTA_CONSOLE_HOST: '127.0.0.1',
        LIBERTA_CONSOLE_PASSWORD: 'test-password-not-a-real-secret',
        LIBERTA_CONSOLE_SECRET: 'test-secret-not-a-real-secret',
        LIBERTA_RUNS_DIR: runsDir,
        LIBERTA_CONSOLE_DB: dbPath,
        LIBERTA_CONSOLE_PORT_AUTO: autoPort ? '1' : '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  liveChildren.add(child);

  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

  const state = {
    child,
    get stdout() { return stdoutBuf; },
    get stderr() { return stderrBuf; },
    exitCode: null,
    exitSignal: null,
    exited: false,
  };
  child.once('exit', (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
    liveChildren.delete(child);
  });
  return state;
}

// Polls `state` (as returned by spawnConsoleChild) until either its
// listening line has appeared or it has exited, rather than sleeping a
// fixed amount -- tolerant of a slow / loaded machine.
async function waitForOutcome(state, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const match = state.stdout.match(LISTENING_RE);
    if (match) return { kind: 'listening', port: Number(match[1]) };
    if (state.exited) return { kind: 'exited', code: state.exitCode, signal: state.exitSignal };
    if (Date.now() - start > timeoutMs) {
      return { kind: 'timeout' };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Waits (polling) for a child that has already exited (or is about to)
// to actually report its exit code, tolerant of a slow machine.
async function waitForExit(state, timeoutMs = 10000) {
  const start = Date.now();
  while (!state.exited) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `child did not exit within ${timeoutMs}ms\nstdout:\n${state.stdout}\nstderr:\n${state.stderr}`
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return state;
}

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
  });
}

test('LIBERTA_RUNS_DIR fixtures used by this test live under os.tmpdir()', () => {
  const tmp = fs.realpathSync(os.tmpdir());
  const a = fs.realpathSync(makeTmpRunsDir('assert-check'));
  assert.ok(
    a === tmp || a.startsWith(tmp + path.sep),
    `expected fixture runs dir ${a} to be inside os.tmpdir() (${tmp})`
  );
  fs.rmSync(a, { recursive: true, force: true });
});

test('second console on a taken port, no auto-port: refuses clearly, first instance is unaffected', async () => {
  const port = await getEphemeralPort();
  const runsDirA = makeTmpRunsDir('a');
  const dbA = path.join(runsDirA, 'first.sqlite3');
  const runsDirB = makeTmpRunsDir('b');
  const dbB = path.join(runsDirB, 'second.sqlite3');

  assert.ok(fs.realpathSync(runsDirA).startsWith(fs.realpathSync(os.tmpdir())));
  assert.ok(fs.realpathSync(runsDirB).startsWith(fs.realpathSync(os.tmpdir())));

  const first = spawnConsoleChild({ port, autoPort: false, runsDir: runsDirA, dbPath: dbA });
  const firstOutcome = await waitForOutcome(first);
  assert.equal(
    firstOutcome.kind,
    'listening',
    `first console did not report listening:\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`
  );
  assert.equal(firstOutcome.port, port);

  // Case 1: second child, same port, no auto-port flag -- must refuse
  // clearly and exit non-zero, without dumping a raw stack trace, and
  // must name the port it could not bind.
  const second = spawnConsoleChild({ port, autoPort: false, runsDir: runsDirB, dbPath: dbB });
  const secondOutcome = await waitForOutcome(second);
  assert.equal(
    secondOutcome.kind,
    'exited',
    `expected the second console (no auto-port) to exit, got: ${JSON.stringify(secondOutcome)}\n` +
      `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`
  );
  await waitForExit(second);
  assert.notEqual(
    second.exitCode,
    0,
    `expected non-zero exit code from the second console\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`
  );
  assert.ok(
    second.stderr.includes(String(port)),
    `expected the second console's stderr to name the taken port ${port}\nstderr:\n${second.stderr}`
  );
  assert.match(second.stderr.toLowerCase(), /fatal|error|in use|refus/i);
  assert.doesNotMatch(
    second.stdout,
    STACK_LINE_RE,
    `expected no raw stack trace on stdout\nstdout:\n${second.stdout}`
  );
  assert.doesNotMatch(
    second.stderr,
    STACK_LINE_RE,
    `expected no raw stack trace on stderr\nstderr:\n${second.stderr}`
  );

  // Case 3 (checked here, using this same pair): the first instance is
  // still listening and still answering after the failed second one
  // exited -- a failed second instance must not take down the first.
  const status = await httpGet(port, '/login');
  assert.equal(status, 200, `expected the first console to still answer /login with 200 after the second failed`);

  killChild(first.child);
});

test('second console on a taken port, with LIBERTA_CONSOLE_PORT_AUTO=1: picks a different free port and starts', async () => {
  const port = await getEphemeralPort();
  const runsDirA = makeTmpRunsDir('auto-a');
  const dbA = path.join(runsDirA, 'first.sqlite3');
  const runsDirB = makeTmpRunsDir('auto-b');
  const dbB = path.join(runsDirB, 'second.sqlite3');

  const first = spawnConsoleChild({ port, autoPort: false, runsDir: runsDirA, dbPath: dbA });
  const firstOutcome = await waitForOutcome(first);
  assert.equal(
    firstOutcome.kind,
    'listening',
    `first console did not report listening:\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`
  );
  assert.equal(firstOutcome.port, port);

  const second = spawnConsoleChild({ port, autoPort: true, runsDir: runsDirB, dbPath: dbB });
  const secondOutcome = await waitForOutcome(second);
  assert.equal(
    secondOutcome.kind,
    'listening',
    `expected the second console (auto-port) to start listening, got: ${JSON.stringify(secondOutcome)}\n` +
      `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`
  );
  assert.notEqual(
    secondOutcome.port,
    port,
    `expected the auto-port second console to bind a DIFFERENT port from the first (both got ${port})`
  );

  // First instance must still be fine, even though a second, differently
  // ported instance is now also running.
  const status = await httpGet(port, '/login');
  assert.equal(status, 200, `expected the first console to still answer /login with 200 while the second (auto-port) instance runs`);

  killChild(second.child);
  killChild(first.child);
});
