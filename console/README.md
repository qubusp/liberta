# Liberta Console

A small authenticated dashboard showing, at a glance, which Liberta
orchestration session(s) exist, which one is active, its current task
board, and a tail of its event log. The session store at
`~/.claude/liberta-runs/` remains the source of truth (the harness itself
writes those files, unchanged) -- the console reads from a SQL
database that mirrors it, kept in sync by a background loop. See
"Database" below.

## Run it

```
cd console
npm install
LIBERTA_CONSOLE_PASSWORD='pick something' npm start
# → http://localhost:4177
```

Override the port with `PORT`:

```
PORT=8080 LIBERTA_CONSOLE_PASSWORD='...' npm start
```

Optionally set `LIBERTA_CONSOLE_SECRET` to a stable random string (used to
sign session cookies). If it's left unset, the server generates a random
secret at boot and warns about it -- every restart will then invalidate
all existing login sessions, since the signing key changed.

`LIBERTA_CONSOLE_PASSWORD` is an optional override, not a requirement. If
it's unset or empty, the server falls back to a built-in default password,
`libert@123!`, instead of refusing to start:

```
cd console
npm install
npm start
# → http://localhost:4177
```

**That default is insecure.** It's public (it's printed right here in this
README), it's identical on every install, and the console binds `0.0.0.0`
by default -- so anyone else on the same network can reach the login page
and try it. The default exists only so a quick, local, single-operator
install works out of the box with zero configuration. The server prints a
warning to stderr at boot whenever the default is in effect. Set
`LIBERTA_CONSOLE_PASSWORD` to a real secret for anything durable (you want
sessions to survive a restart with a stable secret) or reachable over a
network by anyone besides you.

## Auth model

- Single-operator tool: one shared password, no username, no accounts.
- Login (`POST /login`) compares the submitted password against
  `LIBERTA_CONSOLE_PASSWORD` with `crypto.timingSafeEqual` (only ever called
  on two equal-length buffers, to avoid it throwing on a length mismatch).
- On success, issues a signed, `httpOnly`, `SameSite=Lax` cookie: a random
  session id + expiry, HMAC-SHA256'd with a server-side secret
  (`LIBERTA_CONSOLE_SECRET`, or a random one generated at boot -- see
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
- **Authorization callback URL**: must match `LIBERTA_OAUTH_CALLBACK_URL`
  below *exactly* (scheme, host, port, path) -- e.g.
  `http://localhost:4177/auth/github/callback`.

After creating it, GitHub gives you a **Client ID** and lets you generate
a **Client Secret**.

### 2. Set the env vars

```
LIBERTA_OAUTH_GITHUB_CLIENT_ID='...'
LIBERTA_OAUTH_GITHUB_CLIENT_SECRET='...'
LIBERTA_OAUTH_CALLBACK_URL='http://localhost:4177/auth/github/callback'
LIBERTA_ALLOWED_GITHUB_USERS='yourgithubusername,teammateusername'
```

With all four set and `npm start` run, `/login` will show a "Log in with
GitHub" button below the password form.

`LIBERTA_ALLOWED_GITHUB_USERS` is a comma-separated allowlist of GitHub
usernames (case-insensitive). **It's required** the moment
`LIBERTA_OAUTH_GITHUB_CLIENT_ID`/`_SECRET` are set -- if it's missing or
empty, the server fails loudly at boot and refuses to start. This is a
fail-closed check: this exists because
GitHub OAuth alone only proves "this is a real GitHub account," not "this
account should have access to this console" -- without an allowlist,
*any* GitHub user could complete the OAuth flow and get in.

`LIBERTA_OAUTH_CALLBACK_URL` is similarly required once OAuth is enabled --
it's what's sent to GitHub's authorize endpoint and must exactly match
what's registered on the OAuth App, or GitHub will refuse the redirect.

### How it interacts with the password login

Both methods produce the exact same session cookie
(`liberta_console_session`) and are checked by the same auth middleware --
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
`~/.claude/liberta-runs/index.json` plus each session's `state.json`/
`plan.json`/`events.jsonl` and upserts into the `runs`/`tasks`/`events`
tables. The harness itself (the `liberta` skill's controller,
`scripts/wave-exec.js`, etc.) still writes those files directly and is
completely unaware the DB exists. If a run was just created and the
sync loop hasn't caught up to it yet, `GET /api/sessions/:id` falls
back to reading the files directly for that one request.

Two supported backends, picked via `DB_CLIENT`:

- **`sqlite3`** (default) -- a local file at `console/data/liberta.sqlite`
  (the `data/` directory is created automatically on first boot if
  missing, and is gitignored -- the DB file itself is never committed).
  Nothing else to configure.
- **`pg`** -- a real Postgres instance, for production/shared use.
  Requires `DATABASE_URL` (a standard `postgres://user:pass@host:port/db`
  connection string) to also be set. If `DB_CLIENT=pg` is given without
  `DATABASE_URL`, the server fails loudly on boot and exits (a
  fail-closed check) rather than silently falling back to sqlite or
  starting half-configured.

```
DB_CLIENT=pg DATABASE_URL='postgres://user:pass@host:5432/liberta' LIBERTA_CONSOLE_PASSWORD='...' npm start
```

The `users`/`web_sessions` tables also exist in the schema (created by
the same startup `ensureSchema()` step) but aren't used by anything
yet -- they're there for a later piece of OAuth-login work to build on
top of.

## Skills

The console has a second, DB-managed "skills library" separate from the
on-disk harness files (`skills/liberta/SKILL.md`, `agents/*.md`) -- it's a
staging/reference/override layer for the console UI only, and it never
changes what the actual harness controller or subagents execute.
Concretely:

- **Library.** On first boot, if the `skills` table is empty, it's
  seeded once from `skills/liberta/SKILL.md` (as the `liberta` controller)
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

## Screenshots / visual evidence

The dashboard and every `/api/*` route are auth-gated (see "Auth" above),
so a screenshot of `/login` proves nothing about what a logged-in
operator actually sees. Two scripts under `console/scripts/` exist so
every visual/UI task can produce real, logged-in evidence the same way:

- **`console/scripts/shot.mjs`** boots a console of its own (preferred
  port 4999, credentials generated fresh for that one invocation) and
  tears it back down on exit; logs in over HTTP to get
  the real signed session cookie (reading the cookie name from
  `console/auth.js` rather than guessing it); then drives the system
  Google Chrome via `puppeteer-core` (no bundled-browser download) with
  that cookie set, navigates to a path, and writes full-page PNGs at both
  1440x900 and 390x844. It hard-fails, writing no PNG at all, unless the
  page positively proves it is the authenticated view -- a false
  "success" here would poison every later visual task.

  ```
  node console/scripts/shot.mjs \
    --out ./shots --path / --label dashboard-home \
    [--reduced-motion] [--script ./my-interaction.mjs] \
    [--expect-selector '#some-marker']
  ```

  `--script <file.mjs>` is an ES module exporting `async function
  run(page)`, executed after login + navigation and before the
  screenshots -- e.g. to click into a panel or type a message before
  capturing.

  `--expect-selector <css>` **adds** a required CSS selector on top of the
  default authenticated-view markers (see below); it does **not** replace
  them. The requirement is `#sessions-table` AND `#whoami` AND every
  selector you passed, ANDed in turn with the other conditions -- so the
  flag can only ever narrow what counts as authenticated. Repeat it to
  require several selectors. There is deliberately **no** flag that
  replaces the defaults.

  This used to be untrue, and the previous wording here -- which claimed
  the flag overrides the default marker yet could not make the guard any
  weaker -- was wrong in a way that mattered: `--expect-selector`
  *replaced* the defaults, so a broad selector made the guard strictly
  weaker. An auditor combined
  `--expect-selector body` with a cookie-clearing `--script` that
  navigated to `/logout`, and the tool exited 0 and wrote two PNGs of a
  genuinely unauthenticated Express 404 page -- the 1440 one being a blank
  white error page. Naming a chat-panel / pixel-art / mindmap marker is
  the intended use of this flag; naming something broad is now harmless
  rather than a bypass.

  **Environment overrides.**

  - `SHOT_PORT` (falling back to `PORT`, then `4999`) sets the preferred
    port for the child console.
  - `LIBERTA_CHROME_PATH` (falling back to `CHROME_PATH`) points at the
    Chrome/Chromium binary. Without either, the macOS default
    `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` is
    used.

  **It always starts its own console, and cannot be shadowed by someone
  else's.** The port was once hardcoded to `4999` and *any* listener
  already there was reused, so a concurrent `shot.mjs` or an unrelated
  console meant this tool screenshotted a **different** console and
  certified it happily -- the evidence described the wrong tree.

  The first fix for that was defeated, and how it was defeated is the
  whole reason the current design looks the way it does. That version
  spawned a real child, waited for the `listening on` line on the child's
  own stdout, and logged in with a per-invocation random password -- and
  an auditor still got two PNGs reading "EVIDENCE FORGED BY FOREIGN
  SERVER" out of a plain default invocation, exit 0, empty stderr. Three
  platform facts, each measured on macOS, combined:

  - a free-port probe that binds `0.0.0.0:P` **succeeds** while another
    process holds `127.0.0.1:P` or `[::1]:P`, so a loopback-only squatter
    was reported as "port free";
  - Node sets `SO_REUSEADDR`, so a wildcard bind and a specific bind of
    the same port coexist -- the child really did start and really did
    print its line;
  - `localhost` resolves `::1` **before** `127.0.0.1`, and the kernel
    routes to the most specific matching bind. So every request to
    `http://localhost:4999` reached the squatter on `[::1]:4999`, never
    the child.

  The child's stdout line proves *the child started*. It does not prove
  *traffic to the base URL reaches the child*. Three things now do:

  - **Probe every reachable address.** A port counts as free only if
    `127.0.0.1`, `::1` **and** `0.0.0.0` can all be bound; a refusal on
    any one of them means it is taken, and an OS-assigned free port is
    used instead.
  - **One literal address, never a name.** The child is told to bind the
    single address `127.0.0.1` via `LIBERTA_CONSOLE_HOST`, and the base
    URL is built from that same literal. Name resolution leaves the trust
    chain, the kernel refuses a second bind of exactly `127.0.0.1:P`, and
    a foreign wildcard listener loses to the more specific bind -- so a
    child that bound successfully is the only thing that can answer the
    address the tool talks to.
  - **A credential proof that actually proves something.** A 302 carrying
    a correctly *named* cookie is trivially forgeable: both are chosen by
    whoever answers the socket, and a hostile server that accepts any
    password and sets a `liberta_console_session` cookie satisfied the old
    check completely. The tool now requires that a deliberately **wrong**
    password is **rejected**, and that the cookie issued for the right one
    **verifies under the HMAC secret this process generated seconds
    earlier** (`verifySessionCookie` from `auth.js`). Forging that needs
    the secret, so this holds even if the routing argument above were
    somehow wrong on some other platform.

  If any of it fails the run aborts loudly, rather than capturing a
  server it cannot prove is its own.

  **Credentials are per-invocation.** They used to be a pair of fixed
  strings committed in a public repo, while the console bound *all*
  interfaces by default. During a screenshot run that made the real console -- real
  `console/data/liberta.sqlite`, real `~/.claude/liberta-runs` -- reachable
  on `0.0.0.0`, with a *published* signing secret, so a LAN-adjacent
  attacker could forge a valid session cookie without knowing the
  password. Both values are now `crypto.randomBytes` per run and never
  logged. The follow-up this section used to list as open -- that the
  child still bound every interface, because the bind address lived in
  `server.js` where `shot.mjs` could not reach it -- is closed:
  `server.js` honours `LIBERTA_CONSOLE_HOST`, and `shot.mjs` sets it to
  `127.0.0.1`, so the ephemeral child sits on loopback only for the length
  of the run.

  **Stale evidence is cleared up front.** Cleanup used to delete only the
  PNGs written by the current invocation, so a run that failed at the
  first checkpoint left the *previous* run's `<label>-1440.png` sitting at
  exactly the path a downstream task reads -- stale evidence surviving a
  non-zero exit. `shot.mjs` now deletes any pre-existing PNG at the paths
  it is about to write, before it does anything else.

  **A known, nondeterministic screenshot-time failure.** During a
  `fullPage` capture puppeteer transiently drives `innerWidth` to 1 while
  it resizes for the full-page shot. On a page with a narrow-viewport
  `matchMedia` listener that can fire the listener mid-capture and surface
  as a roughly 30-second hang ending in
  `Page.captureScreenshot timed out`. It **fails closed** -- non-zero
  exit, no PNG -- and it is nondeterministic, so a retry usually
  succeeds. Do not mistake it for the tool hanging, and do not "fix" it by
  weakening the guard.

  **The auth guard is an allowlist, not a blocklist -- deliberately.**
  The original guard rejected a capture only when `input[name=password]`
  was present, and that blocklist was defeated: a `--script` hook that
  cleared cookies and navigated to `/api/sessions` produced the plain
  body `{"error":"unauthorized"}`, which has no password input, so the
  tool exited 0 and wrote two real PNGs of an *unauthenticated* page. Any
  blocklist has this shape of hole, because "not the login form" is not
  the same claim as "the authenticated dashboard". A capture is therefore
  now valid only if **all** of the following hold, checked in the live
  page:

  - the default authenticated-view markers are present in the DOM --
    `#sessions-table` **and** `#whoami`, which exist only in
    `console/public/dashboard.html` and are served behind auth. These are
    always required and cannot be switched off from the command line;
  - every `--expect-selector` the caller passed is *also* present;
  - `document.contentType` is `text/html`, so a JSON or plain-text error
    body fails before the selectors are even consulted;
  - the page URL is same-origin with the harness base URL
    (`http://localhost:<the port this run chose>`);
  - `input[name=password]` is absent (the old check, kept but now
    subordinate).

  These are asserted after navigation, after the `--script` hook, and --
  decisively -- immediately before *each* of the two screenshot writes,
  since the viewport resize or a navigation the script scheduled can
  change the page in between. On failure the message names which
  condition failed plus the actual URL and contentType, and every PNG at
  this label/out-dir's paths is deleted, so a failed run never leaves
  partial or stale evidence for a later task to pick up.

- **`console/scripts/probes/auth-bypass.mjs`** is the exact bypass above,
  committed as a permanent regression probe: a `--script` module that
  clears all cookies and navigates to `/api/sessions`. Re-run it whenever
  the guard is touched; it MUST exit non-zero, leave zero PNGs, and fail
  specifically on the **contentType** condition (`document.contentType is
  "application/json"`). It builds that URL from the page's own origin
  rather than hardcoding one: it used to target a literal
  `http://localhost:4999/api/sessions`, which after the port became
  dynamic pointed at nothing this run started -- so it still failed, but
  on a connection error instead of the condition it exists to exercise. A
  regression test that fails for the wrong reason is not testing
  anything.

  ```
  rm -rf /tmp/shot-bypass
  node console/scripts/shot.mjs --label bypass --out /tmp/shot-bypass \
    --script console/scripts/probes/auth-bypass.mjs
  echo "exit=$?"          # must be non-zero
  ls /tmp/shot-bypass/*.png | wc -l   # must be 0
  ```

- **`console/scripts/fixture-sessions.mjs`** writes (`create`) and
  removes (`clean`) four throwaway session-store trees under
  `~/.claude/liberta-runs/`, shaped like `console/sync.js` expects
  (`state.json`, `plan.json`, `events.jsonl`, `goal.md`), one each in
  `running` / `done` / `failed` / `idle` status, and registers/deregisters
  them in `~/.claude/liberta-runs/index.json` so they show up in the
  dashboard's session list like real runs -- useful for a single
  screenshot that shows all four dashboard states at once. Every fixture
  id is prefixed `zz-fixture-`; `clean` only ever touches directories and
  index entries with that exact prefix, is idempotent, and never modifies
  or removes any other session (including the live run these scripts
  ship in).

  ```
  node console/scripts/fixture-sessions.mjs create
  node console/scripts/fixture-sessions.mjs clean
  ```

## Deliberately minimal -- not for public exposure

This is built for local, single-operator use: you, on your own machine or
a private network, checking on a run. **Do not expose this directly to
the public internet.** The auth here (a single shared password, a
hand-rolled signed cookie, no TLS termination in this process itself) is
adequate for a personal tool behind your own machine's firewall, not for
an internet-facing service. If you do need remote access, put a real
reverse proxy in front of it (nginx/Caddy) with real TLS, and treat this
app's own auth as a second layer, not the only one.
