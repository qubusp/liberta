"use strict";

// ---------------------------------------------------------------------
// Background sync loop: mirrors the file-based Liberta run store
// (~/.claude/liberta-runs/) into the DB (db.js's knex instance) so the
// console can serve requests from a fast queryable cache instead of
// hitting the filesystem on every request. The file store remains the
// source of truth -- this module only ever reads those files, never
// writes them.
// ---------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const os = require("os");

const { knex } = require("./db");

const LIBERTA_RUNS_DIR = path.join(os.homedir(), ".claude", "liberta-runs");

// run_id -> last byte offset already ingested from that run's
// events.jsonl. In-memory only -- a process restart just re-scans from
// offset 0 for every run, which is safe since event ingestion below is
// idempotent-by-line-content-hash-free (we simply never re-read bytes
// we've already consumed, and a full rescan just re-inserts from
// scratch which is fine for a mirror table).
const eventOffsets = new Map();

// run ids we've already logged a "malformed, skipping" warning for, so
// repeated failures during the loop don't spam stderr every pass.
const warnedRuns = new Set();

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function warnOnce(runId, msg) {
  const key = `${runId}:${msg}`;
  if (warnedRuns.has(key)) return;
  warnedRuns.add(key);
  process.stderr.write(`[sync] ${msg}\n`);
}

// Lineage: state.json is authoritative, the index.json entry is a
// convenience copy, and a missing field on either always reads as null (a
// root node) rather than an error -- most existing sessions predate the
// field entirely.
function resolveParentSessionId(session, state) {
  if (state && state.parent_session_id) return state.parent_session_id;
  if (session && session.parent_session_id) return session.parent_session_id;
  return null;
}

async function upsertRun(session, liveStatus, state) {
  const row = {
    id: session.id,
    project_path: session.project_path || null,
    status: liveStatus || session.status || null,
    parent_session_id: resolveParentSessionId(session, state),
    active: 0,
    updated_at: new Date(),
  };
  await knex("runs")
    .insert(row)
    .onConflict("id")
    .merge({
      project_path: row.project_path,
      status: row.status,
      parent_session_id: row.parent_session_id,
      updated_at: row.updated_at,
    });
}

async function markActiveRun(activeSessionId) {
  await knex("runs").update({ active: 0 });
  if (activeSessionId) {
    await knex("runs").where({ id: activeSessionId }).update({ active: 1 });
  }
}

async function syncTasks(runId, plan) {
  if (!plan) return;
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : Array.isArray(plan) ? plan : [];
  for (const task of tasks) {
    if (!task || (task.id === undefined && task.task_key === undefined)) continue;
    const taskKey = String(task.id !== undefined ? task.id : task.task_key);
    const row = {
      run_id: runId,
      task_key: taskKey,
      role: task.role || null,
      wave: task.wave !== undefined && task.wave !== null ? Number(task.wave) : null,
      status: task.status || null,
      passing:
        task.passing === undefined || task.passing === null
          ? null
          : task.passing
          ? 1
          : 0,
      depends_on: JSON.stringify(task.depends_on || []),
      verify: task.verify ? JSON.stringify(task.verify) : null,
      updated_at: new Date(),
    };
    await knex("tasks")
      .insert(row)
      .onConflict(["run_id", "task_key"])
      .merge({
        role: row.role,
        wave: row.wave,
        status: row.status,
        passing: row.passing,
        depends_on: row.depends_on,
        verify: row.verify,
        updated_at: row.updated_at,
      });
  }
}

// Only ingest bytes of events.jsonl we haven't seen yet for this run,
// tracked via an in-memory byte-offset map (see eventOffsets above).
async function syncEvents(runId, eventsPath) {
  let stat;
  try {
    stat = fs.statSync(eventsPath);
  } catch (err) {
    return; // no events file yet -- fine, nothing to do
  }

  let offset = eventOffsets.get(runId) || 0;
  if (stat.size < offset) {
    // File shrank/rotated underneath us -- rescan from the start rather
    // than trying to reconcile; a mirror table re-populating is cheap
    // and harmless.
    offset = 0;
  }
  if (stat.size === offset) return; // nothing new

  const fd = fs.openSync(eventsPath, "r");
  let text;
  try {
    const length = stat.size - offset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    text = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }

  // Only fully-terminated lines are safe to consider "consumed" -- an
  // in-progress append could leave a partial trailing line. Keep that
  // partial line unread (don't advance the offset past it) so the next
  // pass picks it up complete.
  let consumedThrough = offset;
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    // No complete line yet in the new bytes at all.
    eventOffsets.set(runId, offset);
    return;
  }
  const completeText = text.slice(0, lastNewline);
  consumedThrough = offset + Buffer.byteLength(completeText, "utf8") + 1; // +1 for the newline

  const lines = completeText.split("\n").filter((l) => l.length > 0);
  const rows = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      continue; // skip malformed lines rather than crash the loop
    }
    rows.push({
      run_id: runId,
      ts: parsed.ts ? new Date(parsed.ts) : new Date(),
      type: parsed.type || null,
      from_actor: parsed.from || parsed.from_actor || null,
      to_actor: parsed.to || parsed.to_actor || null,
      summary: parsed.summary || null,
      task_key:
        parsed.task !== undefined && parsed.task !== null ? String(parsed.task) : null,
      wave: parsed.wave !== undefined && parsed.wave !== null ? Number(parsed.wave) : null,
      status: parsed.status || null,
    });
  }

  if (rows.length > 0) {
    await knex("events").insert(rows);
  }
  eventOffsets.set(runId, consumedThrough);
}

async function syncOneRun(session) {
  const runId = session.id;
  const dir = path.join(LIBERTA_RUNS_DIR, runId);
  if (!fs.existsSync(dir)) {
    warnOnce(runId, `run directory missing for "${runId}", skipping this pass`);
    return;
  }

  const state = readJsonSafe(path.join(dir, "state.json"));
  const liveStatus = state && state.status ? state.status : null;

  await upsertRun(session, liveStatus, state);

  const plan = readJsonSafe(path.join(dir, "plan.json"));
  await syncTasks(runId, plan);

  const eventsPath = path.join(dir, "events.jsonl");
  await syncEvents(runId, eventsPath);
}

async function runSyncOnce() {
  const idx = readJsonSafe(path.join(LIBERTA_RUNS_DIR, "index.json"));
  if (!idx || !Array.isArray(idx.sessions)) {
    return;
  }

  for (const session of idx.sessions) {
    if (!session || !session.id) continue;
    try {
      await syncOneRun(session);
    } catch (err) {
      warnOnce(session.id, `sync failed for "${session.id}": ${err.message}`);
    }
  }

  try {
    await markActiveRun(idx.active_session_id || null);
  } catch (err) {
    process.stderr.write(`[sync] failed to update active run marker: ${err.message}\n`);
  }
}

function startSyncLoop(intervalMs = 3000) {
  // Fire once immediately so the DB isn't empty for the first
  // intervalMs after boot, then keep going on the interval.
  runSyncOnce().catch((err) => {
    process.stderr.write(`[sync] initial sync failed: ${err.message}\n`);
  });
  const handle = setInterval(() => {
    runSyncOnce().catch((err) => {
      process.stderr.write(`[sync] sync pass failed: ${err.message}\n`);
    });
  }, intervalMs);
  // Don't let the sync timer keep the process alive on its own if
  // everything else has shut down.
  if (handle.unref) handle.unref();
  return handle;
}

module.exports = { runSyncOnce, startSyncLoop };
