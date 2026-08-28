#!/usr/bin/env node
"use strict";

// backfill-parents.mjs -- idempotent, re-runnable backfill of the
// `parent_session_id` lineage field onto sessions that predate it.
//
// The field lives in two places that must agree: each session's
// state.json (authoritative) and that session's entry in the shared
// ~/.claude/liberta-runs/index.json (convenience copy). A MISSING field
// always reads as null (a root node), never as an error -- which is what
// makes the safety rules below harmless: a session this tool refuses to
// touch still resolves correctly as a root.
//
// SAFETY, NON-NEGOTIABLE:
//   A live run's session directory is owned by its controller and
//   NOTHING BUT THAT CONTROLLER MAY WRITE ANYTHING INSIDE IT. The set of
//   protected sessions is derived AT RUNTIME, never from a constant in
//   this file (a baked-in id is stale on every machine but one, and
//   silently protects nothing). A session is protected when either:
//     * it is index.json's `active_session_id`, or
//     * its state.json (or its index.json entry) has status "running".
//   Protected sessions are skipped entirely: neither their state.json
//   nor their index.json entry is modified.
//
//   Containment is checked on REAL paths (fs.realpathSync.native), not
//   lexically, so a symlink whose name differs from a protected session
//   but whose target is that session's directory cannot slip past. Any
//   index entry or directory entry that is itself a symlink is skipped
//   outright.
//
// Every write: read the JSON, add ONLY the missing key, preserve every
// other key and value untouched (never rewrite status/iteration/
// tokens_spent/notes/...), and write via temp-file + rename, the same
// atomic pattern scripts/_log-event.mjs uses. No path outside
// ~/.claude/liberta-runs/ is ever written.
//
// SAFETY (index.json is SHARED, so NEVER persist a stale snapshot):
//   index.json is the registry for EVERY run and is written concurrently
//   by scripts/_log-event.mjs (`--status done` and friends). This tool
//   reads it once up front, then walks every session on disk -- an
//   unbounded amount of wall-clock time -- so the snapshot in memory is
//   routinely out of date by the time we would write. Writing that whole
//   snapshot back would silently REVERT every status a controller wrote
//   in the meantime, including a protected session's: the per-session
//   guards below do not cover this, because index.json sits OUTSIDE every
//   session directory.
//   So the snapshot is used only to DECIDE what to change. The index is
//   re-read IMMEDIATELY before writing and only this tool's own deltas
//   (parent_session_id on named entries) are merged onto that fresh copy.
//   If the fresh copy's shape changed, or it no longer parses, we abort
//   without writing. If the file changes again between the merge and the
//   rename, the merge is redone against the newer bytes.
//
// Lineage is supplied by the CALLER, never hardcoded here:
//   --parent <child-id>=<parent-id>   (repeatable; parent may be "null")
//   --parents-file <path>             JSON: {"child":"parent", ...}
//                                     or   {"parents":{...}}
// Anything not named backfills to null (a root).
//
// Usage:
//   node console/scripts/backfill-parents.mjs                    # apply
//   node console/scripts/backfill-parents.mjs --dry-run          # report
//   node console/scripts/backfill-parents.mjs --parent a=b
//   node console/scripts/backfill-parents.mjs --parents-file p.json

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const RUNS_DIR = realResolve(path.join(os.homedir(), ".claude", "liberta-runs"));
const INDEX_PATH = path.join(RUNS_DIR, "index.json");

// ---------------------------------------------------------------------
// path resolution
// ---------------------------------------------------------------------

// Resolve a path to its REAL location. realpath throws on a path that
// does not exist yet (e.g. a state.json we are about to create, or the
// temp file used by the atomic write), so fall back to realpath-ing the
// deepest ancestor that DOES exist and re-joining the remaining
// segments. That still defeats a symlinked ancestor, which is the whole
// point.
function realResolve(inputPath) {
  const resolved = path.resolve(inputPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(realResolve(parent), path.basename(resolved));
  }
}

function isContained(child, parentDir) {
  return child === parentDir || child.startsWith(parentDir + path.sep);
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// the two-layer guard (unchanged in structure, now real-path based)
// ---------------------------------------------------------------------

function assertInsideRunsDir(filePath) {
  const resolved = realResolve(filePath);
  if (!isContained(resolved, RUNS_DIR)) {
    throw new Error(`refusing to write outside liberta-runs/: ${resolved}`);
  }
  return resolved;
}

function assertNotLiveStore(filePath, protectedIds) {
  const resolved = realResolve(filePath);
  for (const id of protectedIds) {
    const liveDir = realResolve(path.join(RUNS_DIR, id));
    if (isContained(resolved, liveDir)) {
      throw new Error(
        `refusing to write inside the live controller-owned store ` +
          `"${id}": ${resolved}`
      );
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------
// io helpers
// ---------------------------------------------------------------------

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Same atomic pattern as scripts/_log-event.mjs: write a sibling temp
// file then rename over the target. Both the target AND the temp file go
// through both guards.
function writeJsonAtomic(filePath, obj, protectedIds) {
  // Materialise: the guard is called twice below and an iterator would be
  // exhausted by the first call.
  const ids = [...protectedIds];
  assertInsideRunsDir(filePath);
  assertNotLiveStore(filePath, ids);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  assertInsideRunsDir(tmp);
  assertNotLiveStore(tmp, ids);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

// Same atomic temp+rename and the same two guards, but the rename is only
// performed while the target still holds exactly the bytes the caller
// merged onto (`expectedRaw`). If another process rewrote the file in the
// meantime, the temp file is discarded and `false` is returned so the
// caller can redo the merge against the newer bytes. This shrinks the
// read->write window to the gap between one read and one rename.
function writeAtomicIfUnchanged(filePath, body, expectedRaw, protectedIds) {
  const ids = [...protectedIds];
  assertInsideRunsDir(filePath);
  assertNotLiveStore(filePath, ids);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  assertInsideRunsDir(tmp);
  assertNotLiveStore(tmp, ids);
  fs.writeFileSync(tmp, body);
  let current;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch {
    current = null;
  }
  if (current !== expectedRaw) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
  fs.renameSync(tmp, filePath);
  return true;
}

function log(line) {
  process.stdout.write(line + "\n");
}

// ---------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------

const USAGE = [
  "usage: backfill-parents.mjs [--dry-run]",
  "                           [--parent <child-id>=<parent-id>]...",
  "                           [--parents-file <path>]",
  "",
  "Lineage is supplied by the caller. Ids not named backfill to null.",
  'A parent of "null" (or an empty value) means "root".',
].join("\n");

function parseParentsObject(obj, source) {
  const raw =
    obj && typeof obj === "object" && !Array.isArray(obj) && obj.parents
      ? obj.parents
      : obj;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: expected a JSON object of child->parent`);
  }
  const out = {};
  for (const [child, parent] of Object.entries(raw)) {
    if (parent !== null && typeof parent !== "string") {
      throw new Error(
        `${source}: parent of "${child}" must be a string or null`
      );
    }
    out[child] = parent === "" ? null : parent;
  }
  return out;
}

function parseArgs(argv) {
  const opts = { dryRun: false, parents: {}, help: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--dry-run") {
      opts.dryRun = true;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
      i += 1;
    } else if (a === "--parent") {
      const val = argv[i + 1];
      if (val === undefined) throw new Error("missing value for --parent");
      const eq = val.indexOf("=");
      if (eq <= 0) {
        throw new Error(`--parent expects <child-id>=<parent-id>, got "${val}"`);
      }
      const child = val.slice(0, eq);
      const parent = val.slice(eq + 1);
      opts.parents[child] = parent === "" || parent === "null" ? null : parent;
      i += 2;
    } else if (a === "--parents-file") {
      const val = argv[i + 1];
      if (val === undefined) throw new Error("missing value for --parents-file");
      const parsed = readJsonSafe(path.resolve(val));
      if (parsed === null) {
        throw new Error(`--parents-file: unreadable or invalid JSON: ${val}`);
      }
      Object.assign(opts.parents, parseParentsObject(parsed, "--parents-file"));
      i += 2;
    } else {
      throw new Error(`unknown argument "${a}"`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------
// runtime protection set
// ---------------------------------------------------------------------

function statusOf(sessionId, indexEntry) {
  const state = readJsonSafe(path.join(RUNS_DIR, sessionId, "state.json"));
  const fromState =
    state && typeof state === "object" && !Array.isArray(state)
      ? state.status
      : undefined;
  if (typeof fromState === "string") return fromState;
  if (indexEntry && typeof indexEntry.status === "string") {
    return indexEntry.status;
  }
  return undefined;
}

// A session is protected when it is the store's active session or when
// anything says it is currently running. Derived fresh on every run, so
// this is correct on a machine that has never heard of any particular
// run.
function computeProtected(index, ids, indexSessions) {
  const protectedIds = new Map();
  const active =
    index && typeof index.active_session_id === "string"
      ? index.active_session_id
      : null;
  if (active) protectedIds.set(active, "index.json active_session_id");
  for (const sessionId of ids) {
    const entry = indexSessions.find((s) => s && s.id === sessionId);
    if (statusOf(sessionId, entry) === "running" && !protectedIds.has(sessionId)) {
      protectedIds.set(sessionId, 'status "running"');
    }
  }
  return protectedIds;
}

// ---------------------------------------------------------------------
// index.json: merge deltas onto a FRESH read, never persist the snapshot
// ---------------------------------------------------------------------

const INDEX_COMMIT_ATTEMPTS = 5;

// A refusal to write index.json. Distinct from a bug so main() can report
// it as a clean abort: nothing was written to the registry.
class IndexAbort extends Error {}

// Read index.json for the commit step. Unlike readJsonSafe this NEVER
// launders a failed read into an empty index: at commit time we already
// know the file parsed once, so anything unreadable/unparseable/wrong
// shaped now is a reason to abort, never to overwrite.
function readIndexForCommit() {
  let raw;
  try {
    raw = fs.readFileSync(INDEX_PATH, "utf8");
  } catch (err) {
    throw new IndexAbort(
      `${INDEX_PATH} became unreadable between read and write ` +
        `(${(err && err.code) || err}); nothing written`
    );
  }
  if (!raw.trim()) {
    throw new IndexAbort(
      `${INDEX_PATH} is empty (truncated mid-write?); nothing written`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new IndexAbort(
      `${INDEX_PATH} is no longer valid JSON (${err.message}); nothing written`
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.sessions)
  ) {
    throw new IndexAbort(
      `${INDEX_PATH} no longer has the expected shape ` +
        `({ active_session_id, sessions: [] }); nothing written`
    );
  }
  return { raw, index: parsed };
}

// A concurrent status write changes VALUES inside sessions[] -- that is
// expected and is exactly what the merge preserves. A change to the
// index's own top-level key set is something else entirely (a different
// writer, a different format), so refuse rather than merge blind.
function assertShapeUnchanged(snapshot, fresh) {
  const before = Object.keys(snapshot).sort().join(",");
  const after = Object.keys(fresh).sort().join(",");
  if (before !== after) {
    throw new IndexAbort(
      `${INDEX_PATH} changed shape between read and write ` +
        `(top-level keys "${before}" -> "${after}"); nothing written`
    );
  }
}

// Apply `deltas` ([{ sessionId, parent }]) to a FRESHLY read index and
// write it. Every other key, value and the array ordering of that fresh
// copy are preserved exactly, so concurrent status writes survive.
// Protection is RE-DERIVED from the fresh copy: a session that became the
// active session, or started running, since the snapshot is skipped.
function commitIndexDeltas(snapshot, deltas, protectedIds) {
  for (let attempt = 1; attempt <= INDEX_COMMIT_ATTEMPTS; attempt += 1) {
    const { raw, index: fresh } = readIndexForCommit();
    assertShapeUnchanged(snapshot, fresh);

    const freshActive =
      typeof fresh.active_session_id === "string" ? fresh.active_session_id : null;
    const applied = [];
    const skipped = [];
    for (const { sessionId, parent } of deltas) {
      const entry = fresh.sessions.find((s) => s && s.id === sessionId);
      if (!entry) {
        skipped.push(`${sessionId} (entry no longer in index)`);
        continue;
      }
      if (sessionId === freshActive || statusOf(sessionId, entry) === "running") {
        skipped.push(`${sessionId} (became protected since the read)`);
        continue;
      }
      const has = Object.prototype.hasOwnProperty.call(entry, "parent_session_id");
      const current = has ? entry.parent_session_id : undefined;
      if (has && current !== null && current !== undefined) {
        skipped.push(`${sessionId} (another writer already set it)`);
        continue;
      }
      if (has && parent === null) {
        skipped.push(`${sessionId} (already null)`);
        continue;
      }
      entry.parent_session_id = parent;
      applied.push(sessionId);
    }
    if (!applied.length) return { wrote: false, applied, skipped };

    const body = JSON.stringify(fresh, null, 2) + "\n";
    if (writeAtomicIfUnchanged(INDEX_PATH, body, raw, protectedIds)) {
      return { wrote: true, applied, skipped };
    }
    // Lost the race between merge and rename -- redo it against the newer
    // bytes rather than overwrite them.
  }
  throw new IndexAbort(
    `gave up after ${INDEX_COMMIT_ATTEMPTS} attempts: ${INDEX_PATH} keeps ` +
      `changing underneath us; nothing written`
  );
}

// ---------------------------------------------------------------------

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  const DRY_RUN = opts.dryRun;
  const parents = opts.parents;

  const desiredParentFor = (sessionId) =>
    Object.prototype.hasOwnProperty.call(parents, sessionId)
      ? parents[sessionId]
      : null;

  if (!fs.existsSync(RUNS_DIR)) {
    log(`no run store at ${RUNS_DIR} -- nothing to do`);
    return 0;
  }

  const index = readJsonSafe(INDEX_PATH);
  const indexSessions =
    index && Array.isArray(index.sessions) ? index.sessions : [];

  // Union of ids seen in index.json and on disk, so a session that exists
  // only in one place still gets considered.
  const ids = new Set();
  for (const s of indexSessions) {
    if (s && typeof s.id === "string") ids.add(s.id);
  }
  for (const entry of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) ids.add(entry.name);
  }

  const protectedIds = computeProtected(index, ids, indexSessions);
  const protectedList = [...protectedIds.keys()];
  log(
    protectedList.length
      ? `protected (never written): ${protectedList
          .map((id) => `${id} [${protectedIds.get(id)}]`)
          .join(", ")}`
      : "protected (never written): none"
  );

  // Deltas for index.json, applied at the very end onto a FRESH read of
  // the file rather than onto this stale snapshot.
  const indexDeltas = [];
  let writes = 0;
  let noops = 0;
  let skipped = 0;

  for (const sessionId of [...ids].sort()) {
    const parent = desiredParentFor(sessionId);
    const entry = indexSessions.find((s) => s && s.id === sessionId);
    const sessionDir = path.join(RUNS_DIR, sessionId);

    // Layer 0: never follow an aliased directory at all. A symlink whose
    // real target is a protected store would otherwise be considered on
    // its own name.
    if (isSymlink(sessionDir)) {
      skipped += 1;
      log(`${sessionId}: skipped: session directory is a symlink (alias)`);
      continue;
    }

    // Layer 1a: whatever the entry CALLS itself, if its real path lands
    // inside a protected store (a "./"-prefixed dot-path, "..", an alias
    // of any kind), refuse it. This is the graceful form of the same rule
    // writeJsonAtomic enforces as a hard backstop.
    const realSessionDir = realResolve(sessionDir);
    const containing = protectedList.find((id) =>
      isContained(realSessionDir, realResolve(path.join(RUNS_DIR, id)))
    );
    if (containing !== undefined && containing !== sessionId) {
      skipped += 1;
      log(
        `${sessionId}: refused: real path resolves inside protected store ` +
          `"${containing}" (${realSessionDir})`
      );
      continue;
    }

    // Layer 1b: runtime-derived protection. Skip the session ENTIRELY --
    // state.json and its index entry both. A missing field reads as null,
    // so the session still resolves as a root node.
    if (protectedIds.has(sessionId)) {
      skipped += 1;
      log(
        `${sessionId}: skipped: live controller-owned store ` +
          `(${protectedIds.get(sessionId)}; nothing written; ` +
          `missing field reads as null => root)`
      );
      continue;
    }

    // --- state.json (authoritative) ---
    const statePath = path.join(sessionDir, "state.json");
    const state = readJsonSafe(statePath);
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      skipped += 1;
      log(`${sessionId}: skipped: no readable state.json`);
    } else if (
      Object.prototype.hasOwnProperty.call(state, "parent_session_id") &&
      state.parent_session_id !== null &&
      state.parent_session_id !== undefined
    ) {
      noops += 1;
      log(
        `${sessionId}: no-op (state.json already parent_session_id=` +
          `${JSON.stringify(state.parent_session_id)})`
      );
    } else if (
      Object.prototype.hasOwnProperty.call(state, "parent_session_id") &&
      parent === null
    ) {
      noops += 1;
      log(`${sessionId}: no-op (state.json already parent_session_id=null)`);
    } else {
      // Add ONLY the missing key; every other key/value is preserved
      // exactly as parsed.
      state.parent_session_id = parent;
      if (DRY_RUN) {
        log(
          `${sessionId}: [dry-run] would set state.json parent_session_id=` +
            `${JSON.stringify(parent)}`
        );
      } else {
        writeJsonAtomic(statePath, state, protectedList);
        writes += 1;
        log(
          `${sessionId}: set state.json parent_session_id=` +
            `${JSON.stringify(parent)}`
        );
      }
    }

    // --- index.json entry (convenience copy; lives OUTSIDE session dirs) ---
    if (!entry) continue;
    const has = Object.prototype.hasOwnProperty.call(entry, "parent_session_id");
    const current = has ? entry.parent_session_id : undefined;
    if (has && current !== null && current !== undefined) {
      noops += 1;
      log(
        `${sessionId}: no-op (index entry already parent_session_id=` +
          `${JSON.stringify(current)})`
      );
    } else if (has && parent === null) {
      noops += 1;
      log(`${sessionId}: no-op (index entry already parent_session_id=null)`);
    } else {
      indexDeltas.push({ sessionId, parent });
      log(
        `${sessionId}: index entry parent_session_id=${JSON.stringify(parent)}` +
          (DRY_RUN ? " [dry-run]" : " [queued]")
      );
    }
  }

  if (indexDeltas.length && !DRY_RUN) {
    // NEVER write the `index` snapshot read at the top of this function:
    // it is minutes stale and would revert every status a controller wrote
    // in the meantime. Re-read now and merge only the deltas above onto
    // that fresh copy. index.json lives outside every session directory,
    // so writing it is permitted even when some sessions are protected --
    // and no protected session's entry is ever part of a delta.
    const result = commitIndexDeltas(index, indexDeltas, protectedList);
    for (const note of result.skipped) {
      log(`index entry skipped at commit: ${note}`);
    }
    if (result.wrote) {
      writes += 1;
      log(
        `wrote ${INDEX_PATH} (merged ${result.applied.length} ` +
          `parent_session_id delta(s) onto a fresh read)`
      );
    } else {
      log(`${INDEX_PATH} already up to date -- nothing written`);
    }
  }

  log(
    DRY_RUN
      ? "dry-run complete (no files written)"
      : `backfill complete: ${writes} file write(s), ${noops} no-op(s), ` +
          `${skipped} skipped`
  );
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  if (err instanceof IndexAbort) {
    process.stderr.write(`ABORTED: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`FATAL: ${(err && err.message) || err}\n`);
  process.exit(1);
}
