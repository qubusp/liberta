#!/usr/bin/env node
"use strict";

// backfill-parents.mjs -- one-off, idempotent, re-runnable backfill of the
// `parent_session_id` lineage field onto sessions that predate it.
//
// The field lives in two places that must agree: each session's
// state.json (authoritative) and that session's entry in the shared
// ~/.claude/liberta-runs/index.json (convenience copy). A MISSING field
// always reads as null (a root node), never as an error -- which is what
// makes the safety rule below harmless.
//
// SAFETY, NON-NEGOTIABLE:
//   ~/.claude/liberta-runs/<LIVE_CONTROLLER_SESSION_ID>/ is the live run's
//   own store and NOTHING BUT THE CONTROLLER MAY WRITE ANYTHING INSIDE IT.
//   This tool hard-skips that id by name and never writes state.json,
//   plan.json, events.jsonl or anything else under it. That session's
//   entry in the shared index.json (which lives OUTSIDE the session
//   directory) may still be updated -- but only additively and atomically.
//   Since a missing field reads as null, the skipped session still
//   resolves correctly as a root node.
//
// Every write: read the JSON, add ONLY the missing key, preserve every
// other key and value untouched (never rewrite status/iteration/
// tokens_spent/notes/...), and write via temp-file + rename, the same
// atomic pattern scripts/_log-event.mjs uses. No path outside
// ~/.claude/liberta-runs/ is ever written.
//
// Usage:
//   node console/scripts/backfill-parents.mjs          # apply
//   node console/scripts/backfill-parents.mjs --dry-run # report only

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const RUNS_DIR = path.resolve(path.join(os.homedir(), ".claude", "liberta-runs"));
const INDEX_PATH = path.join(RUNS_DIR, "index.json");

// Never write inside this session's directory. It is the live run's store.
const LIVE_CONTROLLER_SESSION_ID = "liberta-chat-pixelart-2026-08-28";

// Known lineage. Anything not listed here backfills to null (a root).
const KNOWN_PARENTS = {
  "liberta-chat-pixelart-fork-2026-08-28": "liberta-chat-pixelart-2026-08-28",
};

const DRY_RUN = process.argv.includes("--dry-run");

function assertInsideRunsDir(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved !== RUNS_DIR && !resolved.startsWith(RUNS_DIR + path.sep)) {
    throw new Error(`refusing to write outside liberta-runs/: ${resolved}`);
  }
  return resolved;
}

function assertNotLiveStore(filePath) {
  const resolved = path.resolve(filePath);
  const liveDir = path.join(RUNS_DIR, LIVE_CONTROLLER_SESSION_ID);
  if (resolved === liveDir || resolved.startsWith(liveDir + path.sep)) {
    throw new Error(
      `refusing to write inside the live controller-owned store: ${resolved}`
    );
  }
  return resolved;
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// Same atomic pattern as scripts/_log-event.mjs: write a sibling temp file
// then rename over the target.
function writeJsonAtomic(filePath, obj) {
  assertInsideRunsDir(filePath);
  assertNotLiveStore(filePath);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

function desiredParentFor(sessionId) {
  return Object.prototype.hasOwnProperty.call(KNOWN_PARENTS, sessionId)
    ? KNOWN_PARENTS[sessionId]
    : null;
}

function log(line) {
  process.stdout.write(line + "\n");
}

function main() {
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

  let indexChanged = false;
  let writes = 0;
  let noops = 0;

  for (const sessionId of [...ids].sort()) {
    const parent = desiredParentFor(sessionId);
    const entry = indexSessions.find((s) => s && s.id === sessionId);

    // --- state.json (authoritative) ---
    if (sessionId === LIVE_CONTROLLER_SESSION_ID) {
      log(
        `${sessionId}: skipped: live controller-owned store ` +
          `(state.json not written; missing field reads as null => root)`
      );
    } else {
      const statePath = path.join(RUNS_DIR, sessionId, "state.json");
      const state = readJsonSafe(statePath);
      if (state === null || typeof state !== "object" || Array.isArray(state)) {
        log(`${sessionId}: no readable state.json -- skipped`);
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
          writeJsonAtomic(statePath, state);
          writes += 1;
          log(
            `${sessionId}: set state.json parent_session_id=` +
              `${JSON.stringify(parent)}`
          );
        }
      }
    }

    // --- index.json entry (convenience copy; lives OUTSIDE session dirs,
    // so it is permitted even for the live controller-owned session) ---
    if (!entry) continue;
    const has = Object.prototype.hasOwnProperty.call(entry, "parent_session_id");
    const current = has ? entry.parent_session_id : undefined;
    if (has && current !== null && current !== undefined) {
      log(`${sessionId}: no-op (index entry already parent_session_id=${JSON.stringify(current)})`);
    } else if (has && parent === null) {
      log(`${sessionId}: no-op (index entry already parent_session_id=null)`);
    } else {
      entry.parent_session_id = parent;
      indexChanged = true;
      log(
        `${sessionId}: set index entry parent_session_id=${JSON.stringify(parent)}` +
          (DRY_RUN ? " [dry-run]" : "")
      );
    }
  }

  if (indexChanged && !DRY_RUN) {
    // Adds only the missing key on the entries above; every other key,
    // value and the array ordering are preserved exactly.
    writeJsonAtomic(INDEX_PATH, index);
    writes += 1;
    log(`wrote ${INDEX_PATH}`);
  }

  log(
    DRY_RUN
      ? "dry-run complete (no files written)"
      : `backfill complete: ${writes} file write(s), ${noops} no-op(s)`
  );
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`FATAL: ${(err && err.message) || err}\n`);
  process.exit(1);
}
