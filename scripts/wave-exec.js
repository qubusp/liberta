#!/usr/bin/env node
// Linda wave-execution dispatch-plan generator + recorder.
//
// This script never spawns a subagent itself (only the calling Claude Code
// controller session can do that via its own Task tool) -- it is a planning
// / bookkeeping helper with three modes, all keyed on a session id and a
// wave number read from ~/.claude/linda-runs/<session-id>/{plan.json,
// project.json,goal.md}:
//
//   1. GENERATE (default):
//        node wave-exec.js <session-id> <wave> [--token-budget <n>]
//      Selects every plan.json task whose wave matches, creates one git
//      worktree per task off the wave branch (linda/<session-id>-wave<n>,
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
//      exits non-zero telling the controller to spawn a linda-builder to
//      reconcile.
//
//   3. SUMMARY (once every dispatched task has a recorded result):
//        node wave-exec.js <session-id> <wave> --summary
//      Prints the final [{task_id, passed, model_used, evidence, branch,
//      merged, blocker}] verdict list plus role_warnings and total token
//      spend as JSON to stdout, then tears down every worktree created for
//      this wave (git worktree remove), regardless of outcome.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

function fail(msg) {
  process.stderr.write(`wave-exec: ${msg}\n`);
  process.exit(1);
}

function runsRoot() {
  return path.join(os.homedir(), ".claude", "linda-runs");
}

function sessionDir(sessionId) {
  return path.join(runsRoot(), sessionId);
}

function waveDir(sessionId, wave) {
  return path.join(sessionDir(sessionId), "waves", String(wave));
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
  build: "linda-builder",
  style: "linda-stylist",
  analyze: "linda-analyst",
  scout: "linda-scout",
  operate: "linda-operator",
};

function normalizeRole(raw) {
  if (!raw) return "";
  let r = String(raw).trim().toLowerCase();
  r = r.replace(/^linda[-_]/, "");
  r = r.replace(/[-\s]+/g, "_");
  return r;
}

function resolveProducer(rawRole) {
  const norm = normalizeRole(rawRole);
  if (ROLE_TABLE[norm]) return { role: norm, producer: ROLE_TABLE[norm], warned: false };
  return { role: norm || rawRole, producer: "linda-builder", warned: true };
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

function ensureWaveBranch(gitRoot, waveBranch, baseBranch) {
  if (branchExists(gitRoot, waveBranch)) return;
  const base = baseBranch || currentBranch(gitRoot);
  git(gitRoot, ["branch", waveBranch, base]);
}

function currentBranch(gitRoot) {
  return git(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

function worktreeAdd(gitRoot, worktreePath, branch, startPoint) {
  if (fs.existsSync(worktreePath)) return; // idempotent
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  if (branchExists(gitRoot, branch)) {
    git(gitRoot, ["worktree", "add", worktreePath, branch]);
  } else {
    git(gitRoot, ["worktree", "add", "-b", branch, worktreePath, startPoint]);
  }
}

function worktreeRemove(gitRoot, worktreePath) {
  if (!fs.existsSync(worktreePath)) return;
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

  const waveBranch = `linda/${sessionId}-wave${wave}`;
  const baseBranch = goal.base_branch || currentBranch(gitRoot);
  ensureWaveBranch(gitRoot, waveBranch, baseBranch);

  const wdir = waveDir(sessionId, wave);
  const worktreesRoot = path.join(wdir, "worktrees");

  const roleWarnings = [];
  const entries = [];

  for (const task of waveTasks) {
    const { role, producer, warned } = resolveProducer(task.role);
    if (warned) {
      roleWarnings.push({ task_id: task.id, role: task.role });
    }
    const worktreePath = path.join(worktreesRoot, String(task.id));
    const taskBranch = `${waveBranch}-task-${task.id}`;
    worktreeAdd(gitRoot, worktreePath, taskBranch, waveBranch);

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

// --- mode: record a task result -------------------------------------------

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
  const waveBranch = (dispatchPlan && dispatchPlan.wave_branch) || `linda/${sessionId}-wave${wave}`;
  const taskBranch = (dpEntry && dpEntry.branch) || `${waveBranch}-task-${taskId}`;

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
      const depsMerged = dependsOn.every((depId) => {
        const r = state.results[depId];
        return r && r.passed && r.merged;
      });
      if (!depsMerged) {
        merged = false;
        blocker = blocker || "awaiting dependency merge";
      } else {
        try {
          merged = mergeTaskBranch(gitRoot, waveBranch, taskBranch);
        } catch (err) {
          saveWaveState(sessionId, wave, state);
          log(sessionId, "wave_merge_conflict", "merging", "blocked", `conflict merging ${taskBranch} into ${waveBranch}`, {
            task: taskId,
            wave,
          });
          fail(
            `merge conflict merging ${taskBranch} into ${waveBranch}: ${err.message}\n` +
              `Conflict markers left in place in ${gitRoot} (branch ${waveBranch}). ` +
              `Spawn a linda-builder to reconcile, then re-run --record with --merged.`
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

function mergeTaskBranch(gitRoot, waveBranch, taskBranch) {
  // Perform the merge in a dedicated worktree checked out to the wave
  // branch, so this never disturbs whatever the caller's cwd/HEAD is.
  const mergeWt = path.join(
    os.tmpdir(),
    `linda-wave-merge-${path.basename(gitRoot)}-${waveBranch.replace(/[/\\]/g, "_")}`
  );
  if (fs.existsSync(mergeWt)) {
    try {
      git(gitRoot, ["worktree", "remove", "--force", mergeWt]);
    } catch {
      // ignore, will try to reuse/overwrite below
    }
  }
  fs.mkdirSync(path.dirname(mergeWt), { recursive: true });
  git(gitRoot, ["worktree", "add", mergeWt, waveBranch]);
  try {
    git(gitRoot, ["merge", "--no-ff", "--no-edit", taskBranch], { cwd: mergeWt });
    return true;
  } catch (err) {
    // Leave conflict markers in place -- do not abort. Re-throw so the
    // caller can report and exit non-zero; the worktree with the conflict
    // stays on disk at mergeWt for a linda-builder to reconcile.
    throw err;
  } finally {
    if (!hasConflict(mergeWt)) {
      try {
        git(gitRoot, ["worktree", "remove", "--force", mergeWt]);
      } catch {
        // best-effort cleanup only
      }
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
      worktreeRemove(gitRoot, e.worktree_path);
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
