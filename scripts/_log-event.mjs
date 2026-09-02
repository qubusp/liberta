#!/usr/bin/env node
// Append one JSON line to a Liberta session's events.jsonl.
// Usage: _log-event.mjs <session-id> <type> <from> <to> "<summary>"
//        [--task <id>] [--wave <n>] [--status <run-status>]
// If --status is given, also updates status in index.json and state.json
// for this session. Exits 0 on success, 1 with a stderr message on failure.
//
// SAFETY (index.json): ~/.claude/liberta-runs/index.json is the registry
// for EVERY run, and console/sync.js is index-driven -- a session missing
// from it drops off the dashboard entirely. This script is called on every
// state transition, so it is the single most likely thing to overwrite that
// file. An index that is PRESENT but unreadable/blank/unparseable/wrong
// shape is therefore NEVER written over: we refuse, leave the file exactly
// as found, and exit non-zero telling the operator to fix or restore it.
// Only a genuinely ABSENT index (ENOENT) is treated as empty. A zero-byte
// index is CORRUPT, not absent -- that is precisely the mid-write
// truncation signature. This matches console/scripts/fixture-sessions.mjs.
//
// ORDERING: the SKILL's contract is that a logging failure must not block
// the loop, so a bad index must not also lose the event. events.jsonl is
// append-only and completely independent of index.json, so it is written
// FIRST, before index.json is even read. state.json is likewise a
// per-session file that does not depend on the global registry, so it is
// still updated. The index refusal is reported LAST, after everything that
// could be safely persisted has been.

import fs from "fs";
import path from "path";
import { runsRoot } from "./_store.mjs";

function fail(msg) {
  process.stderr.write(`_log-event: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--task" || a === "--wave" || a === "--status") {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined) fail(`missing value for ${a}`);
      opts[key] = val;
      i += 2;
    } else {
      positional.push(a);
      i += 1;
    }
  }
  return { positional, opts };
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    return fallback;
  }
}

// Read index.json, distinguishing the two cases that used to be conflated
// by readJson():
//
//   ABSENT (ENOENT)          -> nothing to lose; an empty index is the
//                               correct starting point and is safe to write.
//   PRESENT BUT UNTRUSTWORTHY -> unreadable (EACCES/EISDIR/EIO/...), blank,
//                               not JSON, or not the expected shape. A
//                               failed read must never be laundered into an
//                               empty index that is then persisted over the
//                               real registry.
//
// Returns { ok: true, index } or { ok: false, reason }. It never throws for
// the untrustworthy case, so the caller can finish the writes that ARE safe
// before reporting the refusal.
function readIndexForUpdate(indexPath) {
  let raw;
  try {
    raw = fs.readFileSync(indexPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, index: { active_session_id: null, sessions: [] } };
    }
    return {
      ok: false,
      reason: `could not read it (${err && err.code ? err.code : err})`,
    };
  }
  // An existing-but-empty file is the classic mid-write truncation, not an
  // absent index. Refuse rather than assume the registry was empty.
  if (!raw.trim()) {
    return { ok: false, reason: "the file exists but is empty (truncated mid-write?)" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `it is not valid JSON (${err.message})` };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.sessions)
  ) {
    return {
      ok: false,
      reason: "it does not have the expected shape ({ active_session_id, sessions: [] })",
    };
  }
  return { ok: true, index: parsed };
}

function corruptIndexMessage(indexPath, reason) {
  return (
    `refusing to write ${indexPath}: ${reason}.\n` +
    "  This file is the LIVE session registry for every Liberta run.\n" +
    "  Writing over it would silently unregister every other session.\n" +
    "  The event was still appended to events.jsonl; nothing was truncated.\n" +
    "  Fix or restore index.json by hand, then re-run this command."
  );
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const { positional, opts } = parseArgs(argv);

  if (positional.length < 5) {
    fail(
      "usage: <session-id> <type> <from> <to> \"<summary>\" [--task <id>] [--wave <n>] [--status <run-status>]"
    );
  }

  const [sessionId, type, from, to, summary] = positional;
  if (!sessionId) fail("session-id is required");
  if (!type) fail("type is required");

  const sessionDir = path.join(runsRoot(), sessionId);
  const eventsPath = path.join(sessionDir, "events.jsonl");

  const event = {
    ts: new Date().toISOString(),
    type,
    from,
    to,
    summary,
  };
  if (opts.task !== undefined) event.task = opts.task;
  if (opts.wave !== undefined) event.wave = opts.wave;
  if (opts.status !== undefined) event.status = opts.status;

  // FIRST, and unconditionally: events.jsonl is append-only and independent
  // of index.json, so the event can never be lost to an index problem.
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n");
  } catch (err) {
    fail(`could not write events.jsonl: ${err.message}`);
  }

  if (opts.status !== undefined) {
    // Update index.json's entry for this session.
    const indexPath = path.join(runsRoot(), "index.json");
    const read = readIndexForUpdate(indexPath);

    if (read.ok) {
      const index = read.index;
      if (!Array.isArray(index.sessions)) index.sessions = [];
      let entry = index.sessions.find((s) => s && s.id === sessionId);
      if (!entry) {
        // parent_session_id is part of the index entry shape (see
        // skills/liberta/SKILL.md). A fallback entry for an unknown session
        // has no lineage information available, so it starts as null (a
        // root); whatever creates the session properly is responsible for
        // setting the real value.
        entry = {
          id: sessionId,
          project_path: null,
          status: opts.status,
          parent_session_id: null,
        };
        index.sessions.push(entry);
      } else {
        // Only status is ours to update here. Never clobber an existing
        // parent_session_id (or any other field) -- lineage is written at
        // session creation / by the backfill tool, not by event logging.
        entry.status = opts.status;
      }
      try {
        writeJsonAtomic(indexPath, index);
      } catch (err) {
        fail(`could not write index.json: ${err.message}`);
      }
    }

    // Update state.json's status field. state.json is a per-session file
    // that does not depend on the global registry, so it is updated even
    // when the index was refused -- a registry-wide problem should not also
    // stop this session tracking its own status.
    const statePath = path.join(sessionDir, "state.json");
    const state = readJson(statePath, {
      iteration: 0,
      tokens_spent: 0,
      wall_deadline: null,
      status: opts.status,
      stuck_counter: 0,
      notes: [],
      // Same shape as the index fallback entry above: lineage that is not
      // known here reads as null (a root), and is never invented.
      parent_session_id: null,
    });
    state.status = opts.status;
    try {
      writeJsonAtomic(statePath, state);
    } catch (err) {
      fail(`could not write state.json: ${err.message}`);
    }

    // Reported last: everything safely persistable has now been persisted,
    // and index.json is byte-for-byte as we found it.
    if (!read.ok) fail(corruptIndexMessage(indexPath, read.reason));
  }

  process.exit(0);
}

main();
