---
layout: doc
title: Agent roster
summary: The specialist subagents a run can dispatch, and what each one is for.
description: Liberta's producer roles (build, style, analyze, scout, operate) and the review roles (verifier, QA, code review, planner, chronicler, janitor, null-hunter).
sources: skills/liberta/SKILL.md and agents/*.md
---

A task's `role` field selects exactly one producer. The roster lives in
`agents/*.md`; the controller itself never implements anything.

## Producers

<div class="table-scroll" tabindex="0" role="region" aria-label="Producer roles" markdown="1">

| Role | Producer | Dispatched for |
|---|---|---|
| `build` | `liberta-builder` | general code, logic, APIs, tests, refactors |
| `style` | `liberta-stylist` | anything judged by look or feel in a browser — layout, responsiveness, theming, empty and loading states, accessibility, copy |
| `analyze` | `liberta-analyst` | data analysis, modeling, backtests, statistics |
| `scout` | `liberta-scout` | gathering and citing external information |
| `operate` | `liberta-operator` | CI, infra, containers, deploys, migrations |

</div>

**`liberta-builder`** is the default producer and the fallback for any role
that does not resolve to one of the others. Given exactly one task and a git
worktree, it implements the task, runs the project's own verify commands
itself, and reports honest evidence.

**`liberta-stylist`** is required for any task whose role is `style` or whose
verify kind is `visual`, even if the plan did not explicitly ask for a
screenshot review. It must capture and return real screenshots at a wide and
a narrow viewport plus a non-regressing accessibility check. "Could not
render" or "should look fine" without screenshots is a failure, never a pass.

**`liberta-analyst`** owns anything that results in a number, a model, or a
claim about data, and must guard against self-deception — proper holdout
discipline, and no quietly keeping the best of many variants without
correcting for the search.

**`liberta-scout`** brings external information into a run. Every claim it
produces must be traceable to a real source it actually fetched. It does not
modify the target project's code.

**`liberta-operator`** handles CI/CD, infrastructure-as-code, containers,
deploy configuration, database migrations and credential rotation. It
enforces the run's deploy guardrail: if a task would actually deploy,
migrate a live system or rotate a live credential and `goal.md`'s
`allow_deploy` is not true, the operator stages the change only and returns
`awaiting-deploy-approval` instead of carrying it out.

If `wave-exec` returns `role_warnings`, that is treated as a planning defect
— the task's `role` is fixed in `plan.json`, or the wave is re-planned. A
task is never left running on the generic builder because its role did not
resolve.

## Planning, review and upkeep

**`liberta-planner`** turns `goal.md` into `plan.json`: a flat,
dependency-ordered task list grouped into waves, each task tagged with a
producer role and a concrete verify step. It is also used any time an
existing plan needs re-planning — a steer changed scope, a task turned out
too large, or a gate filed follow-up work. For a research-profile goal it
writes the pre-registration (null hypothesis, holdout split, stopping rule)
before any out-of-sample work begins. It only plans; it never implements.

**`liberta-verifier`** is the independent auditor for a completed task. It
did not write the change under review, re-runs the task's verify step itself
from a clean state, and trusts only what it personally reproduces — never the
producer's say-so. Its verdict starts with PASS or FAIL.

**`liberta-qa`** runs after a task or a whole wave has passed independent
verification, exercising real user journeys, edge cases and error states that
a narrow verify step would not catch. It can file follow-up tasks into the
plan for bugs it finds rather than only reporting failure.

**`liberta-chronicler`** writes the human-readable record: the final report,
a wave's PR body, or a project log entry. It follows the target project's own
documentation convention rather than inventing a new one, and produces no
code changes.

**`liberta-janitor`** runs periodically — roughly every fifth iteration — and
once at the end of a terminal run, to keep the working tree merge-ready by
removing dead code, fixing formatting and collapsing obvious duplication,
without changing any behaviour. It is never dispatched against a specific
plan task.

**`liberta-null-hunter`** is the dedicated skeptic for research-profile runs.
It tries to refute a result claimed by an analyst task, defaults to
reject-if-uncertain, and checks for holdout violations, multiple-comparisons
and selection bias, and sensitivity to reasonable parameter, seed or window
changes.
