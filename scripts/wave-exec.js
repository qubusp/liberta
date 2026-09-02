#!/usr/bin/env node
// Liberta wave-execution dispatch-plan generator + recorder.
//
// This script never spawns a subagent itself (only the calling Claude Code
// controller session can do that via its own Task tool) -- it is a planning
// / bookkeeping helper with three modes, all keyed on a session id and a
// wave number read from ~/.claude/liberta-runs/<session-id>/{plan.json,
// project.json,goal.md}:
//
//   1. GENERATE (default):
//        node wave-exec.js <session-id> <wave> [--token-budget <n>]
//      Selects every plan.json task whose wave matches, creates one git
//      worktree per task off the wave branch (liberta/<session-id>-wave<n>,
//      cut from goal.md's base_branch if it doesn't exist yet), routes each
//      task's role to a producer, and writes
//      waves/<n>/dispatch-plan.json -- the work queue the controller then
//      feeds to its own Task/Agent dispatch, one call per entry.
//
//   2. RECORD (after the controller actually ran a task through a subagent
//      and verified it):
//        node wave-exec.js <session-id> <wave> --record <task_id> \
//          --result passed|failed --evidence "<text>" \
//          [--merged] [--model <tier>] [--blocker "<text>"] [--tokens <n>]
//      Updates plan.json's status for that task (done/passing/attempts/
//      blocked), merges its worktree branch into the wave branch in
//      dependency order (unless --merged says the controller already did
//      it), and adds to the wave's running token-spend total. On a merge
//      conflict, leaves the conflict markers in place, does not abort, and
//      exits non-zero telling the controller to spawn a liberta-builder to
//      reconcile.
//
//   3. SUMMARY (once every dispatched task has a recorded result):
//        node wave-exec.js <session-id> <wave> --summary
//      Prints the final [{task_id, passed, model_used, evidence, branch,
//      merged, blocker}] verdict list plus role_warnings and total token
//      spend as JSON to stdout, then tears down every worktree created for
//      this wave (git worktree remove), regardless of outcome.

// ---------------------------------------------------------------------------
// NAMING AND OWNERSHIP INVARIANTS (see site/docs/concurrency.md section 5)
//
// Every ref and every directory this script creates or destroys is scoped to
// exactly one (session id, wave) pair, so two controllers driving two sessions
// in the same repository at the same time can never name, reuse or delete each
// other's things.
//
//  I1. SESSION ID SHAPE. A session id must match
//      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ and must not contain "..", must
//      not end in ".lock" or ".", and must not be "@". Anything else exits
//      non-zero with a clear message instead of being pasted into a ref name
//      or a path. Wave numbers must be non-negative integers; task ids must
//      match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ with the same "..") ban.
//      Because the character set excludes "/", "liberta/<id>-wave<n>" always
//      has exactly two path components and the id can never inject one.
//
//  I2. BRANCH NAMES. Wave branch  = liberta/<session-id>-wave<n>.
//      Task branch  = <wave-branch>-task-<task-id>.
//      Both are derived only from validated inputs, so distinct session ids
//      yield disjoint branch names, and every branch this script touches has
//      the prefix "liberta/<session-id>-wave<n>".
//
//  I3. BRANCH OWNERSHIP IS EXPLICIT. A branch is "ours" only if this session
//      recorded it in <waveDir>/owned-branches.json (or in this wave's own
//      dispatch-plan.json / wave-state.json, for runs created before that file
//      existed). If a branch of the target name already exists in the repo and
//      is NOT recorded as ours, that is a foreign collision: we fail loudly
//      rather than silently checking out somebody else's work.
//
//  I4. WORKTREE PATHS. Every worktree lives under
//      <run-store>/<session-id>/waves/<n>/ -- per-task trees under
//      .../worktrees/<task-id>, the merge tree at .../merge. Nothing is ever
//      created in os.tmpdir() or anywhere else shared.
//
//  I5. REMOVAL IS FENCED. worktreeRemove() and the summary teardown loop
//      resolve the target path (realpath, so symlinks cannot smuggle a path
//      in) and refuse, with a clear message and a non-zero exit, to act on any
//      path that is not inside this session's own wave directory. A worktree
//      still holding merge conflicts is never force-removed.
//
//  I6. BANNED COMMANDS. This script -- and the repo as a whole -- never runs
//      the "worktree" + "prune" subcommand (it would silently deregister
//      another live session's tree), never removes a worktree outside the
//      current session (I5), and never force-deletes a branch (the -D form of
//      git branch). Cleanup is per-path, per-session and non-destructive to
//      refs. If you ever need pruning, filter it to this session's own paths;
//      a bare prune is a repo-wide operation and is not allowed here.
// ---------------------------------------------------------------------------

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { runsRoot, sessionDir } = require("./_store.cjs");

function fail(msg) {
  process.stderr.write(`wave-exec: ${msg}\n`);
  process.exit(1);
}

// --- I1: strict identifier validation -----------------------------------

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function badIdReason(value, re, kind) {
  if (typeof value !== "string" || value.length === 0) {
    return `${kind} must be a non-empty string`;
  }
  if (!re.test(value)) {
    return (
      `${kind} ${JSON.stringify(value)} is not allowed: it must match ${re} ` +
      `(letters, digits, dot, dash, underscore; must start with a letter or digit)`
    );
  }
  if (value.includes("..")) return `${kind} ${JSON.stringify(value)} must not contain ".."`;
  if (value.endsWith(".")) return `${kind} ${JSON.stringify(value)} must not end with "."`;
  if (value.endsWith(".lock")) return `${kind} ${JSON.stringify(value)} must not end with ".lock"`;
  return null;
}

function assertSessionId(sessionId) {
  const why = badIdReason(sessionId, SESSION_ID_RE, "session id");
  if (why) {
    fail(
      `${why}. Refusing to build a git ref or run-store path from it ` +
        `(see NAMING AND OWNERSHIP INVARIANTS at the top of this file).`
    );
  }
  return sessionId;
}

function assertWave(wave) {
  const str = String(wave);
  if (!/^\d{1,6}$/.test(str)) {
    fail(
      `wave ${JSON.stringify(String(wave))} is not allowed: it must be a non-negative integer. ` +
        `Refusing to build a git ref or run-store path from it.`
    );
  }
  return str;
}

function assertTaskId(taskId) {
  const why = badIdReason(String(taskId), TASK_ID_RE, "task id");
  if (why) {
    fail(
      `${why}. Refusing to build a git ref or run-store path from it ` +
        `(see NAMING AND OWNERSHIP INVARIANTS at the top of this file).`
    );
  }
  return String(taskId);
}

// --- I2: the only two places branch names are constructed ----------------

function waveBranchName(sessionId, wave) {
  assertSessionId(sessionId);
  assertWave(wave);
  return `liberta/${sessionId}-wave${wave}`;
}

function taskBranchName(sessionId, wave, taskId) {
  return `${waveBranchName(sessionId, wave)}-task-${assertTaskId(taskId)}`;
}

function waveDir(sessionId, wave) {
  assertSessionId(sessionId);
  assertWave(wave);
  return path.join(sessionDir(sessionId), "waves", String(wave));
}

// --- I5: resolved-path containment ---------------------------------------

// realpath() as much of the path as exists, so a symlinked ancestor (e.g.
// /var -> /private/var on macOS) can neither defeat nor forge containment.
function resolveReal(p) {
  let cur = path.resolve(String(p));
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch (err) {
      if (err.code !== "ENOENT") return path.resolve(String(p));
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(String(p));
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isInside(child, parent) {
  const c = resolveReal(child);
  const p = resolveReal(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// Every destructive worktree operation goes through this fence first.
function assertOwnedWorktreePath(worktreePath, sessionId, wave) {
  const root = waveDir(sessionId, wave);
  if (!worktreePath || !isInside(worktreePath, root)) {
    fail(
      `refusing to touch worktree ${JSON.stringify(String(worktreePath))}: it resolves to ` +
        `${JSON.stringify(resolveReal(worktreePath || ""))}, which is outside this session's own wave ` +
        `directory ${JSON.stringify(resolveReal(root))}. Another session may own it ` +
        `(invariant I5, see the top of this file).`
    );
  }
  return worktreePath;
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

// Lenient line-based key: value scanner for goal.md -- not strict YAML.
function parseGoalMd(text) {
  const fields = {};
  if (!text) return fields;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*[-*]?\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    val = val.replace(/^["'`]+|["'`]+$/g, "");
    if (val === "true") fields[key] = true;
    else if (val === "false") fields[key] = false;
    else if (val === "null" || val === "none" || val === "") fields[key] = null;
    else if (/^-?\d+$/.test(val)) fields[key] = parseInt(val, 10);
    else fields[key] = val;
  }
  return fields;
}

function log(sessionId, type, from, to, summary, extra) {
  const scriptPath = path.join(__dirname, "_log-event.mjs");
  if (!fs.existsSync(scriptPath)) return; // not landed yet -- don't block
  const args = [scriptPath, sessionId, type, from, to, summary];
  if (extra && extra.task !== undefined) args.push("--task", String(extra.task));
  if (extra && extra.wave !== undefined) args.push("--wave", String(extra.wave));
  if (extra && extra.status !== undefined) args.push("--status", String(extra.status));
  try {
    execFileSync("node", args, { stdio: "ignore" });
  } catch (err) {
    process.stderr.write(`wave-exec: _log-event call failed: ${err.message}\n`);
  }
}

// --- role routing -----------------------------------------------------

const ROLE_TABLE = {
  build: "liberta-builder",
  style: "liberta-stylist",
  analyze: "liberta-analyst",
  scout: "liberta-scout",
  operate: "liberta-operator",
};

function normalizeRole(raw) {
  if (!raw) return "";
  let r = String(raw).trim().toLowerCase();
  r = r.replace(/^liberta[-_]/, "");
  r = r.replace(/[-\s]+/g, "_");
  return r;
}

function resolveProducer(rawRole) {
  const norm = normalizeRole(rawRole);
  if (ROLE_TABLE[norm]) return { role: norm, producer: ROLE_TABLE[norm], warned: false };
  return { role: norm || rawRole, producer: "liberta-builder", warned: true };
}

// --- git helpers --------------------------------------------------------

function git(gitRoot, args, opts) {
  return execFileSync("git", args, {
    cwd: gitRoot,
    encoding: "utf8",
    ...(opts || {}),
  });
}

function gitOk(gitRoot, args) {
  try {
    git(gitRoot, args);
    return true;
  } catch {
    return false;
  }
}

function branchExists(gitRoot, branch) {
  return gitOk(gitRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
}

// --- I3: explicit branch ownership ---------------------------------------

function ownedBranchesPath(sessionId, wave) {
  return path.join(waveDir(sessionId, wave), "owned-branches.json");
}

function loadOwnedBranches(sessionId, wave) {
  const owned = new Set();
  const rec = readJson(ownedBranchesPath(sessionId, wave), null);
  if (rec && Array.isArray(rec.branches)) {
    for (const b of rec.branches) owned.add(String(b));
  }
  // Runs created before owned-branches.json existed still prove ownership
  // through their own wave bookkeeping, which lives in this session's dir.
  const dp = readJson(path.join(waveDir(sessionId, wave), "dispatch-plan.json"), null);
  if (dp) {
    if (dp.wave_branch) owned.add(String(dp.wave_branch));
    if (Array.isArray(dp.tasks)) {
      for (const e of dp.tasks) if (e && e.branch) owned.add(String(e.branch));
    }
  }
  const st = readJson(path.join(waveDir(sessionId, wave), "wave-state.json"), null);
  if (st && st.wave_branch) owned.add(String(st.wave_branch));
  return owned;
}

function claimBranch(sessionId, wave, branch) {
  const file = ownedBranchesPath(sessionId, wave);
  const rec = readJson(file, null) || {};
  const list = Array.isArray(rec.branches) ? rec.branches.slice() : [];
  if (!list.includes(branch)) list.push(branch);
  writeJsonAtomic(file, {
    session_id: sessionId,
    wave: Number(wave),
    branches: list,
    updated_at: new Date().toISOString(),
  });
}

// Returns "created" or "reused"; exits non-zero on a foreign collision.
function claimBranchOwnership(gitRoot, branch, sessionId, wave, startPoint) {
  const prefix = waveBranchName(sessionId, wave);
  if (branch !== prefix && !branch.startsWith(`${prefix}-`)) {
    fail(
      `refusing to use branch ${JSON.stringify(branch)}: it is not scoped to this session's ` +
        `wave branch ${JSON.stringify(prefix)} (invariant I2).`
    );
  }
  const exists = branchExists(gitRoot, branch);
  if (exists && !loadOwnedBranches(sessionId, wave).has(branch)) {
    fail(
      `branch ${JSON.stringify(branch)} already exists in ${gitRoot} but is NOT owned by ` +
        `session ${JSON.stringify(sessionId)} wave ${wave} (it is not recorded in ` +
        `${ownedBranchesPath(sessionId, wave)}). Refusing to reuse another owner's branch. ` +
        `Resolve the collision by hand -- this script never force-deletes refs (invariant I6).`
    );
  }
  if (!exists) {
    if (startPoint !== undefined && startPoint !== null) {
      git(gitRoot, ["branch", branch, startPoint]);
    }
    claimBranch(sessionId, wave, branch);
    return "created";
  }
  claimBranch(sessionId, wave, branch);
  return "reused";
}

function ensureWaveBranch(gitRoot, waveBranch, baseBranch, sessionId, wave) {
  const base = baseBranch || currentBranch(gitRoot);
  claimBranchOwnership(gitRoot, waveBranch, sessionId, wave, base);
}

function currentBranch(gitRoot) {
  return git(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

// Adds a worktree for a branch this session owns, at a path inside this
// session's own wave directory. Both facts are asserted, not assumed: a
// foreign branch of the same name, or a path outside the wave directory,
// exits non-zero rather than silently doing the wrong thing.
function worktreeAdd(gitRoot, worktreePath, branch, startPoint, sessionId, wave) {
  assertOwnedWorktreePath(worktreePath, sessionId, wave);
  const state = claimBranchOwnership(gitRoot, branch, sessionId, wave, null);
  if (fs.existsSync(worktreePath)) return; // idempotent
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  if (state === "reused") {
    git(gitRoot, ["worktree", "add", worktreePath, branch]);
  } else {
    git(gitRoot, ["worktree", "add", "-b", branch, worktreePath, startPoint]);
  }
}

// The only removal path in this file. It refuses any target that is not
// inside this session's own wave directory (invariant I5), and never removes
// a tree that still holds merge conflicts.
function worktreeRemove(gitRoot, worktreePath, sessionId, wave) {
  assertOwnedWorktreePath(worktreePath, sessionId, wave);
  if (!fs.existsSync(worktreePath)) return;
  if (hasConflict(worktreePath)) {
    process.stderr.write(
      `wave-exec: keeping worktree ${worktreePath} -- it still has unresolved merge conflicts\n`
    );
    return;
  }
  try {
    git(gitRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch (err) {
    process.stderr.write(
      `wave-exec: could not remove worktree ${worktreePath}: ${err.message}\n`
    );
  }
}

// --- project / plan resolution ------------------------------------------

function gitRootFromProject(project) {
  const candidates = [
    project && project.git_root,
    project && project.root,
    project && project.project_root,
    project && project.project_path,
    project && project.path,
  ];
  for (const c of candidates) {
    if (c) return c;
  }
  return null;
}

function loadPlanTasks(plan) {
  if (Array.isArray(plan)) return { tasks: plan, wrapped: false };
  if (plan && Array.isArray(plan.tasks)) return { tasks: plan.tasks, wrapped: true };
  return { tasks: [], wrapped: Array.isArray(plan && plan.tasks) };
}

function savePlanTasks(planPath, plan, tasks, wrapped) {
  const out = wrapped ? { ...plan, tasks } : tasks;
  writeJsonAtomic(planPath, out);
}

// --- wave-state (this script's own bookkeeping of recorded results) -----

function waveStatePath(sessionId, wave) {
  return path.join(waveDir(sessionId, wave), "wave-state.json");
}

function loadWaveState(sessionId, wave) {
  return readJson(waveStatePath(sessionId, wave), {
    wave_branch: null,
    task_ids: [],
    role_warnings: [],
    spend: 0,
    results: {},
  });
}

function saveWaveState(sessionId, wave, state) {
  writeJsonAtomic(waveStatePath(sessionId, wave), state);
}

// --- arg parsing ----------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  const flags = new Set();
  const valueFlags = new Set([
    "--record",
    "--result",
    "--evidence",
    "--model",
    "--blocker",
    "--tokens",
    "--token-budget",
  ]);
  const boolFlags = new Set(["--merged", "--summary"]);
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (valueFlags.has(a)) {
      const key = a.replace(/^--/, "").replace(/-/g, "_");
      const val = argv[i + 1];
      if (val === undefined) fail(`missing value for ${a}`);
      opts[key] = val;
      i += 2;
    } else if (boolFlags.has(a)) {
      flags.add(a.replace(/^--/, ""));
      i += 1;
    } else {
      positional.push(a);
      i += 1;
    }
  }
  return { positional, opts, flags };
}

// --- mode: generate dispatch plan -----------------------------------------

function modeGenerate(sessionId, wave, opts) {
  const dir = sessionDir(sessionId);
  const plan = readJson(path.join(dir, "plan.json"), null);
  if (plan === null) fail(`plan.json not found for session ${sessionId}`);
  const project = readJson(path.join(dir, "project.json"), {});
  const goalText = (() => {
    try {
      return fs.readFileSync(path.join(dir, "goal.md"), "utf8");
    } catch {
      return "";
    }
  })();
  const goal = parseGoalMd(goalText);

  const gitRoot = gitRootFromProject(project);
  if (!gitRoot) fail("could not determine git root from project.json");
  if (!fs.existsSync(path.join(gitRoot, ".git"))) {
    fail(`${gitRoot} does not look like a git repo root (no .git)`);
  }

  const { tasks } = loadPlanTasks(plan);
  const waveTasks = tasks.filter((t) => String(t.wave) === String(wave));
  if (waveTasks.length === 0) {
    fail(`no tasks in plan.json with wave ${wave}`);
  }

  const state = loadWaveState(sessionId, wave);
  const tokenBudget = opts.token_budget !== undefined ? Number(opts.token_budget) : null;
  if (tokenBudget !== null && !Number.isNaN(tokenBudget)) {
    if (state.spend >= tokenBudget) {
      fail(
        `token budget exceeded: recorded spend ${state.spend} >= budget ${tokenBudget}; refusing to generate new dispatch-plan entries`
      );
    }
  }

  const waveBranch = waveBranchName(sessionId, wave);
  const baseBranch = goal.base_branch || currentBranch(gitRoot);
  ensureWaveBranch(gitRoot, waveBranch, baseBranch, sessionId, wave);

  const wdir = waveDir(sessionId, wave);
  const worktreesRoot = path.join(wdir, "worktrees");

  const roleWarnings = [];
  const entries = [];

  for (const task of waveTasks) {
    const { role, producer, warned } = resolveProducer(task.role);
    if (warned) {
      roleWarnings.push({ task_id: task.id, role: task.role });
    }
    const worktreePath = path.join(worktreesRoot, assertTaskId(task.id));
    const taskBranch = taskBranchName(sessionId, wave, task.id);
    worktreeAdd(gitRoot, worktreePath, taskBranch, waveBranch, sessionId, wave);

    entries.push({
      task_id: task.id,
      role,
      resolved_producer: producer,
      worktree_path: worktreePath,
      model_tier: task.model || "sonnet",
      depends_on: task.depends_on || [],
      verify_command: task.verify || null,
      branch: taskBranch,
    });
  }

  const dispatchPlan = {
    session_id: sessionId,
    wave: Number(wave),
    wave_branch: waveBranch,
    base_branch: baseBranch,
    git_root: gitRoot,
    generated_at: new Date().toISOString(),
    role_warnings: roleWarnings,
    tasks: entries,
  };

  writeJsonAtomic(path.join(wdir, "dispatch-plan.json"), dispatchPlan);

  state.wave_branch = waveBranch;
  state.task_ids = Array.from(new Set([...(state.task_ids || []), ...entries.map((e) => e.task_id)]));
  state.role_warnings = mergeRoleWarnings(state.role_warnings, roleWarnings);
  saveWaveState(sessionId, wave, state);

  log(
    sessionId,
    "wave_dispatch_plan_generated",
    "planning",
    "dispatching",
    `dispatch plan for wave ${wave}: ${entries.length} tasks`,
    { wave, status: undefined }
  );

  process.stdout.write(JSON.stringify(dispatchPlan, null, 2) + "\n");
}

function mergeRoleWarnings(existing, incoming) {
  const seen = new Set((existing || []).map((w) => `${w.task_id}::${w.role}`));
  const out = [...(existing || [])];
  for (const w of incoming) {
    const key = `${w.task_id}::${w.role}`;
    if (!seen.has(key)) {
      out.push(w);
      seen.add(key);
    }
  }
  return out;
}

// Resolve whether a single depends_on entry is satisfied for the purposes
// of the merge gate. Same-wave dependencies are looked up in the current
// wave's own results map (fast path, no git calls). A dependency that is
// not in the current wave's results is assumed to belong to an EARLIER
// wave: it is resolved against plan.json (must be status "done" and
// passing true), then belt-and-braces confirmed by checking that the
// dependency's own recorded branch (from its wave's wave-state.json) is
// actually an ancestor of the wave branch being recorded into. Anything
// that can't be positively confirmed this way is treated as unsatisfied,
// so pending/failed/unknown dependencies (same-wave or cross-wave) still
// block, exactly as before.
function isDepSatisfied(sessionId, gitRoot, waveBranch, depId, state, planTasksById) {
  const local = state.results[depId];
  if (local) {
    return !!(local.passed && local.merged);
  }

  // Not in this wave's results -- resolve against plan.json as a
  // cross-wave (presumably already-merged) dependency.
  const depTask = planTasksById[depId];
  if (!depTask) return false;
  if (depTask.status !== "done" || depTask.passing !== true) return false;

  const depWave = depTask.wave;
  if (depWave === undefined || depWave === null) return false;

  const depState = loadWaveState(sessionId, depWave);
  const depResult = depState.results[depId];
  if (!depResult || !depResult.passed || !depResult.merged || !depResult.branch) {
    return false;
  }

  // Confirm the dependency's branch is genuinely an ancestor of the wave
  // branch we're about to merge into -- don't just trust plan.json state.
  return gitOk(gitRoot, ["merge-base", "--is-ancestor", depResult.branch, waveBranch]);
}

function modeRecord(sessionId, wave, taskId, opts, flags) {
  const dir = sessionDir(sessionId);
  const planPath = path.join(dir, "plan.json");
  const plan = readJson(planPath, null);
  if (plan === null) fail(`plan.json not found for session ${sessionId}`);
  const project = readJson(path.join(dir, "project.json"), {});
  const gitRoot = gitRootFromProject(project);
  if (!gitRoot) fail("could not determine git root from project.json");

  const result = opts.result;
  if (result !== "passed" && result !== "failed") {
    fail('--result must be "passed" or "failed"');
  }
  const evidence = opts.evidence || "";

  const { tasks, wrapped } = loadPlanTasks(plan);
  const task = tasks.find((t) => String(t.id) === String(taskId));
  if (!task) fail(`task ${taskId} not found in plan.json`);

  const wdir = waveDir(sessionId, wave);
  const dispatchPlan = readJson(path.join(wdir, "dispatch-plan.json"), null);
  const dpEntry = dispatchPlan && dispatchPlan.tasks.find((e) => String(e.task_id) === String(taskId));
  const waveBranch = waveBranchName(sessionId, wave);
  if (dispatchPlan && dispatchPlan.wave_branch && dispatchPlan.wave_branch !== waveBranch) {
    fail(
      `dispatch-plan.json records wave branch ${JSON.stringify(dispatchPlan.wave_branch)} but this ` +
        `session/wave owns ${JSON.stringify(waveBranch)} (invariant I2)`
    );
  }
  const taskBranch = taskBranchName(sessionId, wave, taskId);
  if (dpEntry && dpEntry.branch && dpEntry.branch !== taskBranch) {
    fail(
      `dispatch-plan.json records task branch ${JSON.stringify(dpEntry.branch)} for task ${taskId} ` +
        `but this session/wave owns ${JSON.stringify(taskBranch)} (invariant I2)`
    );
  }

  const state = loadWaveState(sessionId, wave);
  state.wave_branch = waveBranch;

  const passed = result === "passed";
  const tokens = opts.tokens !== undefined ? Number(opts.tokens) || 0 : 0;

  let merged = false;
  let blocker = opts.blocker || null;

  if (passed) {
    task.status = "done";
    task.passing = true;
    task.evidence = evidence;
    task.blocker = null;

    if (flags.has("merged")) {
      merged = true;
    } else {
      const dependsOn = task.depends_on || [];
      const planTasksById = Object.fromEntries(tasks.map((t) => [String(t.id), t]));
      const depsMerged = dependsOn.every((depId) =>
        isDepSatisfied(sessionId, gitRoot, waveBranch, depId, state, planTasksById)
      );
      if (!depsMerged) {
        merged = false;
        blocker = blocker || "awaiting dependency merge";
      } else {
        try {
          merged = mergeTaskBranch(gitRoot, waveBranch, taskBranch, sessionId, wave);
        } catch (err) {
          saveWaveState(sessionId, wave, state);
          log(sessionId, "wave_merge_conflict", "merging", "blocked", `conflict merging ${taskBranch} into ${waveBranch}`, {
            task: taskId,
            wave,
          });
          fail(
            `merge conflict merging ${taskBranch} into ${waveBranch}: ${err.message}\n` +
              `Conflict markers left in place in ${gitRoot} (branch ${waveBranch}). ` +
              `Spawn a liberta-builder to reconcile, then re-run --record with --merged.`
          );
        }
      }
    }
  } else {
    task.attempts = (task.attempts || 0) + 1;
    task.passing = false;
    task.evidence = evidence;
    task.blocker = blocker;
    task.status = task.attempts >= 2 ? "blocked" : "pending";
    merged = false;
  }

  savePlanTasks(planPath, plan, tasks, wrapped);

  state.spend = (state.spend || 0) + tokens;
  state.results[taskId] = {
    task_id: taskId,
    passed,
    model_used: opts.model || task.model || "sonnet",
    evidence,
    branch: taskBranch,
    merged,
    blocker: passed ? (merged ? null : blocker) : blocker,
  };
  saveWaveState(sessionId, wave, state);

  log(
    sessionId,
    "wave_task_recorded",
    passed ? "verifying" : "verifying",
    passed ? (merged ? "merged" : "done") : task.status,
    `${passed ? "PASS" : "FAIL"} task ${taskId}: ${evidence}`.slice(0, 300),
    { task: taskId, wave }
  );

  process.stdout.write(JSON.stringify(state.results[taskId], null, 2) + "\n");
}

function mergeTaskBranch(gitRoot, waveBranch, taskBranch, sessionId, wave) {
  // Perform the merge in a dedicated worktree checked out to the wave branch,
  // so this never disturbs whatever the caller's cwd/HEAD is. The tree lives
  // inside this session's own wave directory (invariant I4) -- never in
  // os.tmpdir(), which every session on the box shares -- and is created and
  // removed only through the fenced helpers.
  const mergeWt = path.join(waveDir(sessionId, wave), "merge");
  assertOwnedWorktreePath(mergeWt, sessionId, wave);
  if (fs.existsSync(mergeWt)) {
    if (hasConflict(mergeWt)) {
      fail(
        `merge worktree ${mergeWt} still holds unresolved conflicts. Refusing to destroy it. ` +
          `Reconcile it, commit, then re-run --record with --merged.`
      );
    }
    worktreeRemove(gitRoot, mergeWt, sessionId, wave);
    fs.rmSync(mergeWt, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(mergeWt), { recursive: true });
  git(gitRoot, ["worktree", "add", mergeWt, waveBranch]);
  try {
    git(gitRoot, ["merge", "--no-ff", "--no-edit", taskBranch], { cwd: mergeWt });
    return true;
  } catch (err) {
    // Leave conflict markers in place -- do not abort. Re-throw so the
    // caller can report and exit non-zero; the worktree with the conflict
    // stays on disk at mergeWt for a liberta-builder to reconcile.
    throw err;
  } finally {
    if (!hasConflict(mergeWt)) {
      worktreeRemove(gitRoot, mergeWt, sessionId, wave);
    }
  }
}

function hasConflict(worktreePath) {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: worktreePath,
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// --- mode: summary ----------------------------------------------------------

function modeSummary(sessionId, wave) {
  const wdir = waveDir(sessionId, wave);
  const dispatchPlan = readJson(path.join(wdir, "dispatch-plan.json"), null);
  if (!dispatchPlan) fail(`no dispatch-plan.json found for wave ${wave} -- run generate mode first`);

  const state = loadWaveState(sessionId, wave);
  const missing = dispatchPlan.tasks
    .map((e) => e.task_id)
    .filter((id) => !state.results[id]);
  if (missing.length > 0) {
    fail(`wave ${wave} incomplete -- no recorded result for task(s): ${missing.join(", ")}`);
  }

  const verdicts = dispatchPlan.tasks.map((e) => {
    const r = state.results[e.task_id];
    return {
      task_id: e.task_id,
      passed: r.passed,
      model_used: r.model_used,
      evidence: r.evidence,
      branch: r.branch,
      merged: r.merged,
      blocker: r.blocker,
    };
  });

  const summary = {
    session_id: sessionId,
    wave: Number(wave),
    verdicts,
    role_warnings: state.role_warnings || [],
    total_token_spend: state.spend || 0,
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  const project = readJson(path.join(sessionDir(sessionId), "project.json"), {});
  const gitRoot = gitRootFromProject(project);
  if (gitRoot) {
    for (const e of dispatchPlan.tasks) {
      // Fenced by invariant I5: anything outside this session's own wave
      // directory exits non-zero instead of being removed.
      worktreeRemove(gitRoot, e.worktree_path, sessionId, wave);
    }
  }

  log(
    sessionId,
    "wave_summary",
    "wave-running",
    "wave-complete",
    `wave ${wave} summary: ${verdicts.filter((v) => v.passed).length}/${verdicts.length} passed, spend ${summary.total_token_spend}`,
    { wave }
  );
}

// --- main -------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const { positional, opts, flags } = parseArgs(argv);

  const sessionId = positional[0];
  const wave = positional[1];
  if (!sessionId || wave === undefined) {
    fail("usage: <session-id> <wave> [--token-budget <n>] | --record <task_id> --result passed|failed --evidence \"...\" [--merged] [--model <tier>] [--blocker \"...\"] [--tokens <n>] | --summary");
  }

  assertSessionId(sessionId);
  assertWave(wave);
  if (opts.record !== undefined) assertTaskId(opts.record);

  if (flags.has("summary")) {
    modeSummary(sessionId, wave);
    return;
  }

  if (opts.record !== undefined) {
    modeRecord(sessionId, wave, opts.record, opts, flags);
    return;
  }

  modeGenerate(sessionId, wave, opts);
}

main();
