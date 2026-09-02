// Covers scripts/_locked-json.cjs (the advisory lock + locked
// read-modify-write) and the way scripts/_log-event.mjs uses it.
//
// The bug being regression-tested: _log-event.mjs used to read index.json,
// mutate one entry and write the whole file back. The write was atomic but
// the read-modify-write window was not guarded, so two sessions logging a
// status at the same moment both read the same old index and the loser's
// entry disappeared from the registry.
//
// Every test points the store at a throwaway temp directory via
// LIBERTA_RUNS_DIR. Nothing here may touch ~/.claude/liberta-runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const logEvent = path.join(repoRoot, 'scripts', '_log-event.mjs');
const locked = require(path.join(repoRoot, 'scripts', '_locked-json.cjs'));

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liberta-lock-test-'));
  return dir;
}

function runLogEvent(store, args) {
  return spawnSync(process.execPath, [logEvent, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LIBERTA_RUNS_DIR: store },
  });
}

function deadPid() {
  // A pid that has certainly exited: run a no-op child to completion.
  const r = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' });
  return r.pid;
}

test('concurrent _log-event runs all keep their index.json entry', async () => {
  const store = tempStore();
  fs.writeFileSync(path.join(store, 'index.json'), JSON.stringify({ active_session_id: null, sessions: [] }) + '\n');

  const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
  await Promise.all(
    ids.map(
      (id) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [logEvent, id, 'note', 'a', 'b', 'hello', '--status', 'running'], {
            env: { ...process.env, LIBERTA_RUNS_DIR: store },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', (d) => {
            stderr += d;
          });
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr}`))));
        })
    )
  );

  const index = JSON.parse(fs.readFileSync(path.join(store, 'index.json'), 'utf8'));
  assert.deepEqual(
    index.sessions.map((s) => s.id).sort(),
    [...ids].sort(),
    'a concurrent writer lost an entry'
  );
  // The lock file must not be left behind by a successful run.
  assert.equal(fs.existsSync(path.join(store, 'index.json.lock')), false);
});

test('a successful _log-event leaves no lock or tmp files behind', () => {
  const store = tempStore();
  const r = runLogEvent(store, ['s1', 'note', 'a', 'b', 'hello', '--status', 'running']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    fs.readdirSync(store).filter((f) => f.includes('.lock') || f.includes('.tmp-')),
    []
  );
  assert.deepEqual(
    fs.readdirSync(path.join(store, 's1')).filter((f) => f.includes('.lock') || f.includes('.tmp-')),
    []
  );
});

test('acquireLock is exclusive, and the timeout names the lock file and holder pid', () => {
  const store = tempStore();
  const lockPath = path.join(store, 'index.json.lock');
  const lock = locked.acquireLock(lockPath, { timeoutMs: 200 });
  try {
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(held.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(held.ts)), 'lock file records an ISO timestamp');

    assert.throws(
      () => locked.acquireLock(lockPath, { timeoutMs: 200 }),
      (err) => {
        assert.equal(err.code, 'ELOCKTIMEOUT');
        assert.match(err.message, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(err.message, new RegExp(`pid ${process.pid}\\b`));
        return true;
      }
    );
  } finally {
    lock.release();
  }
  assert.equal(fs.existsSync(lockPath), false, 'release() removed the lock file');
});

test('a stale lock (old timestamp + dead pid) is taken over', () => {
  const store = tempStore();
  const lockPath = path.join(store, 'index.json.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid(), ts: new Date(Date.now() - 120000).toISOString(), token: 'zzz' }) + '\n'
  );
  const lock = locked.acquireLock(lockPath, { timeoutMs: 500, staleMs: 1000 });
  const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(held.pid, process.pid);
  lock.release();
});

test('a young lock held by a live pid is NOT taken over', () => {
  const store = tempStore();
  const lockPath = path.join(store, 'index.json.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token: 'zzz' }) + '\n'
  );
  assert.throws(() => locked.acquireLock(lockPath, { timeoutMs: 150, staleMs: 1000 }), /could not acquire lock/);
  fs.unlinkSync(lockPath);
});

test('the lock is released when the mutate function throws', () => {
  const store = tempStore();
  const file = path.join(store, 'index.json');
  fs.writeFileSync(file, JSON.stringify({ sessions: [] }) + '\n');
  assert.throws(
    () =>
      locked.updateJsonAtomic(file, () => {
        throw new Error('boom');
      }),
    /boom/
  );
  assert.equal(fs.existsSync(`${file}.lock`), false, 'lock survived a throwing mutate');
  // and the file is untouched, so the next update still works
  const res = locked.updateJsonAtomic(file, (v) => {
    v.sessions.push({ id: 'x' });
    return v;
  });
  assert.equal(res.written, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions.length, 1);
});

test('updateJsonAtomic re-reads the file INSIDE the lock', () => {
  const store = tempStore();
  const file = path.join(store, 'index.json');
  fs.writeFileSync(file, JSON.stringify({ sessions: [{ id: 'a' }] }) + '\n');
  // Simulate another process having written between the caller deciding to
  // update and the lock being taken: the mutate function must see the NEW
  // contents, not a value captured earlier.
  fs.writeFileSync(file, JSON.stringify({ sessions: [{ id: 'a' }, { id: 'b' }] }) + '\n');
  let seen = null;
  locked.updateJsonAtomic(file, (v) => {
    seen = v.sessions.map((s) => s.id);
    v.sessions.push({ id: 'c' });
    return v;
  });
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')).sessions.map((s) => s.id),
    ['a', 'b', 'c']
  );
});

test('SKIP_WRITE leaves the file byte-for-byte as found and releases the lock', () => {
  const store = tempStore();
  const file = path.join(store, 'index.json');
  const original = 'garbage not json\n';
  fs.writeFileSync(file, original);
  const res = locked.updateJsonAtomic(file, () => locked.SKIP_WRITE, { read: () => null });
  assert.equal(res.written, false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('_log-event refuses a corrupt index but still appends the event first', () => {
  const store = tempStore();
  fs.writeFileSync(path.join(store, 'index.json'), 'garbage not json\n');
  const r = runLogEvent(store, ['s1', 'note', 'a', 'b', 'hello', '--status', 'running']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to write/i);
  assert.equal(fs.readFileSync(path.join(store, 'index.json'), 'utf8'), 'garbage not json\n');
  // events.jsonl was written FIRST and unconditionally...
  assert.ok(fs.statSync(path.join(store, 's1', 'events.jsonl')).size > 0);
  // ...and state.json still tracked the status, since the refusal is reported last.
  assert.equal(JSON.parse(fs.readFileSync(path.join(store, 's1', 'state.json'), 'utf8')).status, 'running');
  assert.equal(fs.existsSync(path.join(store, 'index.json.lock')), false);
});

test('_log-event will not write index.json when the lock is held, but still appends the event', () => {
  const store = tempStore();
  const indexFile = path.join(store, 'index.json');
  const before = JSON.stringify({ active_session_id: null, sessions: [] }) + '\n';
  fs.writeFileSync(indexFile, before);
  // A live holder that is not stale: _log-event must time out rather than
  // write without the lock.
  const lock = locked.acquireLock(`${indexFile}.lock`, { timeoutMs: 1000 });
  let r;
  try {
    r = runLogEvent(store, ['s1', 'note', 'a', 'b', 'hello', '--status', 'running']);
  } finally {
    lock.release();
  }
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not write index\.json/);
  assert.match(r.stderr, /could not acquire lock/);
  assert.match(r.stderr, new RegExp(`pid ${process.pid}\\b`));
  assert.equal(fs.readFileSync(indexFile, 'utf8'), before, 'index.json was written without the lock');
  assert.ok(fs.statSync(path.join(store, 's1', 'events.jsonl')).size > 0, 'event was lost');
});

test('_status.mjs never creates a lock file (it is strictly read only)', () => {
  const store = tempStore();
  assert.equal(runLogEvent(store, ['s1', 'note', 'a', 'b', 'hello', '--status', 'running']).status, 0);
  const statusScript = path.join(repoRoot, 'scripts', '_status.mjs');
  const r = spawnSync(process.execPath, [statusScript, 's1'], {
    encoding: 'utf8',
    env: { ...process.env, LIBERTA_RUNS_DIR: store },
  });
  assert.equal(r.status, 0, r.stderr);
  const strays = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name.includes('.lock') || e.name.includes('.tmp-')) strays.push(path.join(dir, e.name));
    }
  };
  walk(store);
  assert.deepEqual(strays, [], 'reading status created lock/tmp files');
});
