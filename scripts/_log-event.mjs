#!/usr/bin/env node
// Append one JSON line to a Liberta session's events.jsonl.
// Usage: _log-event.mjs <session-id> <type> <from> <to> "<summary>"
//        [--task <id>] [--wave <n>] [--status <run-status>]
// If --status is given, also updates status in index.json and state.json
// for this session. Exits 0 on success, 1 with a stderr message on failure.

import fs from "fs";
import path from "path";
import os from "os";

function fail(msg) {
  process.stderr.write(`_log-event: ${msg}\n`);
  process.exit(1);
}

function runsRoot() {
  return path.join(os.homedir(), ".claude", "liberta-runs");
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

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
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

  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n");
  } catch (err) {
    fail(`could not write events.jsonl: ${err.message}`);
  }

  if (opts.status !== undefined) {
    // Update index.json's entry for this session.
    const indexPath = path.join(runsRoot(), "index.json");
    const index = readJson(indexPath, { active_session_id: null, sessions: [] });
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

    // Update state.json's status field.
    const statePath = path.join(sessionDir, "state.json");
    const state = readJson(statePath, {
      iteration: 0,
      tokens_spent: 0,
      wall_deadline: null,
      status: opts.status,
      stuck_counter: 0,
      notes: [],
    });
    state.status = opts.status;
    try {
      writeJsonAtomic(statePath, state);
    } catch (err) {
      fail(`could not write state.json: ${err.message}`);
    }
  }

  process.exit(0);
}

main();
