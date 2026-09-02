# Liberta

An unattended, long-running orchestration harness for Claude Code. Give it a
goal and a project, and it keeps a thin controller loop alive on disk,
farming every real unit of work out to fresh-context specialist subagents,
double-checking each one independently before it counts as done, and
stopping (with a notification) on a clear terminal condition instead of
silently running forever or claiming victory early.

MIT licensed - use it, fork it, sell it, whatever. See [LICENSE](LICENSE).

## Why

Long-horizon autonomous coding sessions fail in a small number of
predictable ways: the agent tries to do everything in one giant turn, its
context fills up and it loses the plot, it leaves work half-finished because
nothing forces it to check, or it declares success without real evidence
that anything passed. Liberta's structure exists specifically to close off
each of those:

- **One task, one fresh subagent.** The controller (`skills/liberta`) never
  implements anything itself - it reads a task off a plan, hands it to the
  right specialist, and reads back a verdict. Context never accumulates
  past a thin bookkeeping layer.
- **Independent verification.** A task is not "done" until a second,
  separate agent - one that did not write the change - reproduces the
  evidence that it works.
- **Durable state on disk.** Plan, progress, budget, and an append-only
  event log live in a session store outside the target repo, so a run
  survives a context reset, a machine sleep, or a crash and picks up
  exactly where it left off.
- **A hard budget and explicit stop conditions.** Every run has a maximum
  iteration count, token budget, and wall-clock deadline. When any of them
  trips, or the plan completes, or progress stalls for several iterations
  in a row, the run stops and notifies rather than grinding on.

## Layout

```
skills/liberta/SKILL.md   the controller - a Claude Code skill, invoked as /liberta "<goal>"
agents/*.md              the specialist roster (planner, builder, auditor, qa, ...)
scripts/*.mjs            session-store helpers: event log, message inbox
scripts/wave-exec.js     runs one wave of a plan's tasks concurrently, in isolated worktrees
console/                 a small authenticated web UI showing live session status
```

## Installing

```
./install.sh
```

Works on macOS and Linux. Installs the controller skill and agent roster
into `~/.claude/` (backing up anything already there before overwriting),
prepares the run-store directory, and sets up the console's dependencies.

```
./install.sh --no-console   # harness only, skip the console's npm install
./install.sh --start        # also start the console immediately, logged in
                             # with the default password libert@123!
```

The default password is insecure and meant only for local, single-operator
use. For anything durable or reachable over the network, set
`LIBERTA_CONSOLE_PASSWORD` (see below) before starting the console.

Then from any Claude Code session: `/liberta "<goal>" --project <path>`.

## The console

`console/` is a small Node/Express app that reads the session store
(`~/.claude/liberta-runs/`) and shows, live, which sessions exist, which one
is active, its current task board, and a tail of its event stream - the
"which session is working" view. It sits behind a login (see
`console/README.md`) since the session store can contain repo paths, task
descriptions, and other detail you may not want exposed to anyone who finds
the URL.

```
cd console
npm install
npm start
# → http://localhost:4177, logged in with the default password libert@123!
```

The default password is insecure, intended only for local, single-operator
use. Set `LIBERTA_CONSOLE_PASSWORD` to override it with your own value
whenever the console will run for any length of time or be reachable from
the network; when set and non-empty, it always wins over the default:

```
LIBERTA_CONSOLE_PASSWORD='pick something' npm start
```

## Checking status

`/liberta status` (also `--status`, or `/liberta` with no goal text) prints
a progress table for the active run and stops - nothing else. It runs
`scripts/_status.mjs` directly: no subagent is dispatched, no plan is
regenerated, no model is called, and nothing on disk is touched. It just
reads `~/.claude/liberta-runs/` and prints, so it feels instant even mid-run.
Pass a session id to look at a different run, or `--all` to list every
session known to the harness.

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

## The name

Liberta is named after a friend of mine who has been fighting ADHD all her
life. The name is a nod to her persistence.
