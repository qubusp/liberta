"use strict";

// session-graph.js -- pure, unit-testable builder for the session
// lineage graph the mindmap UI (t11/t12) renders.
//
// buildSessionGraph(input) takes PLAIN DATA (no filesystem, no DB) so it
// can be exercised with `node -e` scripts and from the route below with
// equal ease. This module must never require("fs") or touch a network/DB
// handle -- callers (the route, or a future CLI) are responsible for
// gathering `input` first.
//
//   input = {
//     sessions: [{ id, project_path, status, parent_session_id, is_active }],
//     plans:  { <id>: planJsonOrNull },   // whatever readJsonSafe(plan.json) returned
//     events: { <id>: [lastFewEventObjects] },
//   }
//
//   output = { nodes: [Node], edges: [{ from, to }] }
//
// ---------------------------------------------------------------------
// DERIVATION RULES -- this is the contract t11 renders against. Keep this
// comment in sync with the code below; it is the spec.
// ---------------------------------------------------------------------
//
// current_wave:
//   - the lowest wave number that still has a task whose status is not
//     "done";
//   - if every task in the plan is done, the HIGHEST wave present;
//   - if plan.json is missing, unparseable, or not shaped like a plan
//     (no readable tasks array), current_wave is `null` -- NOT an error.
//     A session may simply have no plan yet.
//
// in_flight_tasks:
//   - tasks belonging to current_wave whose status is "running"; if none
//     are running, tasks in current_wave whose status is "pending";
//   - capped at a handful (MAX_IN_FLIGHT below) so a huge wave doesn't
//     balloon the payload;
//   - each entry carries only { id, title, role, wave, status };
//   - an empty array is legitimate (e.g. current_wave is null, or every
//     task in the wave is already done/blocked/failed).
//
// task_counts:
//   - { total, done, pending, blocked, failed } tallied across every task
//     in the plan, regardless of wave.
//   - total is the task count; done/pending/blocked/failed are counts of
//     tasks whose `status` string matches exactly. Any other status
//     value (e.g. "running"/"in_progress") is counted in `total` but not
//     in any of the four named buckets -- there is no bucket for it in
//     the required shape, and guessing which bucket it "should" count
//     toward would misrepresent it.
//
// last_event:
//   - the final parsed line handed in via input.events[id] (the route
//     supplies the tail of events.jsonl already parsed), or `null` if
//     that array is empty/absent. Shape: { ts, type, summary }.
//
// is_fixture:
//   - true iff the session id starts with "zz-fixture-" (t1's fixture
//     harness namespace). Fixtures are flagged, never dropped -- it's
//     the caller's call whether to filter them out.
//
// is_root:
//   - true iff the session has no parent_session_id at all (null,
//     undefined, or the key absent). This is the common case: most
//     sessions predate parent_session_id entirely and must render as a
//     clean root, never as an error.
//
// GRAPH RULES (see README-style comment block near buildSessionGraph):
//   - Multiple roots are normal; never assume a single root.
//   - An edge {from: parent, to: child} is emitted only when BOTH ids
//     are nodes in this graph AND the parent is not the node itself (a
//     self-parent is nonsensical as an edge and would just render as a
//     self-loop; the node still exists and still carries its
//     parent_session_id so the UI can note the anomaly).
//   - A parent_session_id that does not resolve to a known node (a
//     pruned/archived mother, or any id absent from `sessions`) never
//     produces an edge -- the child node still appears, with is_root
//     false, and its unresolved parent_session_id remains readable on
//     the node itself so the UI can render "child of <unknown>".
//   - Cycles (a->b->a, or the degenerate a->a) must never hang or blow
//     the stack. This builder never walks a parent chain recursively --
//     every node's edge is derived from its own single parent_session_id
//     field in one O(n) pass, so a cycle is just two ordinary edges,
//     not something that needs detecting. If a future change here (or in
//     a caller) ever needs to walk a chain of parents/ancestors, it MUST
//     carry an explicit visited-id Set and bail out the moment it would
//     revisit an id, rather than recursing unbounded.

const FIXTURE_PREFIX = "zz-fixture-";
const MAX_IN_FLIGHT = 8;

function normalizeTasks(plan) {
  // Anything that isn't an object or array (a bare string, a number, a
  // boolean) is not a plan we can read tasks out of -- treat it exactly
  // like a missing/unparseable plan.json, never throw.
  if (!plan || typeof plan !== "object") return null;
  if (Array.isArray(plan.tasks)) return plan.tasks;
  if (Array.isArray(plan)) return plan;
  return null;
}

function computeCurrentWave(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const waves = tasks
    .map((t) => (t && t.wave !== undefined && t.wave !== null ? Number(t.wave) : null))
    .filter((w) => w !== null && !Number.isNaN(w));
  if (waves.length === 0) return null;

  const notDoneWaves = tasks
    .filter((t) => t && t.status !== "done")
    .map((t) => (t.wave !== undefined && t.wave !== null ? Number(t.wave) : null))
    .filter((w) => w !== null && !Number.isNaN(w));

  if (notDoneWaves.length > 0) {
    return Math.min(...notDoneWaves);
  }
  // Every task is done: report the highest wave present.
  return Math.max(...waves);
}

function computeInFlightTasks(tasks, currentWave) {
  if (currentWave === null || !Array.isArray(tasks)) return [];
  const inWave = tasks.filter(
    (t) => t && t.wave !== undefined && t.wave !== null && Number(t.wave) === currentWave
  );
  let picked = inWave.filter((t) => t.status === "running");
  if (picked.length === 0) {
    picked = inWave.filter((t) => t.status === "pending");
  }
  return picked.slice(0, MAX_IN_FLIGHT).map((t) => ({
    id: t.id !== undefined ? t.id : t.task_key,
    title: t.title !== undefined ? t.title : null,
    role: t.role !== undefined ? t.role : null,
    wave: t.wave !== undefined && t.wave !== null ? Number(t.wave) : null,
    status: t.status !== undefined ? t.status : null,
  }));
}

function computeTaskCounts(tasks) {
  const counts = { total: 0, done: 0, pending: 0, blocked: 0, failed: 0 };
  if (!Array.isArray(tasks)) return counts;
  counts.total = tasks.length;
  for (const t of tasks) {
    const status = t && t.status;
    if (status === "done") counts.done += 1;
    else if (status === "pending") counts.pending += 1;
    else if (status === "blocked") counts.blocked += 1;
    else if (status === "failed") counts.failed += 1;
    // other statuses (e.g. "running"/"in_progress") count only toward total.
  }
  return counts;
}

function computeLastEvent(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const last = events[events.length - 1];
  if (!last || typeof last !== "object") return null;
  return {
    ts: last.ts !== undefined ? last.ts : null,
    type: last.type !== undefined ? last.type : null,
    summary: last.summary !== undefined ? last.summary : null,
  };
}

function isFixtureId(id) {
  return typeof id === "string" && id.startsWith(FIXTURE_PREFIX);
}

function buildSessionGraph(input) {
  const sessions = (input && Array.isArray(input.sessions)) ? input.sessions : [];
  const plans = (input && input.plans && typeof input.plans === "object") ? input.plans : {};
  const events = (input && input.events && typeof input.events === "object") ? input.events : {};

  if (sessions.length === 0) {
    return { nodes: [], edges: [] };
  }

  const nodeIds = new Set(sessions.map((s) => s && s.id).filter((id) => typeof id === "string"));

  const nodes = [];
  const edges = [];

  for (const session of sessions) {
    if (!session || typeof session.id !== "string") continue;
    const id = session.id;
    const parentId =
      session.parent_session_id === undefined || session.parent_session_id === null
        ? null
        : session.parent_session_id;

    const plan = Object.prototype.hasOwnProperty.call(plans, id) ? plans[id] : null;
    const tasks = normalizeTasks(plan);
    const currentWave = computeCurrentWave(tasks);
    const inFlightTasks = computeInFlightTasks(tasks, currentWave);
    const taskCounts = computeTaskCounts(tasks);
    const sessionEvents = Object.prototype.hasOwnProperty.call(events, id) ? events[id] : [];
    const lastEvent = computeLastEvent(sessionEvents);

    nodes.push({
      id,
      status: session.status !== undefined ? session.status : null,
      is_active: !!session.is_active,
      project_path: session.project_path !== undefined ? session.project_path : null,
      parent_session_id: parentId,
      current_wave: currentWave,
      in_flight_tasks: inFlightTasks,
      task_counts: taskCounts,
      last_event: lastEvent,
      is_fixture: isFixtureId(id),
      is_root: parentId === null,
    });

    // Edge only when the parent resolves to a real node in this graph and
    // is not the node itself (see GRAPH RULES above).
    if (parentId !== null && parentId !== id && nodeIds.has(parentId)) {
      edges.push({ from: parentId, to: id });
    }
  }

  return { nodes, edges };
}

module.exports = { buildSessionGraph };
