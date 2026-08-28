# Linda Console

A small authenticated dashboard showing, at a glance, which Linda
orchestration session(s) exist, which one is active, its current task
board, and a tail of its event log. Reads directly from the on-disk
session store at `~/.claude/linda-runs/` -- no database, no build step.

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

## Deliberately minimal -- not for public exposure

This is built for local, single-operator use: you, on your own machine or
a private network, checking on a run. **Do not expose this directly to
the public internet.** The auth here (a single shared password, a
hand-rolled signed cookie, no TLS termination in this process itself) is
adequate for a personal tool behind your own machine's firewall, not for
an internet-facing service. If you do need remote access, put a real
reverse proxy in front of it (nginx/Caddy) with real TLS, and treat this
app's own auth as a second layer, not the only one.
