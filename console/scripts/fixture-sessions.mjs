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
// SAFETY (index.json): an index that is present but unreadable/unparseable
// is NEVER written over -- both commands abort with a non-zero exit and
// tell the operator to fix or restore it. Only a genuinely ABSENT index is
// treated as empty. All index writes go through a temp file + rename so a
// concurrent reader can never observe a truncated registry.
//
// SAFETY (index.json is SHARED, so NEVER persist a stale snapshot): the
// index is written concurrently by scripts/_log-event.mjs (`--status
// done`). This tool reads it up front -- to validate BEFORE mutating
// anything -- and only then creates/removes fixture directories, so the
// in-memory copy is already stale by the time we would write. Persisting
// that snapshot would silently REVERT every status a controller wrote in
// between, including a live run's. So the snapshot decides WHAT to change;
// the index is re-read IMMEDIATELY before the write and only the fixture
// entries are merged onto that fresh copy. A shape change between the two
// reads aborts; a change between the merge and the rename redoes the
// merge.
//
// Usage:
//   node console/scripts/fixture-sessions.mjs create
//   node console/scripts/fixture-sessions.mjs clean

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const RUNS_DIR = path.join(os.homedir(), ".claude", "liberta-runs");
const INDEX_PATH = path.join(RUNS_DIR, "index.json");
const FIXTURE_PREFIX = "zz-fixture-";
// How many times to redo the read->merge->write cycle when a concurrent
// writer changes index.json underneath us before giving up (and writing
// nothing) rather than clobbering it.
const INDEX_COMMIT_ATTEMPTS = 5;

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

// Reject any id containing a path separator, or the substring `..`
// anywhere in it. This must run BEFORE the prefix check: an id like
// `zz-fixture-../real-session` passes startsWith(FIXTURE_PREFIX) but
// normalises to a path outside the intended fixture directory, so the
// prefix check alone is not enough. Checking for the raw substring `..`
// (rather than only a whole `..` path segment) is deliberately
// conservative: it also refuses ids like `zz-fixture-..`, which do not
// normalise anywhere outside RUNS_DIR today but are needlessly
// suspicious for a directory name that is only ever one of four
// hardcoded fixture ids.
function hasPathEscape(id) {
  if (typeof id !== "string") return true;
  if (id.includes("/") || id.includes("\\")) return true;
  return id.includes("..");
}

// Defense in depth: never resolve a path outside RUNS_DIR, and never act
// on a directory name that isn't the fixture prefix, no matter what
// callers pass in.
function fixtureDir(id) {
  if (hasPathEscape(id)) {
    throw new Error(`refusing to touch id containing a path separator or ".." segment: "${id}"`);
  }
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

// A refusal to proceed because the on-disk index could not be trusted.
// Distinct from a programming error so main() can print operator-facing
// recovery instructions rather than a bare stack-ish message.
class CorruptIndexError extends Error {
  constructor(reason) {
    super(
      `refusing to touch ${INDEX_PATH}: ${reason}.\n` +
        "  This file is the LIVE session registry for every Liberta run.\n" +
        "  Writing over it would silently unregister every real session.\n" +
        "  Fix or restore index.json by hand, then re-run this command."
    );
    this.name = "CorruptIndexError";
  }
}

// Read the index, distinguishing the two cases that used to be conflated:
//
//   ABSENT  -> nothing to lose; start from an empty index (safe to write).
//   PRESENT BUT UNREADABLE/UNPARSEABLE -> a truncated, half-written or
//     hand-mangled registry. NEVER write in this case; a failed read must
//     never be laundered into an empty index that then gets persisted over
//     real data. Abort loudly instead.
// Returns { raw, index }. `raw` is the exact bytes on disk, or null when
// the index is genuinely ABSENT -- callers use it both to detect an
// absent->present flip and to confirm nothing changed before renaming.
async function readIndexOrThrow() {
  let raw;
  try {
    raw = await fs.readFile(INDEX_PATH, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      // Genuinely absent: an empty index is the correct starting point.
      return { raw: null, index: { active_session_id: null, sessions: [] } };
    }
    // Present but unreadable (EACCES, EISDIR, EIO, ...) -- do not guess.
    throw new CorruptIndexError(`could not read it (${err && err.code ? err.code : err})`);
  }
  // An existing-but-empty file is the classic mid-write truncation, not an
  // absent index. Refuse rather than assume the registry was empty.
  if (!raw.trim()) {
    throw new CorruptIndexError("the file exists but is empty (truncated mid-write?)");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CorruptIndexError(`it is not valid JSON (${err.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.sessions)) {
    throw new CorruptIndexError('it does not have the expected shape ({ active_session_id, sessions: [] })');
  }
  // Per-entry validation: every element of `sessions` must be an object
  // with a string `id`, or we cannot safely distinguish a fixture entry
  // from a non-fixture one (isFixtureId would silently treat a malformed
  // entry as non-fixture, but a corrupt registry should abort loudly
  // rather than be guessed at). Well-formed-but-unknown entries are still
  // preserved verbatim elsewhere in this file -- this only rejects
  // malformed elements.
  for (const entry of parsed.sessions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string") {
      throw new CorruptIndexError(
        "the \"sessions\" array contains an entry that is not an object with a string \"id\""
      );
    }
  }
  return { raw, index: parsed };
}

// A concurrent status write changes VALUES inside sessions[] -- expected,
// and exactly what the merge below preserves. A change to the index's own
// top-level key set, or the file appearing/disappearing between the two
// reads, is a different writer or a different format: refuse rather than
// merge blind.
function assertShapeUnchanged(snapshot, fresh) {
  if ((snapshot.raw === null) !== (fresh.raw === null)) {
    throw new CorruptIndexError(
      snapshot.raw === null
        ? "it was absent when this command started but exists now " +
          "(another writer created it)"
        : "it existed when this command started but is absent now"
    );
  }
  const before = Object.keys(snapshot.index).sort().join(",");
  const after = Object.keys(fresh.index).sort().join(",");
  if (before !== after) {
    throw new CorruptIndexError(
      `its shape changed between read and write (top-level keys ` +
        `"${before}" -> "${after}")`
    );
  }
}

// Re-read the index, apply ONLY this tool's fixture delta to that fresh
// copy, and write it -- never the stale snapshot. The rename only happens
// while the file still holds the bytes we merged onto; otherwise the merge
// is redone against the newer bytes. Returns the merged index.
async function commitIndex(snapshot, applyDelta) {
  for (let attempt = 1; attempt <= INDEX_COMMIT_ATTEMPTS; attempt += 1) {
    const fresh = await readIndexOrThrow(); // corrupt now => abort, never write
    assertShapeUnchanged(snapshot, fresh);
    const merged = applyDelta(fresh.index);
    if (await writeIndex(merged, fresh.raw)) return merged;
    // Lost the race between merge and rename -- redo it.
  }
  throw new Error(
    `gave up after ${INDEX_COMMIT_ATTEMPTS} attempts: ${INDEX_PATH} keeps ` +
      `changing underneath us; nothing written`
  );
}

// Atomic: write a temp file in the same directory, then rename over the
// target. rename(2) is atomic within a filesystem, so a concurrent reader
// (e.g. the controller's scripts/_log-event.mjs) sees either the old index
// or the new one -- never a truncated one. Matches the writeJsonAtomic
// helper in scripts/_log-event.mjs and console/scripts/backfill-parents.mjs.
// `expectedRaw` is the bytes the caller merged onto (null == the index was
// absent). The rename is only performed while the target still holds
// exactly those bytes, so a status write that landed while we were merging
// is never clobbered; `false` is returned instead so the caller can redo
// the merge. Returns true when the write landed.
async function writeIndex(idx, expectedRaw) {
  const body = JSON.stringify(idx, null, 2) + "\n";
  // Nothing to change: leave the file (and its mtime) completely alone.
  if (body === expectedRaw) return true;
  const tmp = `${INDEX_PATH}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, body, "utf8");
  try {
    let current;
    try {
      current = await fs.readFile(INDEX_PATH, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") current = null;
      else throw err;
    }
    if (current !== expectedRaw) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      return false;
    }
    await fs.rename(tmp, INDEX_PATH);
    return true;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
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

  // Validate the index BEFORE writing any fixture directories, so a corrupt
  // index aborts without leaving half-created fixtures behind.
  const snapshot = await readIndexOrThrow();

  for (const fixture of FIXTURES) {
    await createOne(fixture);
  }

  const fixtureSessions = FIXTURES.map((f) => ({
    id: f.id,
    project_path: "/tmp/zz-fixture-project",
    status: f.status,
    parent_session_id: f.parent === undefined ? null : f.parent,
  }));
  // Merged onto a FRESH read (see the SAFETY note at the top), never onto
  // `snapshot`: idempotent, drops any pre-existing fixture entries before
  // re-adding, and copies every non-fixture entry -- including any status
  // a controller wrote while we were creating directories -- verbatim.
  // Never changes which session is active.
  await commitIndex(snapshot, (fresh) => ({
    ...fresh,
    sessions: [
      ...fresh.sessions.filter((s) => !isFixtureId(s && s.id)),
      ...fixtureSessions,
    ],
  }));

  process.stdout.write(`created ${FIXTURES.length} fixture sessions under ${RUNS_DIR}\n`);
}

async function clean() {
  // Validate the index BEFORE removing anything. If it is corrupt we abort
  // without having touched a single directory, so the store is left exactly
  // as we found it.
  const snapshot = await readIndexOrThrow();

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

  // Never create an index that was absent (an absent index also has no
  // fixture entries to remove, so there is nothing to write either way).
  let removed = 0;
  if (snapshot.raw !== null) {
    // Merged onto a FRESH read, never onto `snapshot`: only fixture
    // entries are dropped, every other entry is copied verbatim.
    await commitIndex(snapshot, (fresh) => {
      const kept = fresh.sessions.filter((s) => !isFixtureId(s && s.id));
      removed = fresh.sessions.length - kept.length;
      const merged = { ...fresh, sessions: kept };
      // active_session_id is never a fixture id in practice, but guard
      // anyway rather than assume.
      if (isFixtureId(merged.active_session_id)) merged.active_session_id = null;
      return merged;
    });
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
  if (err instanceof CorruptIndexError) {
    process.stderr.write(`ABORTED: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`FATAL: ${err.message || err}\n`);
  process.exit(1);
});
