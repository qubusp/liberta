---
layout: doc
title: Verification and merge gates
summary: Why a producer's own say-so never marks a task done, and what has to be clean before a wave merges.
description: Independent verification, the git-flow policy fields, merge_policy auto_on_signoff, the deploy guardrail, and the controller's hard rules.
sources: skills/liberta/SKILL.md
---

A task is `passing:true` only on captured, independent evidence — never on
the producer's own say-so. The independent auditor did not write the change,
re-runs the verify step itself from a clean state, and trusts only what it
personally reproduces.

## Git-flow, read from `goal.md`

- **`base_branch`** — defaults to the repository's mainline. The run branch
  `liberta/<session-id>` is cut from here at setup; nothing lands directly on
  `base_branch`.
- **Waves.** Tasks share a `wave` label from the planner. A finished,
  verified wave gets exactly one PR against `base_branch`.
- **`stop_after`** — default none. A named wave or task, or `first_pr` (stop
  the instant the first PR opens, before any further work), forces a human
  checkpoint instead of continuing unattended.
- **`merge_policy`** — default `auto_on_signoff`.

## The two merge policies

Once every task in a wave is done and verified, a PR is opened against
`base_branch` with a body written by the chronicler. Then:

- **`auto_on_signoff`** requires a green build and tests (already required
  for any task to be done at all), a clean code-review pass on the diff, and
  QA passing, before the wave merges on its own. On a clean pass the PR is
  squash-merged, the merge is notified, the local `base_branch` advances, and
  the next wave is branched off it. If either reviewer withholds, the PR is
  left open, the fixes are filed as tasks, and the run keeps going — or stops
  and notifies if it is stuck.
- **`none`** leaves every PR for a human.

Neither policy overrides the deploy guardrail: `allow_deploy` still gates
anything irreversible.

## Visual tasks

For a `style` task, or any task whose verify kind is `visual`, `wave-exec`
requires screenshots at a wide and a narrow viewport plus a non-regressing
accessibility score, from **both** the producer and the independent auditor.
"Could not render" is a failure, not a pass by default, and a `style` task
always gets a stylist review even if the plan did not ask for one.

## The controller's hard rules

- Never implement a task itself. Dispatch through `wave-exec`, which routes
  by role. Never hand-pick a producer, never batch tasks into one dispatch.
- A task is `passing:true` only on captured, independent evidence.
- Never weaken a gate, delete a task, or reverse a rejection just to show
  progress.
- Any deploy or irreversible step stops and notifies unless
  `goal.md`'s `allow_deploy` is true.
- On resume, orient entirely from `state.json` plus `git log` — never from
  memory of an earlier session.
