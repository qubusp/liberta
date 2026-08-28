#!/usr/bin/env node
"use strict";

// fixture-sessions.mjs -- throwaway dashboard-state fixtures for visual
// evidence.
//
// Later style/UI tasks need to see all four dashboard states (running,
// done, failed, idle) in one screenshot. This writes four small
// session-store trees under ~/.claude/liberta-runs/, shaped exactly like
// console/sync.js expects (state.json / plan.json / events.jsonl /
// goal.md), and registers them in ~/.claude/liberta-runs/index.json so
// the console's sync loop and /api/sessions route pick them up like any
// real run.
//
// SAFETY: ~/.claude/liberta-runs/ holds LIVE session data, including the
// very run this script is part of. Every fixture id is prefixed
// `zz-fixture-`, and `clean` (and the index.json rewrite in `create`)
// touches ONLY entries/directories with that exact prefix. Nothing else
// under liberta-runs/ is ever read for the purpose of deleting it, and
// no non-fixture index.json entry is ever modified or reordered.
//
// Usage:
//   node console/scripts/fixture-sessions.mjs create
//   node console/scripts/fixture-sessions.mjs clean

import { promises as fs } from "node:fs";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";

const RUNS_DIR = path.join(os.homedir(), ".claude", "liberta-runs");
const INDEX_PATH = path.join(RUNS_DIR, "index.json");
const FIXTURE_PREFIX = "zz-fixture-";

// Lineage (`parent_session_id`) is deliberately shaped as a GRAPH, not a
// single tree, so lineage/mindmap views have real edge data to render:
// two roots (`running`, `idle`) plus two children hanging off the same
// parent (`done` and `failed` are both children of `running`). null means
// "root". Every parent here is itself a fixture id -- a fixture must
// never point at a real session.
const FIXTURES = [
  { id: `${FIXTURE_PREFIX}running`, status: "running", parent: null },
  { id: `${FIXTURE_PREFIX}done`, status: "done", parent: `${FIXTURE_PREFIX}running` },
  { id: `${FIXTURE_PREFIX}failed`, status: "failed", parent: `${FIXTURE_PREFIX}running` },
  { id: `${FIXTURE_PREFIX}idle`, status: "idle", parent: null },
];

function isFixtureId(id) {
  return typeof id === "string" && id.startsWith(FIXTURE_PREFIX);
}

// Defense in depth: never resolve a path outside RUNS_DIR, and never act
// on a directory name that isn't the fixture prefix, no matter what
// callers pass in.
function fixtureDir(id) {
  if (!isFixtureId(id)) {
    throw new Error(`refusing to touch non-fixture id "${id}"`);
  }
  const dir = path.join(RUNS_DIR, id);
  const resolved = path.resolve(dir);
  const base = path.resolve(RUNS_DIR) + path.sep;
  if (!resolved.startsWith(base)) {
    throw new Error(`refusing to touch path outside liberta-runs/: ${resolved}`);
  }
  return resolved;
}

async function readIndexSafe() {
  try {
    const raw = await fs.readFile(INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.sessions)) return parsed;
  } catch (err) {
    // fall through to empty default below
  }
  return { active_session_id: null, sessions: [] };
}

async function writeIndex(idx) {
  await fs.writeFile(INDEX_PATH, JSON.stringify(idx, null, 2) + "\n", "utf8");
}

function samplePlan(status) {
  const taskStatus =
    status === "done" ? "done" : status === "failed" ? "failed" : status === "running" ? "in_progress" : "pending";
  return {
    tasks: [
      {
        id: "t1",
        role: "build",
        wave: 1,
        status: taskStatus,
        passing: status === "done" ? true : status === "failed" ? false : null,
        depends_on: [],
        verify: "node --check fixture.js",
      },
      {
        id: "t2",
        role: "operate",
        wave: 1,
        status: status === "done" ? "done" : "pending",
        passing: status === "done" ? true : null,
        depends_on: ["t1"],
        verify: "echo ok",
      },
    ],
  };
}

function sampleEvents(id, status) {
  const base = Date.now() - 60_000;
  const lines = [
    {
      ts: new Date(base).toISOString(),
      type: "dispatch",
      from: "controller",
      to: "t1",
      summary: "fixture task dispatched",
      task: "t1",
      wave: 1,
      status: "in_progress",
    },
    {
      ts: new Date(base + 20_000).toISOString(),
      type: "progress",
      from: "t1",
      to: "controller",
      summary: "fixture progress update",
      task: "t1",
      wave: 1,
      status,
    },
  ];
  if (status === "done" || status === "failed") {
    lines.push({
      ts: new Date(base + 40_000).toISOString(),
      type: "result",
      from: "t1",
      to: "controller",
      summary: `fixture task finished: ${status}`,
      task: "t1",
      wave: 1,
      status,
    });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function sampleGoal(id, status) {
  return `# Goal\n\n> Fixture session "${id}" for dashboard-state screenshots (status: ${status}).\n\nThis is throwaway test data written by console/scripts/fixture-sessions.mjs. Safe to delete.\n`;
}

function sampleState(status, parent) {
  // parent_session_id: state.json is the authoritative copy, the
  // index.json entry below is the convenience copy; the two must agree.
  return { status, parent_session_id: parent === undefined ? null : parent };
}

async function createOne(fixture) {
  const dir = fixtureDir(fixture.id);
  // A fixture may only ever claim another fixture as its parent.
  if (fixture.parent !== null && !isFixtureId(fixture.parent)) {
    throw new Error(
      `fixture "${fixture.id}" has non-fixture parent "${fixture.parent}"`
    );
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, "inbox"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "state.json"),
    JSON.stringify(sampleState(fixture.status, fixture.parent), null, 2) + "\n",
    "utf8"
  );
  await fs.writeFile(path.join(dir, "goal.md"), sampleGoal(fixture.id, fixture.status), "utf8");
  await fs.writeFile(
    path.join(dir, "plan.json"),
    JSON.stringify(samplePlan(fixture.status), null, 2) + "\n",
    "utf8"
  );
  await fs.writeFile(path.join(dir, "events.jsonl"), sampleEvents(fixture.id, fixture.status), "utf8");
}

async function removeOne(id) {
  const dir = fixtureDir(id); // throws if id isn't fixture-prefixed or resolves outside RUNS_DIR
  await fs.rm(dir, { recursive: true, force: true });
}

async function create() {
  await fs.mkdir(RUNS_DIR, { recursive: true });

  for (const fixture of FIXTURES) {
    await createOne(fixture);
  }

  const idx = await readIndexSafe();
  // Idempotent: drop any pre-existing fixture entries before re-adding,
  // never touch non-fixture entries.
  const nonFixtureSessions = idx.sessions.filter((s) => !isFixtureId(s && s.id));
  const fixtureSessions = FIXTURES.map((f) => ({
    id: f.id,
    project_path: "/tmp/zz-fixture-project",
    status: f.status,
    parent_session_id: f.parent === undefined ? null : f.parent,
  }));
  idx.sessions = [...nonFixtureSessions, ...fixtureSessions];
  // Never change which session is active.
  await writeIndex(idx);

  process.stdout.write(`created ${FIXTURES.length} fixture sessions under ${RUNS_DIR}\n`);
}

async function clean() {
  // Remove fixture directories: enumerate RUNS_DIR ourselves and only
  // ever act on entries whose name starts with FIXTURE_PREFIX -- never
  // trust FIXTURES alone in case a stale fixture from an older version
  // of this script (extra id) is lying around.
  let entries = [];
  try {
    entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  } catch (err) {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isFixtureId(entry.name)) continue;
    await removeOne(entry.name);
  }

  const idx = await readIndexSafe();
  const before = idx.sessions.length;
  idx.sessions = idx.sessions.filter((s) => !isFixtureId(s && s.id));
  const removed = before - idx.sessions.length;
  // active_session_id is never a fixture id in practice, but guard
  // anyway rather than assume.
  if (isFixtureId(idx.active_session_id)) {
    idx.active_session_id = null;
  }
  if (removed > 0 || fssync.existsSync(INDEX_PATH)) {
    await writeIndex(idx);
  }

  process.stdout.write(`cleaned fixture sessions from ${RUNS_DIR} (removed ${removed} index entries)\n`);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "create") {
    await create();
  } else if (cmd === "clean") {
    await clean();
  } else {
    process.stderr.write("usage: fixture-sessions.mjs <create|clean>\n");
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.message || err}\n`);
  process.exit(1);
});
