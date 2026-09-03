---
layout: doc
title: The session store
summary: Every file a run keeps on disk, what it is for, and the append-only event log.
description: The layout of ~/.claude/liberta-runs/ - goal.md, project.json, plan.json, state.json, ledger.csv, events.jsonl, inbox/ and waves/ - and how events are logged.
sources: skills/liberta/SKILL.md
---

All bookkeeping lives outside the target project, under a global directory
that is never committed:

```
~/.claude/liberta-runs/index.json           {active_session_id, sessions:[{id, project_path, status, parent_session_id}]}
~/.claude/liberta-runs/<session-id>/
    goal.md          the goal, acceptance criteria, profile, budget, git-flow policy
    project.json      detected stack + verify commands for the target repo
    plan.json         the task board: [{id, role, wave, depends_on, verify, status, ...}]
    state.json        {iteration, tokens_spent, wall_deadline, status, stuck_counter, notes, parent_session_id}
    ledger.csv        one row per completed task: id, role, model, outcome, tokens
    events.jsonl       append-only activity stream (see below)
    inbox/             steer/question/info messages dropped in from outside the run
    waves/<n>/         per-wave working notes and captured evidence
```
{: tabindex="0"}

`<session-id>` is `<project-slug>-<goal-slug>-<date>`.

Actual code changes land in the target project's own git history; the
session store is pure bookkeeping and stays out of that repo entirely. Because
plan, progress, budget and the event log are all on disk, a run survives a
context reset, a machine sleep or a crash and picks up exactly where it left
off. On resume the controller orients entirely from `state.json` plus
`git log`, never from memory of an earlier session.

## What each file is for

**`index.json`** - the registry across all runs: which session is active, and
for each session its id, project path, status and `parent_session_id`.

**`goal.md`** - the goal verbatim, acceptance criteria, the profile
(`dev` or `research`), the budget (`max_iterations`, `max_tokens`,
`wall_deadline`), `allow_deploy` (default false), and any git-flow policy
named in the goal text (`base_branch`, `stop_after`, `merge_policy`).

**`project.json`** - the detected stack and this project's verify suite,
written at setup by looking for `package.json`, `pyproject.toml`,
`*.csproj`/`.sln`, `Cargo.toml`, `go.mod`, `Dockerfile` or
`playwright.config.*` and recording the matching build, test and lint
commands.

**`plan.json`** - the task board. A flat list of tasks, each with a `role`, a
`wave` number for ordering, `depends_on` for same-wave ordering, a concrete
`verify` step, and a `status` that starts as `pending`.

**`state.json`** - the run's live counters: `iteration`, `tokens_spent`,
`wall_deadline`, `status`, `stuck_counter`, `notes` and
`parent_session_id`. It is authoritative for lineage; the `index.json` entry
is the convenience copy, and the two must agree - `null` for a fresh root
run, or the mother run's session id for a fork.

**`ledger.csv`** - one row per completed task: id, role, model, outcome,
tokens.

**`events.jsonl`** - the append-only activity stream (below).

**`inbox/`** - `steer`, `question` and `info` messages dropped in from
outside the run. The controller drains it at the start of every wake, before
even the budget check. Inbox files are never deleted or moved by hand: a
message that reappears next wake means a reply crashed mid-drain, and
handling it again is safe.

**`waves/<n>/`** - per-wave working notes and captured evidence.

## The event log

One line is appended to `<session-id>/events.jsonl` at every state
transition, always through the helper script - never by hand, and a logging
failure never blocks the loop (it is logged once and the run moves on):

```
node ~/.claude/liberta-runs/_log-event.mjs <session-id> <type> <from> <to> "<summary>" [--task <id>] [--wave <n>] [--status <run-status>]
```
{: tabindex="0"}

Events are logged at session creation, plan written, task picked, subagent
dispatched, verify/gate/QA verdicts (the summary starts PASS or FAIL), task
finished, periodic cleanup, PR opened or merged, checkpoint reached, final
notification, and session stopped.

`--status` additionally rewrites the run's status in both `index.json` and
`state.json`, so it is always passed on a status change and those two files
never drift apart.

## Concurrency

More than one session can be live at once, on the same machine and against
the same project. `index.json` is shared across every session, so any
read-modify-write of it (registering a session, changing its status) takes
an advisory lock file, `index.json.lock`, next to it, and re-reads the index
fresh inside that lock before writing back; a lock is only taken over as
stale once it is older than 30 seconds and its recorded pid is no longer
alive, never while the holder is still running. Each session's own
`state.json` is guarded the same way. `active_session_id` is a single slot:
it is the session the CLI defaults to when none is named, not a list of
every running session, so with several sessions live, pass a session id or
use `--all` rather than relying on it. `events.jsonl` and `inbox/` are
per-session directories and are already safe under concurrent writers -
`events.jsonl` because it is append-only, inbox files because their names
are session scoped. See
[Concurrency and parallel sessions]({{ '/docs/concurrency/' | relative_url }})
for the full audit.
