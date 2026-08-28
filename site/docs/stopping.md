---
layout: doc
title: Stopping and budget
summary: The budget model, every terminal condition, and the deploy guardrail.
description: Liberta's stopping rules — done, converged, budget_exhausted, stuck and checkpoint — and the iteration, token and wall-clock budget checked on every wake.
sources: skills/liberta/SKILL.md and README.md
---

Every run has a maximum iteration count, token budget and wall-clock
deadline. When any of them trips, or the plan completes, or progress stalls
for several iterations in a row, the run stops and notifies rather than
grinding on.

## The budget

`goal.md` carries `max_iterations`, `max_tokens` and `wall_deadline`, copied
into `state.json` at setup alongside `iteration:0`. The budget guard is the
first thing checked on every wake, immediately after the inbox is drained:

- `iteration >= max_iterations`, or
- `tokens_spent >= max_tokens`, or
- now is past `wall_deadline`

Any of those sets the run's status to `budget_exhausted` and goes to TERMINAL.

`iteration` increments once per wave recorded. `wave-exec` stays within the
run's remaining token budget and returns its total spend, which is added to
`tokens_spent`.

## The stopping rules

**`done`** — every task is `done` and `passing`.

**`converged`** — research profile only. The best result improved under 2%
over the prior best, the comparison-to-null margin did not meaningfully move
either, and either the hypothesis space is exhausted or the null-hunter
rejected the current best.

**`budget_exhausted`** — checked first, every wake: the iteration cap, the
token cap, or the wall-clock deadline.

**`stuck`** — three consecutive iterations with nothing newly passing and no
improvement in the tracked metric. `stuck_counter` increments on a wave where
nothing new passed and resets to 0 otherwise.

**`checkpoint`** — `goal.md`'s `stop_after` was reached. This is a deliberate
human-review gate: the run stops and notifies even with tasks remaining.
`stop_after` can name a wave or task, or be `first_pr`, which stops the
instant the first PR opens, before any further work.

A stop or pause request arriving in the inbox as a `steer` is replied to, and
then sets `checkpoint` and goes to TERMINAL.

## The deploy guardrail

Any deploy or irreversible step stops and notifies unless `goal.md`'s
`allow_deploy` is true — and `merge_policy` never overrides this. An
`operate` task that would deploy or migrate without `allow_deploy` set stages
the change only and returns `awaiting-deploy-approval`.

## What happens at TERMINAL

The janitor does a final tidy; the chronicler writes the final report and
updates the project's own log using the terminal status; a push notification
carries the outcome — "done", "stuck on `<task>`", "budget exhausted",
"converged: no defensible result", or "awaiting deploy approval" — and
`index.json` is updated.
