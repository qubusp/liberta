---
layout: doc
title: Checking status
summary: /liberta status prints a progress table and stops — no subagent, no model call, nothing written.
description: How /liberta status works, what it prints, and why it is strictly read-only.
sources: README.md and skills/liberta/SKILL.md
---

`/liberta status` — also `--status`, or `/liberta` with no goal text — prints
a progress table for the active run and stops. Nothing else.

It runs `scripts/_status.mjs` directly: no subagent is dispatched, no plan is
regenerated, no model is called, and nothing on disk is touched. It just reads
`~/.claude/liberta-runs/` and prints, so it feels instant even mid-run.

Pass a session id to look at a different run, or `--all` to list every session
known to the harness.

The status path is strictly read-only. `_status.mjs` must never be allowed to
mutate `plan.json`, `state.json`, `index.json` or `events.jsonl` — in
particular, no "status viewed" event is logged for this path. This is the same
discipline already applied to inbox `question` messages, which are answered
from state on disk only, never by spawning a subagent just to report a table.

## What it prints

```
$ node scripts/_status.mjs <session-id>
session:   liberta-chat-pixelart-2026-08-28
status:    running
profile:   dev
iteration: 4/12
tokens:    1980000/3000000
deadline:  2026-08-29T01:00:00Z
branch:    liberta/liberta-chat-pixelart-2026-08-28  project: /Users/qubusp/liberta

ID   W  ROLE     STATUS   PASS  ATT  SUMMARY
t1   1  operate  done     yes   0    Screenshot/login harness (puppeteer-core) for all visual ...
t2   2  build    done     yes   0    Auth-gated inbox API routes over scripts/_mailbox.mjs
...

TOTAL 29  done=14  pending=15  blocked=0  failed=0
per-wave: w1:2/2 w2:4/4 w3:8/9 w4:0/6 w5:0/2 w6:0/3 w7:0/1 w8:0/1 w9:0/1

inbox: 0 pending
```
{: tabindex="0"}

The header lines come from `state.json` and `goal.md`; the task rows and the
per-wave tally come from `plan.json`; the inbox count comes from the run's
`inbox/` directory.
