// Exercises console/server.js's password login end to end: spawn the real
// server as a child process, drive it over HTTP exactly like a browser
// would (GET /login, then POST /login), and assert on the resulting
// cookie/redirect/authenticated-request behaviour.
//
// Rate limiter note: console/auth.js's login rate limiter
// (createLoginRateLimiter) is a per-process, per-IP in-memory sliding
// window (max 10 attempts / 60s). Rather than carefully budgeting attempts
// against a shared server, each scenario below starts its OWN server child
// on its own port, so every scenario gets a fresh limiter and there is no
// risk of one scenario's attempts tripping another's.
//
// DB note: console/db.js does not yet expose a way to point the sqlite
// file somewhere throwaway per test run (TODO: see task T14). Until that
// lands, this test just lets the server use its normal console/data
// path, which is gitignored (console/data/*.sqlite) and safe to share
// across test runs since ensureSchema()/seedSkillsFromDisk() are
// idempotent.
//
// This test must never touch ~/.claude/liberta-runs -- it only starts a
// throwaway console/server.js child and talks to it over loopback HTTP.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const consoleDir = join(__dirname, '..', 'console');

const DEFAULT_PASSWORD = 'libert@123!';
const WRONG_PASSWORD = 'wrongpassword';
const EXPLICIT_PASSWORD = 'a-distinct-explicit-test-password-9f2c';

const LISTENING_RE = /liberta-console listening on http:\/\/localhost:(\d+)/;

// Find an unused high port by asking the OS for an ephemeral one, then
// releasing it immediately. There's a small unavoidable TOCTOU window
// between the close() below and the child binding it, but that's the
// standard/accepted way to pick a "probably free" port in tests.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Start a fresh console/server.js child on its own port. `extraEnv` may
// set LIBERTA_CONSOLE_PASSWORD explicitly; when it's omitted the child's
// env deliberately has no LIBERTA_CONSOLE_PASSWORD key at all (not even
// an empty one), so the server falls back to its built-in default.
async function startServer(extraEnv = {}) {
  const port = await findFreePort();
  const env = { ...process.env };
  delete env.LIBERTA_CONSOLE_PASSWORD;
  Object.assign(env, {
    PORT: String(port),
    LIBERTA_CONSOLE_HOST: '127.0.0.1',
  });
  Object.assign(env, extraEnv);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: consoleDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
  });

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `console/server.js did not print its listening line within 10s.\n` +
            `stdout so far:\n${stdoutBuf}\nstderr so far:\n${stderrBuf}`
        )
      );
    }, 10_000);

    const onExitEarly = ({ code, signal }) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `console/server.js exited before listening (code=${code}, signal=${signal}).\n` +
            `stdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`
        )
      );
    };
    child.once('exit', onExitEarly);

    const check = () => {
      if (LISTENING_RE.test(stdoutBuf)) {
        clearTimeout(timeout);
        child.off('exit', onExitEarly);
        resolve();
      }
    };
    child.stdout.on('data', check);
    check();
  });

  return {
    child,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
    waitForExit: () => exitPromise,
  };
}

async function stopServer(server) {
  if (!server || !server.child || server.child.exitCode !== null || server.child.signalCode !== null) {
    return;
  }
  server.child.kill('SIGKILL');
  await server.waitForExit();
}

// Merge Set-Cookie response headers (possibly several) into a single
// Cookie request header value, keeping only the name=value part of each.
function cookieHeaderFrom(response) {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : response.headers.raw
      ? response.headers.raw()['set-cookie'] || []
      : [];
  return raw.map((c) => c.split(';')[0]).join('; ');
}

// Perform a real login: GET /login first (to pick up whatever cookie the
// server hands out on the login page, same as a real browser would),
// then POST /login with the given password. Returns everything a test
// might want to assert on.
async function attemptLogin(baseUrl, password) {
  const getResp = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
  assert.equal(getResp.status, 200, 'GET /login should render the login page');
  const getCookie = cookieHeaderFrom(getResp);

  const postResp = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(getCookie ? { cookie: getCookie } : {}),
    },
    body: new URLSearchParams({ password }).toString(),
  });
  const postCookie = cookieHeaderFrom(postResp);
  const sessionCookie = [getCookie, postCookie].filter(Boolean).join('; ');

  return { getResp, postResp, sessionCookie };
}

// Confirm a cookie value (or lack thereof) does/doesn't grant access to a
// protected, non-API route ("/") without being bounced back to /login.
async function isAuthenticated(baseUrl, cookie) {
  const resp = await fetch(`${baseUrl}/`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get('location') || '';
    if (location.includes('/login')) return false;
  }
  // Some other redirect or a straight 200 both count as "not bounced to
  // login"; the dashboard route on a fresh DB should just 200.
  return resp.status === 200 || (resp.status >= 300 && resp.status < 400);
}

test('console password login', async (t) => {
  await t.test('default password (no LIBERTA_CONSOLE_PASSWORD): correct password logs in', async () => {
    const server = await startServer();
    try {
      const { postResp, sessionCookie } = await attemptLogin(server.baseUrl, DEFAULT_PASSWORD);

      assert.ok(
        postResp.status === 200 || (postResp.status >= 300 && postResp.status < 400),
        `expected success status, got ${postResp.status}`
      );
      assert.ok(sessionCookie.length > 0, 'expected a session cookie to be set on successful login');
      assert.match(sessionCookie, /liberta_console_session=/, 'expected the session cookie to be present');

      const authed = await isAuthenticated(server.baseUrl, sessionCookie);
      assert.equal(authed, true, 'a subsequent authenticated request should not be bounced to /login');

      assert.match(
        server.getStderr(),
        /insecure|WARNING/i,
        'expected the insecure-default warning on stderr when no LIBERTA_CONSOLE_PASSWORD is set'
      );
    } finally {
      await stopServer(server);
    }
  });

  await t.test('default password (no LIBERTA_CONSOLE_PASSWORD): wrong password does not log in', async () => {
    const server = await startServer();
    try {
      const { postResp, sessionCookie } = await attemptLogin(server.baseUrl, WRONG_PASSWORD);

      assert.equal(postResp.status, 401, `expected 401 for a wrong password, got ${postResp.status}`);

      const authed = await isAuthenticated(server.baseUrl, sessionCookie);
      assert.equal(authed, false, 'a wrong-password attempt must not grant an authenticated session');
    } finally {
      await stopServer(server);
    }
  });

  await t.test('explicit LIBERTA_CONSOLE_PASSWORD: explicit value logs in, default does not', async () => {
    const server = await startServer({ LIBERTA_CONSOLE_PASSWORD: EXPLICIT_PASSWORD });
    try {
      // Explicit password should log in.
      {
        const { postResp, sessionCookie } = await attemptLogin(server.baseUrl, EXPLICIT_PASSWORD);
        assert.ok(
          postResp.status === 200 || (postResp.status >= 300 && postResp.status < 400),
          `expected success status for the explicit password, got ${postResp.status}`
        );
        assert.ok(sessionCookie.length > 0, 'expected a session cookie for the explicit password');
        const authed = await isAuthenticated(server.baseUrl, sessionCookie);
        assert.equal(authed, true, 'the explicit password should produce an authenticated session');
      }

      // The built-in default password must NOT work once an explicit
      // password is configured.
      {
        const { postResp, sessionCookie } = await attemptLogin(server.baseUrl, DEFAULT_PASSWORD);
        assert.equal(
          postResp.status,
          401,
          `the built-in default password must be rejected once LIBERTA_CONSOLE_PASSWORD is set, got ${postResp.status}`
        );
        const authed = await isAuthenticated(server.baseUrl, sessionCookie);
        assert.equal(authed, false, 'the default password must not authenticate when an explicit password is set');
      }

      // With an explicit password configured, the insecure-default
      // warning must NOT be printed.
      assert.doesNotMatch(
        server.getStderr(),
        /insecure|built-in default password/i,
        'the insecure-default warning must only appear when no LIBERTA_CONSOLE_PASSWORD is set'
      );
    } finally {
      await stopServer(server);
    }
  });
});
