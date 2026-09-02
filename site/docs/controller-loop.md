---
layout: doc
title: The controller loop
summary: How a run advances - mode selection, SETUP, LOOP, TERMINAL, and the wave-execution contract.
description: The Liberta controller does bookkeeping and dispatch, never implementation. This page covers SETUP, LOOP, TERMINAL, waves and the task board.
sources: skills/liberta/SKILL.md
---

The controller's job is bookkeeping and dispatch, never implementation.
Every real unit of work goes to a fresh subagent with clean context; the
controller reads back its verdict, persists state to disk, and decides
whether to continue, escalate, or stop. This keeps the controller's own
context flat regardless of how long the run goes, and means a crash or
context reset never loses progress - everything that matters is already on
disk.

## Step 0 - pick a mode

- A bare `status`, `--status`, or `/liberta` with no goal text is the
  **status path**, not a run. See [Checking status]({{ '/docs/status/' | relative_url }}).
- `--resume <session-id>`, or an `index.json` whose `active_session_id`
  points at a `running` session: go straight to **LOOP** for that session.
- Otherwise this is a new goal: go to **SETUP**.

## SETUP - once per new run

1. Resolve the target project directory (`--project`, else inferred from the
   goal text, else ask once).
2. Detect the stack and write `project.json`: find the git root; look for
   `package.json`, `pyproject.toml`, `*.csproj`/`.sln`, `Cargo.toml`,
   `go.mod`, `Dockerfile` or `playwright.config.*`, and record the matching
   build/test/lint commands as this project's verify suite. Read the
   project's own docs convention so the chronicler knows where to write the
   final report.
3. Pick a profile: `dev` (build/test/browser-check as ground truth) or
   `research` (pre-registration and holdout discipline). `--profile`
   overrides the guess.
4. Write `goal.md`: the goal verbatim, acceptance criteria, profile, a budget
   (`max_iterations`, `max_tokens`, `wall_deadline`), `allow_deploy`
   (default false), and any git-flow policy named in the goal text.
5. Dispatch the planner to turn the goal into `plan.json` - a flat list of
   tasks, each with a `role`, a `wave` number for ordering, `depends_on` for
   same-wave ordering, and a concrete `verify` step. Every task starts
   `status:"pending"`. For a research profile the planner also writes the
   pre-registration before any out-of-sample work happens.
6. Write `state.json` (`iteration:0`, the budget copied from `goal.md`,
   `status:"running"`) and register the session in `index.json`. Both files
   carry `parent_session_id` and must agree.
7. If `base_branch` is set, branch: `git -C <root> checkout -b
   liberta/<session-id> <base_branch>`. All work lands there, never directly
   on `base_branch`.
8. Fall through to LOOP.

## LOOP - one wake advances the current wave

**0. Drain the inbox first**, before even the budget check. Empty is normal.
Otherwise, per message: a `steer` is folded into this wake (re-planning if it
changes the task board); a `question` is answered from state on disk only,
never by spawning a subagent; an `info` is noted in `state.json` and
acknowledged. A steer never weakens a gate, deletes a task, or reverses a
rejection.

**1. Budget guard.** If `iteration >= max_iterations`, or
`tokens_spent >= max_tokens`, or now is past `wall_deadline`, the run is
`budget_exhausted` and goes to TERMINAL.

**2. Stop check.** All tasks done and passing → `done`. Research profile and
converged → `converged`. `stuck_counter >= 3` → `stuck`. Any of these goes
to TERMINAL.

**3. Pick the current wave.** The lowest-numbered wave with incomplete tasks
whose prior waves are already merged. If a task looks too large for one
dispatch, the planner splits it and the wave is re-picked.

**4. Run the wave.** `scripts/wave-exec.js` gives every task in the wave its
own git worktree, dispatches each to its role's producer concurrently
(respecting `depends_on` within the wave), and pipes each one through
verify → gates → QA independently, so a fast task reaches QA while a slow one
is still building.

Everything goes through `wave-exec`, including remediation passes. The
controller never hand-dispatches a producer and never bundles several tasks
into one "just fix these" dispatch - both paths skip role-based routing and
skip the gates.

**5. Record the wave.** Each passed task's branch is merged into the wave
branch in dependency order; a conflict spawns a builder to reconcile against
the updated branch. Per task: `done` plus `passing:true` plus evidence on a
pass, otherwise `attempts++` and `blocked`/`pending`. Token spend is added to
`tokens_spent` and `iteration` increments. If nothing new passed this wave,
`stuck_counter` increments, otherwise it resets to 0.

**6. Periodic tidy.** Every fifth iteration, the janitor runs on the wave
branch to keep the tree merge-ready - no behaviour change, just dead code,
formatting and obvious duplication.

**7. Wave PR, merge, checkpoint.** Once every task in the wave is done and
verified, one PR is opened against `base_branch`, with a body written by the
chronicler. See [Verification and merge gates]({{ '/docs/verification/' | relative_url }}).

**8. Continue or stop.** Re-check the stop conditions. Terminal goes to
TERMINAL; otherwise the run schedules its next wake, or reports status and
stops when supervised.

## TERMINAL

1. The janitor does a final tidy.
2. The chronicler writes the final report and updates the project's own log,
   using the terminal `status`.
3. A push notification carries the outcome - "done", "stuck on `<task>`",
   "budget exhausted", "converged: no defensible result", or "awaiting deploy
   approval".
4. `index.json` is updated.

## The wave-execution contract

`wave-exec` reads `plan.json`, `project.json` and `goal.md` for the given
session and wave, and:

- gives each task its own git worktree off the wave branch, so concurrent
  producers can never step on each other's edits;
- routes by `role`; an unrecognised role falls back to the builder and is
  reported in `role_warnings` rather than silently passing;
- for a `style` task, or any task whose verify kind is `visual`, requires
  screenshots at a wide and a narrow viewport plus a non-regressing
  accessibility score, from both the producer and the independent auditor -
  "could not render" is a failure, not a pass by default;
- runs each producer on the task's assigned model tier and escalates one tier
  on a verify failure, retrying once before marking it blocked;
- pipelines each task through produce → verify → gates → QA independently, with
  no wave-wide barrier;
- merges passed branches into the wave branch one at a time, in dependency
  order;
- logs every dispatch and verdict to the event log;
- stays within the run's remaining token budget and returns total spend.

It returns `[{task_id, passed, model_used, evidence, branch, merged, blocker}]`.
The controller records these and never re-runs an already-merged task.

## Concurrency across sessions

Branch and worktree names created by `wave-exec` always include the session
id (`liberta/<session-id>-wave<n>`, plus `-task-<task-id>` per task), so two
sessions driving the same target repository at once can never name, reuse or
delete each other's branches or worktrees. Worktree removal is fenced to
paths inside the session's own wave directory, and no session ever prunes or
removes another session's worktree or branch. `git worktree prune` is never
run anywhere in this codebase, on purpose: it is a repo-wide operation that
would silently deregister another live session's worktree registration, so
cleanup always targets only the current session's own paths instead. See
[Concurrency and parallel sessions]({{ '/docs/concurrency/' | relative_url }})
for the full guarantees this run establishes.
