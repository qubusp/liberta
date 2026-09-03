// Concurrency regression test for scripts/_log-event.mjs's index.json
// read-modify-write.
//
// THE EXACT LOST-UPDATE INTERLEAVING THIS DETECTS:
//   Before T9, _log-event.mjs did:
//     1. read index.json into memory (readIndexForUpdate)
//     2. find-or-push this session's entry in the in-memory object
//     3. JSON.stringify the WHOLE object and rename a tmp file over
//        index.json (writeJsonAtomic)
//   Step 3's rename is atomic, but steps 1-3 as a whole are NOT: if process A
//   and process B both do step 1 before either has done step 3, they both
//   hold the same "old" sessions array in memory. A pushes its own entry and
//   writes; B, unaware of A's entry, pushes its own entry onto ITS copy
//   (which lacks A's) and writes LAST -- silently overwriting A's write and
//   erasing A's session from the registry. With N processes racing, any
//   subset that reads before another subset's write can be dropped this way,
//   so with N >= 12 truly-concurrent writers hitting an empty index.json,
//   the surviving entry count is reliably < N on the old code (typically
//   just 1, the last writer to rename), even though every child process
//   exits 0 and events.jsonl faithfully records all N events.
//
//   T9 closes this by moving both the read and the write inside a single
//   advisory lock (updateJsonAtomic in scripts/_locked-json.cjs), so the
//   read always sees every prior writer's result.
//
// This test can run against either the current script or an arbitrary other
// copy of it (e.g. a pre-T9 checkout) via LIBERTA_LOG_EVENT_SCRIPT, so it can
// be pointed at the old, buggy file to demonstrate that it fails there. See
// the "run against old code" instructions below the test bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const logEventScript = process.env.LIBERTA_LOG_EVENT_SCRIPT
  ? path.resolve(process.env.LIBERTA_LOG_EVENT_SCRIPT)
  : path.join(repoRoot, 'scripts', '_log-event.mjs');

const N = 14; // >= 12 required; all N are spawned in one Promise.all batch,
              // so well over 8 run truly in parallel (bounded only by the
              // OS scheduler / process table, never serialized by this test).

const createdStores = [];

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liberta-index-concurrency-'));
  createdStores.push(dir);
  return dir;
}

function seedIndex(store) {
  fs.writeFileSync(
    path.join(store, 'index.json'),
    JSON.stringify({ active_session_id: null, sessions: [] }) + '\n'
  );
}

function runLogEventChild(store, sessionId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [logEventScript, sessionId, 'note', 'a', 'b', 'msg', '--status', 'running'],
      { env: { ...process.env, LIBERTA_RUNS_DIR: store }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr}`))));
  });
}

function findStrayArtifacts(store) {
  const strays = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.includes('.tmp-') || entry.name.includes('.lock')) strays.push(full);
    }
  };
  walk(store);
  return strays;
}

test.after(() => {
  for (const dir of createdStores) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sanity: LIBERTA_RUNS_DIR override is inside os.tmpdir(), never the real store', () => {
  const store = tempStore();
  seedIndex(store);
  const realTmpDir = fs.realpathSync(os.tmpdir());
  const realStore = fs.realpathSync(store);
  assert.ok(
    realStore === realTmpDir || realStore.startsWith(realTmpDir + path.sep),
    `refusing to proceed: temp store ${store} is not inside os.tmpdir() (${os.tmpdir()})`
  );
});

test('N concurrent writers with unique session ids all keep their index.json entry', async () => {
  const store = tempStore();
  seedIndex(store);
  const realTmpDir = fs.realpathSync(os.tmpdir());
  assert.ok(fs.realpathSync(store).startsWith(realTmpDir + path.sep) || fs.realpathSync(store) === realTmpDir);

  const ids = Array.from({ length: N }, (_, i) => `conc-unique-${i}`);
  // All N promises are created and handed to Promise.all in the same tick,
  // so all N child processes are spawned before any of them can have
  // finished -- this is what makes the race in the comment above reachable.
  await Promise.all(ids.map((id) => runLogEventChild(store, id)));

  const indexRaw = fs.readFileSync(path.join(store, 'index.json'), 'utf8');
  let index;
  assert.doesNotThrow(() => {
    index = JSON.parse(indexRaw);
  }, 'index.json must remain valid JSON after concurrent writers');

  assert.equal(
    index.sessions.length,
    N,
    `expected exactly ${N} session entries in index.json, found ${index.sessions.length} ` +
      `(a lost update dropped ${N - index.sessions.length} concurrent writer(s)' entries)`
  );
  assert.deepEqual(
    index.sessions.map((s) => s.id).sort(),
    [...ids].sort(),
    'index.json sessions must be exactly the set of unique ids that were written, one each'
  );

  for (const id of ids) {
    const eventsPath = path.join(store, id, 'events.jsonl');
    assert.ok(fs.existsSync(eventsPath), `events.jsonl missing for ${id}`);
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1, `expected exactly one events.jsonl line for ${id}, found ${lines.length}`);
    assert.doesNotThrow(() => JSON.parse(lines[0]), `events.jsonl line for ${id} must be valid JSON`);
  }
});

test('N concurrent writers targeting the SAME session id leave one valid index.json entry', async () => {
  const store = tempStore();
  seedIndex(store);

  const sharedId = 'conc-shared-session';
  await Promise.all(Array.from({ length: N }, () => runLogEventChild(store, sharedId)));

  const indexRaw = fs.readFileSync(path.join(store, 'index.json'), 'utf8');
  let index;
  assert.doesNotThrow(() => {
    index = JSON.parse(indexRaw);
  }, 'index.json must remain valid JSON after concurrent same-id writers');

  const matches = index.sessions.filter((s) => s.id === sharedId);
  assert.equal(
    matches.length,
    1,
    `expected exactly one index.json entry for the shared session id, found ${matches.length}`
  );
  assert.equal(matches[0].status, 'running', 'the single shared-session entry must have the expected status');

  const eventsPath = path.join(store, sharedId, 'events.jsonl');
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, N, `expected all ${N} appended events for the shared session, found ${lines.length}`);
});

test('no stray .tmp- or .lock artefacts remain in the store after concurrent writers finish', async () => {
  const store = tempStore();
  seedIndex(store);

  const ids = Array.from({ length: N }, (_, i) => `conc-artefact-${i}`);
  await Promise.all(ids.map((id) => runLogEventChild(store, id)));

  const strays = findStrayArtifacts(store);
  assert.deepEqual(strays, [], `stray lock/tmp artefacts left behind: ${strays.join(', ')}`);
});

// -----------------------------------------------------------------------
// How to demonstrate this test fails against the PRE-T9 implementation:
//
// The old script imports "./_store.mjs" by relative path, so the copy must
// live NEXT TO the real scripts/_store.mjs (a bare /tmp copy will fail to
// resolve that import). Drop it into scripts/ itself under a name the test
// runner's *.test.mjs discovery ignores, point LIBERTA_LOG_EVENT_SCRIPT at
// it, run, then delete it:
//
//   git show <T9-parent-sha>:scripts/_log-event.mjs > scripts/_log-event.pre-t9.mjs
//   LIBERTA_LOG_EVENT_SCRIPT=scripts/_log-event.pre-t9.mjs \
//     node --test test/index-concurrency.test.mjs
//   rm scripts/_log-event.pre-t9.mjs
// -----------------------------------------------------------------------
