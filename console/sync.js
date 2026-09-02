"use strict";

// ---------------------------------------------------------------------
// Background sync loop: mirrors the file-based Liberta run store
// (~/.claude/liberta-runs/) into the DB (db.js's knex instance) so the
// console can serve requests from a fast queryable cache instead of
// hitting the filesystem on every request. The file store remains the
// source of truth -- this module only ever reads those files, never
// writes them.
//
// Sync is upsert + REAP: rows whose subject has disappeared from the
// source of truth (a task no longer in plan.json, a run no longer in
// index.json and with no directory on disk) are deleted, otherwise the
// mirror accumulates ghosts from superseded plans and deleted sessions
// that the dashboard then renders as real. Reaping is deliberately
// conservative: a source file we could not read or could not parse is
// NEVER treated as "empty" -- we skip the reap for that subject and log
// it, because a swallowed parse error turning into a mass delete is
// exactly how a mirror destroys data.
// ---------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const os = require("os");

const { knex } = require("./db");

// Resolve where the Liberta run store lives on disk. Delegates to the
// canonical resolver in scripts/_store.cjs (added in T8) so this module
// and console/server.js share exactly one implementation of the
// LIBERTA_RUNS_DIR override + homedir fallback, instead of duplicating it.
const { runsRoot } = require("../scripts/_store.cjs");
const LIBERTA_RUNS_DIR = runsRoot();

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
  // CONSERVATISM RULE (see reapTasks below): `plan === null` means the file
  // was missing OR failed to parse -- readJsonSafe cannot tell those apart.
  // Either way we know nothing about what this run's tasks *should* be, so we
  // must not touch existing rows. Bailing here means no upsert AND no reap.
  if (!plan) {
    warnOnce(runId, `plan.json unreadable/unparseable for "${runId}", skipping task sync and reap`);
    return;
  }

  // Only a plan we can definitively read as a list of tasks is authoritative
  // enough to reap against. An unexpected shape (e.g. `{"tasks": {...}}` or a
  // bare string) is treated as "unknown", not as "zero tasks".
  let tasks = null;
  if (Array.isArray(plan.tasks)) tasks = plan.tasks;
  else if (Array.isArray(plan)) tasks = plan;

  if (tasks === null) {
    warnOnce(runId, `plan.json for "${runId}" has no readable tasks array, skipping task sync and reap`);
    return;
  }

  const seenKeys = new Set();
  let sawMalformedEntry = false;

  for (const task of tasks) {
    if (!task || (task.id === undefined && task.task_key === undefined)) {
      // An entry we can't key means our `seenKeys` set is incomplete, so
      // reaping against it could delete a row that is actually still real.
      sawMalformedEntry = true;
      continue;
    }
    const taskKey = String(task.id !== undefined ? task.id : task.task_key);
    seenKeys.add(taskKey);
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

  if (sawMalformedEntry) {
    warnOnce(
      runId,
      `plan.json for "${runId}" contains task entries without an id, skipping task reap`
    );
    return;
  }

  await reapTasks(runId, seenKeys);
}

// Delete task rows for `runId` whose task_key is no longer present in that
// run's plan.json. Callers MUST only reach this with a `seenKeys` set derived
// from a plan.json that actually parsed -- a failed read must never look like
// an empty plan (that is precisely the class of bug that destroyed data in
// scripts/fixture-sessions.mjs), which is why every uncertain path above
// returns before getting here.
async function reapTasks(runId, seenKeys) {
  const existing = await knex("tasks").where({ run_id: runId }).select("task_key");
  const stale = existing
    .map((r) => r.task_key)
    .filter((key) => key !== null && key !== undefined && !seenKeys.has(String(key)));
  if (stale.length === 0) return;

  await knex("tasks").where({ run_id: runId }).whereIn("task_key", stale).del();
  process.stderr.write(
    `[sync] reaped ${stale.length} task row(s) absent from plan.json for "${runId}": ${stale.join(", ")}\n`
  );
}

// Delete run rows (and their mirrored tasks/events) for runs that have
// vanished from the source of truth: absent from index.json AND with no
// session directory on disk. A run that is merely unindexed but still has a
// directory is kept -- it may be mid-creation, and the file store, not
// index.json alone, is what proves existence.
//
// `indexedIds` must come from an index.json that actually parsed; runSyncOnce
// returns early otherwise, so an unreadable index can never mass-delete.
async function reapRuns(indexedIds) {
  // If the runs directory itself is unreadable we cannot prove any run is
  // gone -- e.g. an unmounted volume would otherwise wipe every row.
  if (!fs.existsSync(LIBERTA_RUNS_DIR)) {
    warnOnce("*", `runs directory missing at ${LIBERTA_RUNS_DIR}, skipping run reap`);
    return;
  }

  const rows = await knex("runs").select("id");
  const stale = [];
  for (const row of rows) {
    const id = row.id;
    if (!id || indexedIds.has(String(id))) continue;
    let onDisk;
    try {
      onDisk = fs.existsSync(path.join(LIBERTA_RUNS_DIR, String(id)));
    } catch (err) {
      // Can't tell -- assume it still exists rather than deleting.
      continue;
    }
    if (!onDisk) stale.push(id);
  }
  if (stale.length === 0) return;

  await knex("tasks").whereIn("run_id", stale).del();
  await knex("events").whereIn("run_id", stale).del();
  await knex("runs").whereIn("id", stale).del();
  for (const id of stale) eventOffsets.delete(id);
  process.stderr.write(
    `[sync] reaped ${stale.length} run row(s) absent from index.json and from disk: ${stale.join(", ")}\n`
  );
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
    // Missing or unparseable index.json: we have no idea which runs are real,
    // so do nothing at all this pass -- in particular, do NOT reap.
    warnOnce("*", "index.json unreadable/unparseable, skipping this pass (no reap)");
    return;
  }

  const indexedIds = new Set();
  for (const session of idx.sessions) {
    if (!session || !session.id) continue;
    indexedIds.add(String(session.id));
    try {
      await syncOneRun(session);
    } catch (err) {
      warnOnce(session.id, `sync failed for "${session.id}": ${err.message}`);
    }
  }

  try {
    await reapRuns(indexedIds);
  } catch (err) {
    process.stderr.write(`[sync] run reap failed: ${err.message}\n`);
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
