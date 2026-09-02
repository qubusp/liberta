// Cross-process advisory locking plus locked read-modify-write for the JSON
// files in the Liberta run store.
//
// ---------------------------------------------------------------------------
// LOCKING PROTOCOL
// ---------------------------------------------------------------------------
// WHAT THE LOCK GUARDS
//   One lock guards exactly ONE JSON file, and lives next to it as
//   "<file>.lock" (so ~/.claude/liberta-runs/index.json is guarded by
//   ~/.claude/liberta-runs/index.json.lock, and a session's state.json by
//   that session's state.json.lock). The lock exists because an atomic WRITE
//   is not enough: scripts/_log-event.mjs does a read-modify-write of the
//   whole registry, and two sessions logging a status at the same time would
//   both read the same old index and the second rename would silently drop
//   the first one's entry. The lock closes that read-modify-write window --
//   the file is re-read FRESH inside the lock, never before it.
//
// HOW THE LOCK IS TAKEN
//   fs.openSync(lockPath, "wx"): an exclusive create, which is a single
//   atomic filesystem operation, so exactly one process can win even on a
//   network filesystem that lacks flock. The winner writes its pid, an ISO
//   timestamp and a random ownership token into the file. Losers retry in a
//   bounded loop with a small randomized backoff (a few milliseconds, jittered
//   so two contenders do not resynchronise into lockstep).
//
// TIMEOUT
//   DEFAULT_TIMEOUT_MS (5000 ms) to acquire. On expiry acquireLock THROWS an
//   error naming the lock file and the pid recorded as holding it, and the
//   caller must NOT write the guarded file. Failing loudly is correct here:
//   writing without the lock is exactly the data-loss bug this module exists
//   to prevent.
//
// STALENESS
//   A lock is stale only when BOTH: (a) its recorded timestamp is older than
//   DEFAULT_STALE_MS (30000 ms), and (b) the recorded pid is no longer alive
//   (process.kill(pid, 0) reports ESRCH). Either condition alone is not
//   enough: a live holder may legitimately be slow, and a young lock from a
//   just-crashed process is still worth one more backoff. A lock file that is
//   unreadable or unparseable is treated as having an unknown holder and is
//   only taken over on age, using its mtime. Takeover unlinks the stale file
//   and re-enters the normal exclusive-create race.
//
// RELEASE
//   Guaranteed on both the success and the throw path (a finally block in
//   withLock/updateJsonAtomic). Release is ownership-checked: it re-reads the
//   lock file and only unlinks it when the token still matches ours, so a
//   process whose lock was taken over as stale can never delete the new
//   holder's lock.
//
// INVARIANT: NO LOCK IS EVER HELD ACROSS A CHILD PROCESS SPAWN.
//   The critical section is a synchronous read, an in-memory mutation and an
//   atomic write, nothing else. Never call spawn/exec/spawnSync (or await
//   anything) inside a mutate function: a child can outlive the parent's
//   expectations, can itself block on this same lock (self-deadlock until the
//   timeout), and inherits an open descriptor. Callers spawn before taking the
//   lock or after releasing it, never in between.
// ---------------------------------------------------------------------------
//
// Why CommonJS: same reason as scripts/_store.cjs. scripts/wave-exec.js is
// CommonJS while the _log-event/_mailbox/_status scripts are ESM. Node's ESM
// loader can import a CommonJS module via default interop, but a synchronous
// require() of an ESM file does not work, so the one canonical implementation
// is CommonJS and scripts/_locked-json.mjs is a thin ESM re-export shim.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
const MIN_BACKOFF_MS = 5;
const MAX_BACKOFF_MS = 25;

// Sentinel a mutate function can return to say "nothing to write": the lock
// is released and the guarded file is left byte-for-byte as it was found.
const SKIP_WRITE = Symbol("locked-json.skip-write");

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return !!(err && err.code === "EPERM");
  }
}

function sleepSync(ms) {
  if (ms <= 0) return;
  // Synchronous by design: the whole critical section is synchronous, so the
  // retry wait has to be too. Atomics.wait on a throwaway SharedArrayBuffer
  // is the only sleep that does not spin the CPU.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function backoffMs() {
  return MIN_BACKOFF_MS + Math.floor(Math.random() * (MAX_BACKOFF_MS - MIN_BACKOFF_MS + 1));
}

// Reads the current holder of lockPath. Returns null when the lock file has
// gone away; otherwise { pid, ts, token, ageMs, parsed }.
function readHolder(lockPath) {
  let raw;
  let st;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
    st = fs.statSync(lockPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    // Unreadable: unknown holder, age unknown -> treat as very old so the
    // staleness rule can still fall back to the pid check (which fails, so
    // an unreadable lock with an unknown pid is taken over on age alone).
    return { pid: null, ts: null, token: null, ageMs: Infinity, parsed: false };
  }
  let holder = null;
  try {
    holder = JSON.parse(raw);
  } catch {
    holder = null;
  }
  const mtimeAge = st ? Date.now() - st.mtimeMs : Infinity;
  if (!holder || typeof holder !== "object") {
    return { pid: null, ts: null, token: null, ageMs: mtimeAge, parsed: false };
  }
  const stamped = Date.parse(holder.ts);
  const ageMs = Number.isNaN(stamped) ? mtimeAge : Date.now() - stamped;
  return {
    pid: typeof holder.pid === "number" ? holder.pid : null,
    ts: typeof holder.ts === "string" ? holder.ts : null,
    token: typeof holder.token === "string" ? holder.token : null,
    ageMs,
    parsed: true,
  };
}

function describeHolder(holder) {
  if (!holder) return "an unknown process (the lock file vanished)";
  if (holder.pid === null) return "an unknown pid (the lock file is unreadable or malformed)";
  return `pid ${holder.pid}${holder.ts ? ` (held since ${holder.ts})` : ""}`;
}

/**
 * Take the advisory lock at lockPath, or throw after timeoutMs.
 *
 * @param {string} lockPath
 * @param {{timeoutMs?: number, staleMs?: number}} [opts]
 * @returns {{path: string, token: string, release: () => void}}
 */
function acquireLock(lockPath, opts) {
  const timeoutMs = opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const staleMs = opts && Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_STALE_MS;
  const token = crypto.randomBytes(12).toString("hex");
  const deadline = Date.now() + Math.max(0, timeoutMs);

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let lastHolder = null;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      // Someone else holds it. Consider a stale takeover, then back off.
      const holder = readHolder(lockPath);
      lastHolder = holder;
      if (holder && holder.ageMs > staleMs && !isPidAlive(holder.pid)) {
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
          if (!unlinkErr || unlinkErr.code !== "ENOENT") throw unlinkErr;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        const err2 = new Error(
          `could not acquire lock ${lockPath} within ${timeoutMs}ms; ` +
            `it is held by ${describeHolder(holder || lastHolder)}. ` +
            "Nothing was written. If that process is gone, delete the lock file by hand."
        );
        err2.code = "ELOCKTIMEOUT";
        err2.lockPath = lockPath;
        err2.holderPid = holder && holder.pid !== null ? holder.pid : null;
        throw err2;
      }
      sleepSync(backoffMs());
      continue;
    }

    try {
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token }) + "\n"
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    let released = false;
    return {
      path: lockPath,
      token,
      release() {
        if (released) return;
        released = true;
        // Ownership check: never unlink a lock that is no longer ours (it
        // could have been taken over as stale and re-taken by someone else).
        const holder = readHolder(lockPath);
        if (holder && holder.token !== null && holder.token !== token) return;
        try {
          fs.unlinkSync(lockPath);
        } catch (err) {
          if (err && err.code === "ENOENT") return;
          throw err;
        }
      },
    };
  }
}

/**
 * Run fn while holding the lock for filePath. The lock is released on both
 * the success and the throw path.
 */
function withLock(lockPath, opts, fn) {
  const lock = acquireLock(lockPath, opts);
  try {
    return fn();
  } finally {
    try {
      lock.release();
    } catch {
      // A failed release must not mask the caller's own error; the lock will
      // be reclaimed by the staleness rule.
    }
  }
}

function lockPathFor(filePath) {
  return `${filePath}.lock`;
}

// tmp + fsync + rename. The fsync is what makes the rename meaningful: it
// forces the new bytes to disk BEFORE the directory entry is flipped, so a
// crash can leave the old file or the new file, never a half-written one.
function writeFileAtomicSync(filePath, data, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    const fd = mode === undefined ? fs.openSync(tmp, "wx") : fs.openSync(tmp, "wx", mode);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

function defaultRead(filePath, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw err;
  }
  if (!raw.trim()) return fallback;
  return JSON.parse(raw);
}

/**
 * Locked read-modify-write of a JSON file.
 *
 * Takes the lock for filePath, reads the file FRESH inside the lock (this is
 * the whole point: a value read before the lock may already be stale),
 * applies mutateFn to the parsed value, writes tmp + fsync + rename, and
 * releases the lock. mutateFn may return SKIP_WRITE to leave the file
 * untouched (used by the corrupt-index refusal path in _log-event.mjs).
 *
 * mutateFn MUST be synchronous and MUST NOT spawn a child process; see the
 * protocol comment at the top of this file.
 *
 * @param {string} filePath
 * @param {(value: any) => any} mutateFn
 * @param {{timeoutMs?: number, staleMs?: number, fallback?: any,
 *          read?: (filePath: string) => any, mode?: number,
 *          lockPath?: string}} [opts]
 * @returns {{written: boolean, value: any}}
 */
function updateJsonAtomic(filePath, mutateFn, opts) {
  const options = opts || {};
  const lockPath = options.lockPath || lockPathFor(filePath);
  return withLock(lockPath, options, () => {
    const read = options.read || ((p) => defaultRead(p, options.fallback));
    const current = read(filePath);
    const next = mutateFn(current);
    if (next === SKIP_WRITE) return { written: false, value: current };
    writeFileAtomicSync(filePath, JSON.stringify(next, null, 2) + "\n", options.mode);
    return { written: true, value: next };
  });
}

module.exports = {
  acquireLock,
  withLock,
  updateJsonAtomic,
  writeFileAtomicSync,
  lockPathFor,
  SKIP_WRITE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STALE_MS,
};
