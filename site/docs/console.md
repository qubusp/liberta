---
layout: doc
title: The console
summary: The small authenticated dashboard over a run -- its status states, its chat window, its auth model, its insecure-by-default password, and its read-cache database.
description: The Liberta console is a Node/Express dashboard showing which sessions exist, which is active, its task board and a tail of its event log, behind a login that falls back to an insecure built-in default password unless LIBERTA_CONSOLE_PASSWORD is set.
sources: console/README.md and README.md
---

`console/` is a small Node/Express app that reads the session store
(`~/.claude/liberta-runs/`) and shows, live, which sessions exist, which one
is active, its current task board, and a tail of its event stream -- the
"which session is working" view.

It sits behind a login, since the session store can contain repo paths, task
descriptions and other detail you may not want exposed to anyone who finds
the URL.

```
cd console
npm install
LIBERTA_CONSOLE_PASSWORD='pick something' npm start
# → http://localhost:4177
```
{: tabindex="0"}

Or with no password env at all:

```
cd console
npm install
npm start
# → http://localhost:4177
```
{: tabindex="0"}

Override the port with `PORT`. `LIBERTA_CONSOLE_PASSWORD` is an optional
override, not a requirement: if it is unset or empty, the server falls back
to the built-in default password, `libert@123!`, instead of refusing to
start.

**That default is insecure and is meant only for a quick local,
single-operator install** -- it is public (it's printed right here), the
same for every install, and the server binds `0.0.0.0` by default, so
anyone else on the same network can reach the login page and try it.
Whenever the default is in effect, the server prints a warning to stderr at
boot. Set `LIBERTA_CONSOLE_PASSWORD` to a real secret for anything durable
or reachable over a network.

## Running a second console

A second console started on a `PORT` that is already taken exits with a
one-line `FATAL:` message naming the port, rather than crashing with a raw
`EADDRINUSE` stack trace. Setting `LIBERTA_CONSOLE_PORT_AUTO=1` makes it
scan upward from `PORT` instead, for up to 20 ports, and log which one it
actually bound -- useful for running several consoles side by side, e.g.
one per test run.

Two more overrides matter once more than one instance is running:

- `LIBERTA_CONSOLE_DB=/some/path.sqlite` forces this instance's sqlite
  mirror to that exact file. Two instances must never share one sqlite
  file unless this is set deliberately on both: the background sync loop
  reaps any row whose subject is absent from the run store it is
  currently syncing, so two instances sharing a file would each erase the
  other's rows on every sync tick.
- `LIBERTA_RUNS_DIR=/some/throwaway/dir` points this instance at a
  different run store entirely, instead of the real operator store at
  `~/.claude/liberta-runs/`. **This exists for tests and other throwaway,
  disposable invocations, not for production use** -- pointing a
  production console at the wrong store means it shows the wrong runs.

Worked example, two independent consoles on one machine:

```
PORT=4177 LIBERTA_RUNS_DIR=/tmp/liberta-run-a LIBERTA_CONSOLE_PASSWORD='a' npm start &
PORT=4178 LIBERTA_RUNS_DIR=/tmp/liberta-run-b LIBERTA_CONSOLE_PASSWORD='b' npm start &
```
{: tabindex="0"}

The first instance's sqlite mirror lands at
`/tmp/liberta-run-a/console-data/liberta-4177.sqlite`, the second's at
`/tmp/liberta-run-b/console-data/liberta-4178.sqlite` -- see "Database"
below for the file's naming rules, and
[Concurrency and parallel sessions]({{ '/docs/concurrency/' | relative_url }})
for the full audit of every place two Liberta processes can otherwise
collide on one machine.

## Status states

Every run and every task shows its status as a pill. The console colours it
by group, using the same palette as the rest of the interface:

<ul class="pill-legend">
  <li><span class="status-pill status-running">running</span> <span class="pill-note">also <code>in_progress</code> -- the informational blue</span></li>
  <li><span class="status-pill status-done">done</span> <span class="pill-note">also <code>completed</code>, <code>succeeded</code></span></li>
  <li><span class="status-pill status-failed">failed</span> <span class="pill-note">also <code>error</code>, <code>blocked</code></span></li>
  <li><span class="status-pill status-pending">pending</span> <span class="pill-note">also <code>queued</code>, <code>waiting</code></span></li>
  <li><span class="status-pill status-unknown">unknown</span> <span class="pill-note">any status outside the groups above</span></li>
</ul>

A session that is actively working gets an extra, deliberately
low-resolution pixel-art treatment so the eye lands on it: a square-cornered
pixel-framed status pill with a marching loader bar, a pixel energy rail down
the left edge of its row, and a pixel hourglass sprite in the detail header.
Every one of those is a pseudo-element, so it contributes no text and no
accessible name -- the status word itself is untouched -- and all of the motion
stops under `prefers-reduced-motion`.

The statuses the harness itself writes into a run's `state.json` are
`running` plus the terminal ones: `done`, `converged`, `budget_exhausted`,
`stuck` and `checkpoint`. See
[Stopping and budget]({{ '/docs/stopping/' | relative_url }}).

## The chat window

A run's detail view has a **Chat** tab. Messages sent from it land directly
in that run's inbox -- the same `steer` / `question` / `info` files the
controller reads and replies to when it drains the inbox at the start of a
wake.

**This is not a chatbot.** No model is called from the chat window; replies
only appear once the controller has actually processed the message.

The form has a message-type selector (`steer`, `question` or `info`) and a
message box. The conversation thread is marked up as a live log region, so a
reply that arrives while you are reading is announced rather than appearing
silently.

## Auth model

- Single-operator tool: one shared password, no username, no accounts.
- On success the server issues a signed, `httpOnly`, `SameSite=Lax` cookie -- a random session id plus expiry, HMAC-SHA256'd with a server-side secret.
  Sessions expire after 12 hours.
- Login attempts are rate-limited per IP with an in-memory sliding window, 10
  attempts per minute.
- Every route other than `/login` and `/logout` -- the dashboard HTML and every
  `/api/*` JSON endpoint -- runs through one global auth middleware. A missing,
  invalid or expired cookie redirects HTML requests to `/login` and returns
  `401 {"error": "unauthorized"}` for `/api/*`.
- `GET /api/sessions/:id` validates `:id` against a strict allowlist and
  additionally confirms the resolved path is still inside the session-store
  directory before touching the filesystem, to rule out path traversal.

GitHub OAuth is available as an optional *second* way to log in. It is off by
default, and the login page is unchanged until it is configured. When it is
enabled, `LIBERTA_ALLOWED_GITHUB_USERS` -- a comma-separated allowlist of
usernames -- is required, and the server fails loudly at boot without it:
OAuth alone only proves "this is a real GitHub account", not "this account
should have access to this console".

## Database

The console reads `/api/sessions` and `/api/sessions/:id` from a SQL database
via Knex rather than hitting the filesystem on every request. **That database
is a read cache, not the source of truth.** A background sync loop reads
`index.json` plus each session's `state.json`, `plan.json` and
`events.jsonl` and upserts into the `runs`, `tasks` and `events` tables. The
harness still writes those files directly and is completely unaware the
database exists. If a run was just created and the sync loop has not caught up
yet, `GET /api/sessions/:id` falls back to reading the files directly for that
one request.

Two backends, picked with `DB_CLIENT`: `sqlite3` (the default, a local file,
gitignored and never committed) and `pg`, which additionally requires
`DATABASE_URL` and fails loudly on boot without it rather than silently
falling back.

The sqlite file's path depends on port and store, resolved in this order:
an explicit `LIBERTA_CONSOLE_DB=/some/path.sqlite` always wins; otherwise,
if `LIBERTA_RUNS_DIR` is set, the file lives inside a `console-data/`
subdirectory of that run store, named `liberta-<port>.sqlite` (i.e.
`<LIBERTA_RUNS_DIR>/console-data/liberta-<port>.sqlite`); otherwise it is
`console/data/liberta.sqlite` on the canonical default port 4177
(byte-identical to existing installs), or `console/data/liberta-<port>.sqlite`
for any other port. See "Running a second console" above.

## The skills library

The console has a second, database-managed "skills library", separate from the
on-disk harness files. It is a staging, reference and override layer for the
console UI only, and it never changes what the actual harness controller or
subagents execute.

- **Library.** On first boot, if the table is empty, it is seeded once from
  `skills/liberta/SKILL.md` and every `agents/*.md` file. Restarts never
  re-seed it, so later hand-edits made through the UI are never clobbered.
  Editing a library skill only updates its row in the database -- it does not
  write back to `skills/` or `agents/` on disk. Only imported skills can be
  deleted; built-in ones can be edited but not removed.
- **Per-run overrides.** A run's "Skills for this run" tab can override any
  library skill for that one run, which is useful for experimenting with a
  modified prompt without touching the shared library other runs see. Reverting
  puts that run back on the library version.
- **Import.** A new skill can be added to the library with a name, a kind
  (`controller` or `agent`), content and a description; `source` is forced to
  `imported` server-side, and a name collision is refused.

## Deliberately minimal -- not for public exposure

This is built for local, single-operator use: you, on your own machine or a
private network, checking on a run. **Do not expose it directly to the public
internet.** A single shared password, a hand-rolled signed cookie and no TLS
termination in the process itself are adequate for a personal tool behind your
own firewall, not for an internet-facing service. If you need remote access,
put a real reverse proxy with real TLS in front of it and treat this app's own
auth as a second layer, not the only one.
