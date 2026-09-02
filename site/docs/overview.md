---
layout: doc
title: Overview
summary: What Liberta is, the failure modes it is shaped around, and where each piece lives in the repository.
description: Liberta is an unattended, long-running orchestration harness for Claude Code - a thin controller loop on disk that dispatches fresh-context specialist subagents and verifies each result independently.
sources: README.md
---

Liberta is an unattended, long-running orchestration harness for Claude
Code. Give it a goal and a project, and it keeps a thin controller loop
alive on disk, farming every real unit of work out to fresh-context
specialist subagents, double-checking each one independently before it
counts as done, and stopping (with a notification) on a clear terminal
condition instead of silently running forever or claiming victory early.

It is MIT licensed - use it, fork it, sell it, whatever.

## The failure modes it closes off

Long-horizon autonomous coding sessions fail in a small number of
predictable ways: the agent tries to do everything in one giant turn, its
context fills up and it loses the plot, it leaves work half-finished because
nothing forces it to check, or it declares success without real evidence
that anything passed. Liberta's structure exists specifically to close off
each of those.

**One task, one fresh subagent.** The controller (`skills/liberta`) never
implements anything itself - it reads a task off a plan, hands it to the
right specialist, and reads back a verdict. Context never accumulates past a
thin bookkeeping layer.

**Independent verification.** A task is not "done" until a second, separate
agent - one that did not write the change - reproduces the evidence that it
works.

**Durable state on disk.** Plan, progress, budget, and an append-only event
log live in a session store outside the target repo, so a run survives a
context reset, a machine sleep, or a crash and picks up exactly where it
left off.

**A hard budget and explicit stop conditions.** Every run has a maximum
iteration count, token budget, and wall-clock deadline. When any of them
trips, or the plan completes, or progress stalls for several iterations in a
row, the run stops and notifies rather than grinding on.

## Layout of the repository

```
skills/liberta/SKILL.md   the controller - a Claude Code skill, invoked as /liberta "<goal>"
agents/*.md              the specialist roster (planner, builder, auditor, qa, ...)
scripts/*.mjs            session-store helpers: event log, message inbox
scripts/wave-exec.js     runs one wave of a plan's tasks concurrently, in isolated worktrees
console/                 a small authenticated web UI showing live session status
```
{: tabindex="0"}

One target repository per run. A goal spanning multiple repos should be
split into one run per repo.

Actual code changes land in the target project's own git history; the
session store is pure bookkeeping and stays out of that repo entirely.

## Concurrency

More than one Liberta session can run at once, on the same machine and even
against the same target repository. The run registry, per-session state and
git branch/worktree naming are all designed for that. See
[Concurrency and parallel sessions]({{ '/docs/concurrency/' | relative_url }})
for the full guarantees this run establishes.
