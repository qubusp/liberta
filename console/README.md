# Linda Console

A small authenticated dashboard showing, at a glance, which Linda
orchestration session(s) exist, which one is active, its current task
board, and a tail of its event log. The session store at
`~/.claude/linda-runs/` remains the source of truth (the harness itself
writes those files, unchanged) -- the console reads from a SQL
database that mirrors it, kept in sync by a background loop. See
"Database" below.

## Run it

```
cd console
npm install
LINDA_CONSOLE_PASSWORD='pick something' npm start
# → http://localhost:4177
```

Override the port with `PORT`:

```
PORT=8080 LINDA_CONSOLE_PASSWORD='...' npm start
```

Optionally set `LINDA_CONSOLE_SECRET` to a stable random string (used to
sign session cookies). If it's left unset, the server generates a random
secret at boot and warns about it -- every restart will then invalidate
all existing login sessions, since the signing key changed.

`LINDA_CONSOLE_PASSWORD` is required. The server refuses to start at all
(fails loudly on boot, non-zero exit) if it's unset or empty -- there is
no default password and no way to run this without one.

## Auth model

- Single-operator tool: one shared password, no username, no accounts.
- Login (`POST /login`) compares the submitted password against
  `LINDA_CONSOLE_PASSWORD` with `crypto.timingSafeEqual` (only ever called
  on two equal-length buffers, to avoid it throwing on a length mismatch).
- On success, issues a signed, `httpOnly`, `SameSite=Lax` cookie: a random
  session id + expiry, HMAC-SHA256'd with a server-side secret
  (`LINDA_CONSOLE_SECRET`, or a random one generated at boot -- see
  above). No session store on disk; the cookie itself carries everything
  needed to verify it, checked fresh on every request.
- Sessions expire after 12 hours.
- Login attempts are rate-limited per IP (in-memory sliding window, 10
  attempts/minute). This is safe only because the server runs as a single
  Node process with no clustering -- see the comment in `auth.js` if this
  ever needs to run behind a load balancer or multiple instances.
- Every route other than `/login` and `/logout` -- the dashboard HTML and
  every `/api/*` JSON endpoint -- runs through one global auth middleware
  that verifies the signed cookie server-side. Missing/invalid/expired
  cookies redirect HTML requests to `/login` and return `401 {"error":
  "unauthorized"}` for `/api/*` requests.
- `GET /api/sessions/:id` validates `:id` against a strict allowlist
  (`/^[a-zA-Z0-9_.-]+$/`) and additionally confirms the resolved path is
  still inside the session-store directory before touching the
  filesystem, to rule out path traversal.

## OAuth login (GitHub) -- optional, on top of the password login

Password login (above) always works and needs no configuration. GitHub
OAuth is a *second*, optional way to log in, for when you'd rather use a
real identity than the shared password -- it's off by default and the
login page looks exactly as it does today (no button, no behavior change)
until you configure it.

### 1. Create a GitHub OAuth App

GitHub -> Settings -> Developer settings -> OAuth Apps -> New OAuth App.

- **Homepage URL**: wherever this console is reachable, e.g.
  `http://localhost:4177`.
- **Authorization callback URL**: must match `LINDA_OAUTH_CALLBACK_URL`
  below *exactly* (scheme, host, port, path) -- e.g.
  `http://localhost:4177/auth/github/callback`.

After creating it, GitHub gives you a **Client ID** and lets you generate
a **Client Secret**.

### 2. Set the env vars

```
LINDA_OAUTH_GITHUB_CLIENT_ID='...'
LINDA_OAUTH_GITHUB_CLIENT_SECRET='...'
LINDA_OAUTH_CALLBACK_URL='http://localhost:4177/auth/github/callback'
LINDA_ALLOWED_GITHUB_USERS='yourgithubusername,teammateusername'
```

With all four set and `npm start` run, `/login` will show a "Log in with
GitHub" button below the password form.

`LINDA_ALLOWED_GITHUB_USERS` is a comma-separated allowlist of GitHub
usernames (case-insensitive). **It's required** the moment
`LINDA_OAUTH_GITHUB_CLIENT_ID`/`_SECRET` are set -- if it's missing or
empty, the server fails loudly at boot and refuses to start, the same
fail-closed pattern as the missing-password check. This exists because
GitHub OAuth alone only proves "this is a real GitHub account," not "this
account should have access to this console" -- without an allowlist,
*any* GitHub user could complete the OAuth flow and get in.

`LINDA_OAUTH_CALLBACK_URL` is similarly required once OAuth is enabled --
it's what's sent to GitHub's authorize endpoint and must exactly match
what's registered on the OAuth App, or GitHub will refuse the redirect.

### How it interacts with the password login

Both methods produce the exact same session cookie
(`linda_console_session`) and are checked by the same auth middleware --
whichever is present and valid wins. Password sessions are stateless (no
DB row); GitHub sessions are backed by a row in the `web_sessions` table
(so `/logout` can revoke one immediately, and so an expired/deleted row
stops working even if the cookie itself hasn't expired yet). Signing in
with GitHub upserts a row in `users` keyed on `(provider,
provider_user_id)`, so the same GitHub account reuses the same `users`
row on every subsequent login rather than creating a new one each time.

## Database

The console reads `/api/sessions` and `/api/sessions/:id` from a SQL
database (via [Knex](https://knexjs.org)) instead of hitting the
filesystem on every request. **This DB is a read cache, not the source
of truth** -- it's populated and kept current by a background sync loop
(`sync.js`, `startSyncLoop()`, runs every 3s) that reads
`~/.claude/linda-runs/index.json` plus each session's `state.json`/
`plan.json`/`events.jsonl` and upserts into the `runs`/`tasks`/`events`
tables. The harness itself (the `linda` skill's controller,
`scripts/wave-exec.js`, etc.) still writes those files directly and is
completely unaware the DB exists. If a run was just created and the
sync loop hasn't caught up to it yet, `GET /api/sessions/:id` falls
back to reading the files directly for that one request.

Two supported backends, picked via `DB_CLIENT`:

- **`sqlite3`** (default) -- a local file at `console/data/linda.sqlite`
  (the `data/` directory is created automatically on first boot if
  missing, and is gitignored -- the DB file itself is never committed).
  Nothing else to configure.
- **`pg`** -- a real Postgres instance, for production/shared use.
  Requires `DATABASE_URL` (a standard `postgres://user:pass@host:port/db`
  connection string) to also be set. If `DB_CLIENT=pg` is given without
  `DATABASE_URL`, the server fails loudly on boot and exits (same
  fail-closed pattern as the missing-password check above) rather than
  silently falling back to sqlite or starting half-configured.

```
DB_CLIENT=pg DATABASE_URL='postgres://user:pass@host:5432/linda' LINDA_CONSOLE_PASSWORD='...' npm start
```

The `users`/`web_sessions` tables also exist in the schema (created by
the same startup `ensureSchema()` step) but aren't used by anything
yet -- they're there for a later piece of OAuth-login work to build on
top of.

## Skills

The console has a second, DB-managed "skills library" separate from the
on-disk harness files (`skills/linda/SKILL.md`, `agents/*.md`) -- it's a
staging/reference/override layer for the console UI only, and it never
changes what the actual harness controller or subagents execute.
Concretely:

- **Library.** On first boot, if the `skills` table is empty, it's
  seeded once from `skills/linda/SKILL.md` (as the `linda` controller)
  and every `agents/*.md` file (one row per agent). This only happens
  once -- once the table has rows, restarts never re-seed it, so any
  hand-edits made later through the UI (`GET/PUT/POST/DELETE
  /api/skills*`) are never clobbered. Editing a library skill here,
  built-in or imported, only ever updates its row in the DB -- **it does
  not write back to `skills/` or `agents/` on disk.** Only
  `source: "imported"` skills (added via the "Import skill" form or
  `POST /api/skills`) can be deleted; built-in ones can be edited but
  not removed from the library.
- **Per-run overrides.** From a run's detail view, its "Skills for this
  run" tab lets you set a per-run override for any library skill
  (`PUT /api/sessions/:id/skills/:name`) -- useful for experimenting
  with a modified prompt against one specific run without touching the
  shared library other runs see. `GET /api/sessions/:id/skills` returns
  every library skill with an `overridden` flag; when true, `content`
  is the override's text and `library_content` is what the unmodified
  library still has. `DELETE /api/sessions/:id/skills/:name` reverts
  that run back to the library version.
- **Import.** `POST /api/skills` with `{name, kind, content,
  description}` (`kind` is `"controller"` or `"agent"`) adds a brand
  new skill to the library with `source` forced to `"imported"`
  server-side. 409s if the name is already taken.

None of this is wired into how `scripts/wave-exec.js` or the harness
itself resolves a skill at run time -- that still only ever reads the
files under `skills/`/`agents/` directly. This library is a management
surface for browsing/editing/experimenting, not a second source of
truth the harness consults.

## Deliberately minimal -- not for public exposure

This is built for local, single-operator use: you, on your own machine or
a private network, checking on a run. **Do not expose this directly to
the public internet.** The auth here (a single shared password, a
hand-rolled signed cookie, no TLS termination in this process itself) is
adequate for a personal tool behind your own machine's firewall, not for
an internet-facing service. If you do need remote access, put a real
reverse proxy in front of it (nginx/Caddy) with real TLS, and treat this
app's own auth as a second layer, not the only one.
