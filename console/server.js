"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  COOKIE_NAME,
  SESSION_TTL_MS,
  makeSessionCookie,
  verifySessionCookie,
  makeSignedPayloadCookie,
  verifySignedPayloadCookie,
  makeOAuthSessionCookie,
  verifyOAuthSessionCookiePayload,
  timingSafeStringEqual,
  createLoginRateLimiter,
} = require("./auth");
const { tailLines } = require("./tail");
const { knex, ensureSchema, seedSkillsFromDisk, initDb } = require("./db");
const { buildSessionGraph } = require("./session-graph");
const { startSyncLoop } = require("./sync");
const oauth = require("./auth-oauth");

// ---------------------------------------------------------------------
// Boot-time password check. If LIBERTA_CONSOLE_PASSWORD is unset or empty,
// fall back to a built-in default password so the server can still start
// (intended for local single-operator use only) and print a loud warning.
// If LIBERTA_CONSOLE_PASSWORD is set and non-empty, it always wins.
// ---------------------------------------------------------------------
const DEFAULT_ADMIN_PASSWORD = "libert@123!";
const envPassword = process.env.LIBERTA_CONSOLE_PASSWORD;
const ADMIN_PASSWORD =
  envPassword && envPassword.length > 0 ? envPassword : DEFAULT_ADMIN_PASSWORD;
if (!envPassword || envPassword.length === 0) {
  process.stderr.write(
    "WARNING: LIBERTA_CONSOLE_PASSWORD is not set.\n" +
      "WARNING: The console is running with the built-in default password " +
      `"${DEFAULT_ADMIN_PASSWORD}".\n` +
      "WARNING: This is insecure and is intended for local single-operator " +
      "use only.\n" +
      "WARNING: Set LIBERTA_CONSOLE_PASSWORD to a strong value for anything " +
      "durable or network reachable.\n"
  );
}

// Secret used to HMAC-sign session cookies. If LIBERTA_CONSOLE_SECRET isn't
// given, generate a random one at boot -- sessions won't survive a
// restart in that case (every restart invalidates all existing session
// cookies), which is fine for a personal tool but worth a clear warning.
let SESSION_SECRET = process.env.LIBERTA_CONSOLE_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length === 0) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  process.stderr.write(
    "WARNING: LIBERTA_CONSOLE_SECRET is not set. Generated a random " +
      "session secret at boot -- all sessions will be invalidated on the " +
      "next restart. Set LIBERTA_CONSOLE_SECRET to a stable value to avoid " +
      "this.\n"
  );
}

// Resolve where the Liberta run store lives on disk. Delegates to the
// canonical resolver in scripts/_store.cjs (added in T8) rather than
// duplicating its logic here, so console/server.js, console/sync.js and
// every other caller across the harness share exactly one implementation
// of the LIBERTA_RUNS_DIR override + homedir fallback.
const { runsRoot } = require("../scripts/_store.cjs");
const LIBERTA_RUNS_DIR = runsRoot();
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

const PORT = process.env.PORT ? Number(process.env.PORT) : 4177;
// Bind address. Default stays "0.0.0.0" -- an operator may well reach this
// console from another device on their own network, and silently moving it
// to loopback would break that. The point of the env var is only to make
// loopback EXPRESSIBLE, so an ephemeral child console (console/scripts/
// shot.mjs starts one per screenshot run) can opt into 127.0.0.1 and not
// sit on every interface for the length of the run.
const HOST = process.env.LIBERTA_CONSOLE_HOST || "0.0.0.0";
// If set truthy, a second console started on an already-taken PORT scans
// upward for a free one instead of refusing to start. Off by default: an
// operator who explicitly set PORT almost certainly wants THAT port and
// would rather see a clear refusal than silently end up somewhere else.
const PORT_AUTO = /^(1|true|yes)$/i.test(
  (process.env.LIBERTA_CONSOLE_PORT_AUTO || "").trim()
);
// Bounded number of upward probes when PORT_AUTO is on, so a truly saturated
// range fails loudly instead of scanning forever.
const PORT_AUTO_MAX_TRIES = 20;

const app = express();
// Express 4 disables case-sensitive routing by default, which means a
// handler registered at "/api/sessions/:id/inbox" ALSO answers
// "/API/sessions/<id>/inbox" -- while req.path stays "/API/...". Every
// middleware below that decides what to do by testing req.path (the auth
// gate's "/api/" branch, the CSRF gate) would then be looking at a string
// that doesn't match the route that is about to run, so a case-variant
// path slips past them and still reaches the handler. Making routing
// case-sensitive collapses that gap: "/API/..." matches no route at all
// and 404s. The path tests below are ALSO written case-insensitively, so
// the defence does not depend on this single setting staying put.
app.set("case sensitive routing", true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());

// In-memory sliding-window rate limiter for login attempts, per IP. Safe
// only because this runs as a single Node process (see auth.js).
const loginLimiter = createLoginRateLimiter({ windowMs: 60 * 1000, max: 10 });

// ---------------------------------------------------------------------
// Auth middleware -- applied globally, with an explicit allowlist for the
// login page and its POST endpoint. Every other route (HTML dashboard AND
// every /api/* route) must pass through this.
// ---------------------------------------------------------------------
const PUBLIC_PATHS = new Set([
  "/login",
  "/logout",
  "/auth/github",
  "/auth/github/callback",
  "/style.css",
]);

// A request is authenticated by EITHER of two independent mechanisms,
// sharing the one cookie (COOKIE_NAME):
//   1. Password login -- a stateless signed cookie with no `wsid` field;
//      valid signature + not-expired is sufficient (see
//      auth.js#verifySessionCookie).
//   2. OAuth (GitHub) login -- a signed cookie carrying a `wsid`
//      referencing a `web_sessions` row; the cookie's own signature/expiry
//      is checked first (cheap, no DB hit for a forged/expired cookie),
//      and only then is the row looked up to confirm it's real and not
//      expired/revoked (e.g. by logout deleting it).
// Whichever of the two is present and valid wins; there's no scenario
// where both are required.
async function resolvePrincipal(req) {
  const cookie = req.cookies && req.cookies[COOKIE_NAME];
  if (!cookie) return null;

  if (verifySessionCookie(cookie, SESSION_SECRET)) {
    return { authMethod: "password" };
  }

  const wsid = verifyOAuthSessionCookiePayload(cookie, SESSION_SECRET);
  if (!wsid) return null;

  try {
    const row = await knex("web_sessions").where({ id: wsid }).first();
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }
    let user = null;
    if (row.user_id) {
      user = await knex("users").where({ id: row.user_id }).first();
    }
    return { authMethod: row.auth_method || "oauth_github", webSessionId: row.id, user };
  } catch (err) {
    return null;
  }
}

// Is this request headed for the JSON API? Compared case-insensitively
// so that a case-variant path can never be classified differently from
// the route it would actually reach (see the routing note at boot).
function isApiPath(req) {
  return typeof req.path === "string" && req.path.toLowerCase().startsWith("/api/");
}

app.use(async (req, res, next) => {
  // PUBLIC_PATHS stays an EXACT match: it is an allowlist, and widening
  // an allowlist by case-folding it would let "/LOGIN" (or any other
  // variant) skip auth. A case-variant public path simply isn't public;
  // it falls through to the checks below and, with case-sensitive
  // routing on, 404s after authenticating.
  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }
  const principal = await resolvePrincipal(req);
  if (principal) {
    req.principal = principal;
    return next();
  }
  if (isApiPath(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return res.redirect("/login");
});

// ---------------------------------------------------------------------
// CSRF defence for state-changing /api/ requests.
//
// Auth here is a cookie with no CSRF token, and express.urlencoded is
// mounted globally, so a cross-origin `<form method=POST>` would be a
// "simple request" (no preflight) that the browser sends WITH the session
// cookie. For the inbox that means any page the operator visits while
// logged in could drop a `steer` message into a live run, which the
// controller then acts on as operator-authored direction.
//
// Two independent checks, both cheap:
//   1. Reject anything a browser tells us is cross-site (Sec-Fetch-Site,
//      or an Origin whose host isn't ours). Neither header is forgeable
//      from page JS.
//   2. Require Content-Type: application/json on requests that carry a
//      body. HTML forms can only send urlencoded / multipart / text-plain,
//      so this alone blocks the no-preflight form attack; a JSON body from
//      another origin requires a preflight, which same-origin policy fails.
// GET/HEAD/OPTIONS are untouched, and DELETE (which the dashboard sends
// without a body) only gets the origin check.
// ---------------------------------------------------------------------
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

function requestHost(req) {
  const h = req.headers && req.headers.host;
  return typeof h === "string" ? h.toLowerCase() : null;
}

function isCrossSiteRequest(req) {
  const fetchSite = req.headers && req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite) {
    // "same-origin" / "same-site" / "none" (direct navigation, no
    // initiator) are fine; "cross-site" is not.
    if (fetchSite.toLowerCase() === "cross-site") return true;
  }
  const origin = req.headers && req.headers.origin;
  if (typeof origin === "string" && origin && origin !== "null") {
    let originHost;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return true; // unparsable Origin -- treat as hostile
    }
    const host = requestHost(req);
    if (!host || originHost !== host) return true;
  }
  return false;
}

app.use((req, res, next) => {
  // Case-insensitive on purpose -- see isApiPath/the routing note above.
  if (!isApiPath(req)) return next();
  if (CSRF_SAFE_METHODS.has(req.method)) return next();

  if (isCrossSiteRequest(req)) {
    return res.status(403).json({ error: "cross-origin request rejected" });
  }

  if (CSRF_BODY_METHODS.has(req.method)) {
    const ctype = req.headers["content-type"];
    const base = typeof ctype === "string" ? ctype.split(";")[0].trim().toLowerCase() : "";
    if (base !== "application/json") {
      return res
        .status(415)
        .json({ error: "content-type must be application/json" });
    }
  }
  return next();
});

// ---------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------
const OAUTH_ERROR_MESSAGES = {
  not_allowlisted: "That GitHub account isn't allowed to log in here.",
  exchange_failed: "GitHub login failed (code exchange). Try again.",
  profile_fetch_failed: "GitHub login failed (couldn't read your profile). Try again.",
  missing_code: "GitHub login failed (no code returned). Try again.",
  bad_state: "GitHub login failed (state mismatch). Try again.",
  not_configured: "GitHub login isn't configured on this server.",
};

function renderLoginPage({ error } = {}) {
  const errorHtml = error
    ? `<p class="error-banner">${escapeHtml(error)}</p>`
    : "";
  const githubButtonHtml = oauth.isOAuthConfigured()
    ? `<a class="github-login" href="/auth/github">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
                   0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
                   -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
                   .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
                   -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0
                   1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82
                   1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01
                   1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
        </svg>
        <span>Log in with GitHub</span>
      </a>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Liberta Console - Login</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body>
  <div class="login-shell">
    <div class="login-box">
      <div class="login-brand">
        <span class="login-brand-mark">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 12L10 18L20 6" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <h1>Liberta Console</h1>
      </div>
      <form method="POST" action="/login">
        ${errorHtml}
        <label class="field-label" for="login-password">Password</label>
        <input type="password" id="login-password" name="password" placeholder="Password" autofocus required />
        <button class="btn btn-primary" type="submit">Log in</button>
      </form>
      ${githubButtonHtml ? `<div class="divider">or</div>${githubButtonHtml}` : ""}
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

app.get("/login", (req, res) => {
  const errorCode = req.query && req.query.error;
  const error = errorCode
    ? OAUTH_ERROR_MESSAGES[errorCode] || "Login failed. Try again."
    : undefined;
  res.type("html").send(renderLoginPage({ error }));
});

app.post("/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!loginLimiter.isAllowed(ip)) {
    return res
      .status(429)
      .type("html")
      .send(renderLoginPage({ error: "Too many attempts, slow down." }));
  }

  const submitted = req.body && req.body.password ? req.body.password : "";
  if (!timingSafeStringEqual(submitted, ADMIN_PASSWORD)) {
    return res
      .status(401)
      .type("html")
      .send(renderLoginPage({ error: "Wrong password." }));
  }

  const cookieValue = makeSessionCookie(SESSION_SECRET);
  res.cookie(COOKIE_NAME, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    // secure: true is intentionally not set here -- see README for the
    // "put a real TLS reverse proxy in front of this" note. Enabling
    // secure without TLS in front would break the cookie on plain HTTP.
  });
  res.redirect("/");
});

app.post("/logout", async (req, res) => {
  // If the session came from OAuth (a `wsid`-carrying cookie referencing a
  // live web_sessions row), delete that row too -- clearing the cookie
  // alone would leave a still-valid, still-usable session token sitting
  // in the DB (e.g. recoverable from browser history/dev tools) until it
  // naturally expires.
  const cookie = req.cookies && req.cookies[COOKIE_NAME];
  const wsid = cookie ? verifyOAuthSessionCookiePayload(cookie, SESSION_SECRET) : null;
  if (wsid) {
    try {
      await knex("web_sessions").where({ id: wsid }).del();
    } catch (err) {
      // Best-effort -- still clear the cookie either way below.
    }
  }
  res.clearCookie(COOKIE_NAME);
  res.redirect("/login");
});

// ---------------------------------------------------------------------
// GitHub OAuth login
// ---------------------------------------------------------------------
const OAUTH_STATE_COOKIE = "liberta_oauth_state";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes, plenty for a login round-trip

app.get("/auth/github", (req, res) => {
  if (!oauth.isOAuthConfigured()) {
    return res.redirect("/login");
  }
  const state = oauth.generateState();
  const stateCookie = makeSignedPayloadCookie(
    { state, exp: Date.now() + OAUTH_STATE_TTL_MS },
    SESSION_SECRET
  );
  res.cookie(OAUTH_STATE_COOKIE, stateCookie, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: OAUTH_STATE_TTL_MS,
  });
  res.redirect(oauth.buildAuthorizeUrl(state));
});

app.get("/auth/github/callback", async (req, res) => {
  if (!oauth.isOAuthConfigured()) {
    return res.redirect("/login");
  }

  const stateCookieValue = req.cookies && req.cookies[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE);
  const statePayload = verifySignedPayloadCookie(stateCookieValue, SESSION_SECRET);
  const expectedState = statePayload && statePayload.state;
  const givenState = req.query && req.query.state;
  if (!expectedState || !givenState || !timingSafeStringEqual(String(givenState), String(expectedState))) {
    return res.redirect("/login?error=bad_state");
  }

  const code = req.query && req.query.code;
  const result = await oauth.handleCallback(code);
  if (!result.ok) {
    return res.redirect(`/login?error=${encodeURIComponent(result.reason || "unknown")}`);
  }

  const { profile } = result;
  try {
    let user = await knex("users")
      .where({ provider: "github", provider_user_id: profile.provider_user_id })
      .first();
    if (!user) {
      const [id] = await knex("users").insert({
        provider: "github",
        provider_user_id: profile.provider_user_id,
        username: profile.username,
        display_name: profile.display_name,
        avatar_url: profile.avatar_url,
        created_at: new Date(),
      });
      user = await knex("users").where({ id }).first();
    } else {
      // Keep the mirrored profile fields fresh (username/avatar can
      // change on GitHub's side between logins).
      await knex("users").where({ id: user.id }).update({
        username: profile.username,
        display_name: profile.display_name,
        avatar_url: profile.avatar_url,
      });
    }

    const webSessionId = crypto.randomBytes(24).toString("hex");
    const now = new Date();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await knex("web_sessions").insert({
      id: webSessionId,
      user_id: user.id,
      auth_method: "oauth_github",
      created_at: now,
      expires_at: expiresAt,
    });

    const cookieValue = makeOAuthSessionCookie(webSessionId, expiresAt.getTime(), SESSION_SECRET);
    res.cookie(COOKIE_NAME, cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: SESSION_TTL_MS,
    });
    return res.redirect("/");
  } catch (err) {
    return res.redirect("/login?error=exchange_failed");
  }
});

// ---------------------------------------------------------------------
// Session-store helpers
// ---------------------------------------------------------------------
function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// Reads a session's plan.json for the graph route. readJsonSafe above
// collapses THREE different outcomes into a bare `null` -- "no plan.json
// yet", "plan.json exists but cannot be opened", and "plan.json is not
// valid JSON" -- which makes it impossible for a caller to tell a normal
// session from a faulty one. This variant keeps them apart:
//   * ENOENT  -> null. A session with no plan.json yet is NORMAL (the
//                controller writes it after planning), NOT a fault, so
//                the graph must not flag it as degraded.
//   * any other fs error (EACCES, EISDIR, EIO, ELOOP, ...) -> rethrown,
//                so the caller can mark the session degraded.
//   * invalid JSON -> the SyntaxError from JSON.parse is rethrown too.
//                JUDGEMENT CALL, documented deliberately: a plan.json
//                that exists but does not parse is counted as DEGRADED,
//                not as "no plan". Rendering a corrupt plan as a healthy
//                empty session is the exact failure mode this flag
//                exists to prevent; a half-written file caught mid-write
//                self-heals on the next poll, so a transient flag is the
//                cheaper error of the two.
function readPlanForGraph(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw);
}

// The graph route is POLLED, so a permanently unreadable file would emit
// one stderr line per poll forever. Log once per (session, file) per
// process instead, and forget the key when that file reads cleanly again
// so a later recurrence is logged afresh (i.e. log on transition). The
// set holds at most 2 short keys per known session.
const graphDegradedLogged = new Set();

function logGraphDegradedOnce(id, file, err) {
  const key = id + "\u0000" + file;
  if (graphDegradedLogged.has(key)) return;
  graphDegradedLogged.add(key);
  console.error(`graph: unreadable ${file} for session ${id}:`, err && err.message);
}

function clearGraphDegraded(id, file) {
  graphDegradedLogged.delete(id + "\u0000" + file);
}

function readIndex() {
  const idx = readJsonSafe(path.join(LIBERTA_RUNS_DIR, "index.json"));
  if (!idx || !Array.isArray(idx.sessions)) {
    return { active_session_id: null, sessions: [] };
  }
  return idx;
}

function sessionDir(id) {
  return path.join(LIBERTA_RUNS_DIR, id);
}

// Resolve a path through symlinks, falling back to the (realpath-resolved)
// nearest existing ancestor joined lexically with the still-missing tail.
// This lets containment checks see through a symlink planted anywhere on
// the existing part of the path, while still working for paths that don't
// exist on disk yet (e.g. a message file about to be written).
function realpathDeepest(p) {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    const parent = path.dirname(p);
    if (parent === p) return p; // reached filesystem root
    return path.join(realpathDeepest(parent), path.basename(p));
  }
}

// Defense in depth on top of the regex allowlist check callers already do:
// confirm the resolved path is actually still inside LIBERTA_RUNS_DIR before
// touching the filesystem with it. Uses realpath (not just lexical resolve)
// so a symlink planted inside the runs dir can't be used to escape it.
function isPathInsideRunsDir(p) {
  let resolved;
  try {
    resolved = realpathDeepest(path.resolve(p));
  } catch {
    return false;
  }
  let base;
  try {
    base = fs.realpathSync(LIBERTA_RUNS_DIR);
  } catch {
    base = path.resolve(LIBERTA_RUNS_DIR);
  }
  base = base + path.sep;
  return resolved.startsWith(base);
}

// ---------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------

// Nice-to-have identity surface: OAuth logins can report a real GitHub
// username/avatar (req.principal.user, set by resolvePrincipal above);
// password logins have no identity beyond "the shared password holder",
// so they report a generic label instead.
app.get("/api/whoami", (req, res) => {
  const principal = req.principal || {};
  if (principal.authMethod === "password" || !principal.user) {
    return res.json({ auth_method: principal.authMethod || "password", username: "admin", avatar_url: null });
  }
  res.json({
    auth_method: principal.authMethod,
    username: principal.user.username,
    display_name: principal.user.display_name,
    avatar_url: principal.user.avatar_url,
  });
});

// ---------------------------------------------------------------------
// These two routes now read from the DB (db.js's knex instance, kept
// synced by sync.js's background loop) instead of hitting the
// filesystem directly on every request. Response shapes are kept
// byte-for-byte identical to the old file-reading implementation so
// public/dashboard.js keeps working unmodified.
// ---------------------------------------------------------------------
app.get("/api/sessions", async (req, res) => {
  try {
    const runs = await knex("runs").select("*");
    const activeRow = runs.find((r) => r.active);
    const sessions = runs.map((r) => ({
      id: r.id,
      project_path: r.project_path,
      status: r.status,
      // Lineage is written by sync.js (runs.parent_session_id) but was
      // exposed nowhere, making it write-only. `null` means "root" -- the
      // key is always present so consumers never see `undefined`.
      parent_session_id: r.parent_session_id ?? null,
      is_active: !!r.active,
    }));
    res.json({
      active_session_id: activeRow ? activeRow.id : null,
      sessions,
    });
  } catch (err) {
    res.status(500).json({ error: "db read failed", detail: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/sessions/graph -- the graph the mindmap UI (t11/t12) renders.
//
// ROUTE-ORDER TRAP: Express matches routes in registration order, and
// `/api/sessions/:id` below would otherwise swallow the literal segment
// "graph" as if it were a session id (returning a 404 "session not
// found" rather than the graph, or worse, matching a real session
// literally named "graph"). This route is therefore registered ABOVE
// `/api/sessions/:id` so it always wins for this exact path.
//
// Session list comes from the same source /api/sessions uses (the
// `runs` table, kept in sync with parent_session_id by sync.js/t9).
// Per-session plan.json and the tail of events.jsonl are read directly
// from disk here (mirroring readSessionFromDisk's approach below) and
// handed to buildSessionGraph as plain data -- this route does no graph
// logic of its own, it only gathers input for the pure builder.
//
// PER-SESSION FAULT ISOLATION: the per-session disk reads are each
// wrapped in their own try/catch below. plan.json is read with
// readPlanForGraph (NOT readJsonSafe, which would swallow the fault and
// make the catch dead code), and tailLines guards statSync only, so an
// events.jsonl that exists but cannot be opened (EACCES, EISDIR, EIO)
// throws out of the read. Without the inner catches, ONE unreadable file
// would fail the whole graph for every other session. With them, that
// session degrades to an empty plan/event list and its node still
// appears, carrying `degraded: true` plus `degraded_sources` -- the
// subset of ["plan.json", "events.jsonl"] that could not be read as
// usable data -- so the mindmap can flag it rather than silently showing
// it as a session with no plan. Every other node is unaffected, and the
// response is still 200.
//
// WHAT COUNTS AS DEGRADED, exactly: a file that EXISTS but could not be
// turned into data -- unopenable (EACCES), a directory in its place
// (EISDIR), an I/O error, or (for plan.json) content that is not valid
// JSON. A file that is simply ABSENT is NOT degraded: a session with no
// plan.json yet, or no events.jsonl yet, is a normal early-life session,
// and flagging it would make the flag meaningless.
//
// LOG VOLUME: this route is polled, so the server-side log line for a
// degraded file is emitted once per (session, file) per process, and
// re-armed when that file reads cleanly again -- not once per request.
//
// NODE SHAPE NOTE: `degraded`/`degraded_sources` are added HERE, not in
// session-graph.js -- the builder is pure and knows nothing about
// filesystem readability. `degraded` is present on every node (false for
// healthy ones) so consumers never have to test for `undefined`.
//
// Anything that still escapes goes to next(err) so t24's JSON error
// handler owns the response: the client gets a generic
// {"error":"internal server error"} with no err.message, and the real
// error (which for fs errors embeds an absolute path under the operator's
// home directory) is logged server-side only.
//
// Read-only: this route never writes anything under LIBERTA_RUNS_DIR.
app.get("/api/sessions/graph", async (req, res, next) => {
  try {
    const runs = await knex("runs").select("*");
    const sessions = runs.map((r) => ({
      id: r.id,
      project_path: r.project_path,
      status: r.status,
      parent_session_id: r.parent_session_id ?? null,
      is_active: !!r.active,
    }));

    const plans = {};
    const events = {};
    // id -> ["plan.json", "events.jsonl"] for sessions whose files could
    // not be read; used to flag the node without dropping it.
    const degradedSources = new Map();
    for (const session of sessions) {
      const id = session.id;
      // Defense in depth, same as every other per-id path below: the
      // regex allowlist alone does not stop `..`, so pair it with the
      // resolved-path containment check. An index/DB entry that fails
      // either is skipped (never 500s) rather than failing the whole
      // response for every other, well-formed session.
      if (!SESSION_ID_PATTERN.test(id)) continue;
      const dir = sessionDir(id);
      if (!isPathInsideRunsDir(dir)) continue;

      // Per-file, so an unreadable plan.json does not also cost this
      // session its events (and vice versa). NOTE: readJsonSafe is NOT
      // used here -- it returns null for a missing file, an unopenable
      // file and a corrupt file alike, which would make this catch dead
      // code and `degraded` permanently false for plan.json.
      // readPlanForGraph returns null only for ENOENT and throws for the
      // real faults.
      const failed = [];
      try {
        plans[id] = readPlanForGraph(path.join(dir, "plan.json"));
        clearGraphDegraded(id, "plan.json");
      } catch (err) {
        logGraphDegradedOnce(id, "plan.json", err);
        plans[id] = null;
        failed.push("plan.json");
      }

      try {
        // tailLines guards statSync but not the read itself, so an
        // existing-but-unopenable events.jsonl throws here.
        const rawLines = tailLines(path.join(dir, "events.jsonl"), 50);
        events[id] = rawLines.map((line) => {
          try {
            return JSON.parse(line);
          } catch (err) {
            return { raw: line };
          }
        });
        clearGraphDegraded(id, "events.jsonl");
      } catch (err) {
        logGraphDegradedOnce(id, "events.jsonl", err);
        events[id] = [];
        failed.push("events.jsonl");
      }

      if (failed.length > 0) degradedSources.set(id, failed);
    }

    const graph = buildSessionGraph({ sessions, plans, events });
    const nodes = graph.nodes.map((node) => {
      const sources = degradedSources.get(node.id);
      return sources
        ? { ...node, degraded: true, degraded_sources: sources }
        : { ...node, degraded: false, degraded_sources: [] };
    });
    res.json({ nodes, edges: graph.edges, generated_at: new Date().toISOString() });
  } catch (err) {
    // t24's error handler answers with a generic JSON body and logs the
    // real error (with its absolute paths) server-side only.
    next(err);
  }
});

app.get("/api/sessions/:id", async (req, res) => {
  const id = req.params.id;
  if (!SESSION_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: "invalid session id" });
  }
  const dir = sessionDir(id);
  if (!isPathInsideRunsDir(dir)) {
    return res.status(400).json({ error: "invalid session id" });
  }

  try {
    const run = await knex("runs").where({ id }).first();
    if (!run) {
      // Fall back to a direct filesystem check -- covers the window
      // where a brand-new run exists on disk but the sync loop hasn't
      // caught up to it yet.
      if (!fs.existsSync(dir)) {
        return res.status(404).json({ error: "session not found" });
      }
      return res.json(await readSessionFromDisk(id, dir));
    }

    const goalExists = fs.existsSync(path.join(dir, "goal.md"));

    const taskRows = await knex("tasks")
      .where({ run_id: id })
      .orderBy("id", "asc");
    const tasks = taskRows.map((t) => ({
      id: t.task_key,
      role: t.role,
      wave: t.wave,
      status: t.status,
      passing: t.passing === null ? null : !!t.passing,
      depends_on: safeJsonParse(t.depends_on, []),
      verify: safeJsonParse(t.verify, t.verify),
    }));

    let eventRows = await knex("events")
      .where({ run_id: id })
      .orderBy("id", "asc")
      .limit(50);
    // If the DB hasn't caught up yet for this run (no events synced
    // although the file has them), fall back to tailing the file
    // directly rather than showing a stale-empty log.
    let events;
    if (eventRows.length === 0) {
      const eventsPath = path.join(dir, "events.jsonl");
      const rawLines = tailLines(eventsPath, 50);
      events = rawLines.map((line) => {
        try {
          return JSON.parse(line);
        } catch (err) {
          return { raw: line };
        }
      });
    } else {
      events = eventRows.map((e) => ({
        ts: e.ts,
        type: e.type,
        from: e.from_actor,
        to: e.to_actor,
        summary: e.summary,
        task: e.task_key,
        wave: e.wave,
        status: e.status,
      }));
    }

    res.json({
      id,
      goal_exists: goalExists,
      state: normalizeSessionState({
        status: run.status,
        parent_session_id: run.parent_session_id,
      }),
      tasks,
      events,
    });
  } catch (err) {
    res.status(500).json({ error: "db read failed", detail: err.message });
  }
});

// The DB branch and the disk-fallback branch of GET /api/sessions/:id must
// agree on the shape of `state` -- otherwise a lineage edge visible before
// the first sync pass silently disappears (or turns from null into
// undefined) seconds later, once the run lands in the DB. Both branches go
// through here: `status` and `parent_session_id` are always present, and
// "no parent" is always the documented `null`, never `undefined`.
function normalizeSessionState(state) {
  const src = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  return {
    ...src,
    status: src.status ?? null,
    parent_session_id: src.parent_session_id ?? null,
  };
}

function safeJsonParse(str, fallback) {
  if (str === null || str === undefined) return fallback;
  try {
    return JSON.parse(str);
  } catch (err) {
    return fallback;
  }
}

// Direct-file fallback, used only when a run exists on disk but the DB
// sync loop hasn't picked it up yet (e.g. a run created moments ago).
async function readSessionFromDisk(id, dir) {
  const plan = readJsonSafe(path.join(dir, "plan.json"));
  const state = readJsonSafe(path.join(dir, "state.json"));
  const goalExists = fs.existsSync(path.join(dir, "goal.md"));

  const eventsPath = path.join(dir, "events.jsonl");
  const rawLines = tailLines(eventsPath, 50);
  const events = rawLines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      return { raw: line };
    }
  });

  return {
    id,
    goal_exists: goalExists,
    state: normalizeSessionState(state),
    tasks: plan && Array.isArray(plan.tasks) ? plan.tasks : plan || [],
    events,
  };
}

// ---------------------------------------------------------------------
// Skills library + per-run overrides.
//
// This is a console-app-only management/staging layer over the harness's
// own on-disk skill files (skills/liberta/SKILL.md, agents/*.md). Editing a
// skill here (library or per-run override) NEVER writes back to disk and
// NEVER changes what the actual harness controller/subagents execute --
// see console/README.md's "Skills" section for the full explanation.
// ---------------------------------------------------------------------
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

function skillListRow(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    source: row.source,
    description: row.description,
    updated_at: row.updated_at,
  };
}

app.get("/api/skills", async (req, res) => {
  try {
    const rows = await knex("skills").select("*").orderBy("name", "asc");
    res.json({ skills: rows.map(skillListRow) });
  } catch (err) {
    res.status(500).json({ error: "db read failed", detail: err.message });
  }
});

app.get("/api/skills/:name", async (req, res) => {
  const name = req.params.name;
  if (!SKILL_NAME_PATTERN.test(name)) {
    return res.status(400).json({ error: "invalid skill name" });
  }
  try {
    const row = await knex("skills").where({ name }).first();
    if (!row) return res.status(404).json({ error: "skill not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "db read failed", detail: err.message });
  }
});

app.put("/api/skills/:name", async (req, res) => {
  const name = req.params.name;
  if (!SKILL_NAME_PATTERN.test(name)) {
    return res.status(400).json({ error: "invalid skill name" });
  }
  const content = req.body && typeof req.body.content === "string" ? req.body.content : null;
  if (content === null) {
    return res.status(400).json({ error: "content (string) is required" });
  }
  try {
    const row = await knex("skills").where({ name }).first();
    if (!row) return res.status(404).json({ error: "skill not found" });
    await knex("skills").where({ name }).update({ content, updated_at: new Date() });
    const updated = await knex("skills").where({ name }).first();
    // Editing here always updates the DB library copy only -- the on-disk
    // file (for built-in skills) is left untouched and this response
    // makes that explicit rather than leaving it implicit.
    res.json({
      skill: updated,
      note:
        row.source === "built-in"
          ? "Updated the console's DB copy of this built-in skill. The on-disk file under skills/ or agents/ was not modified."
          : "Updated.",
    });
  } catch (err) {
    res.status(500).json({ error: "db write failed", detail: err.message });
  }
});

app.post("/api/skills", async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const kind = body.kind === "controller" ? "controller" : body.kind === "agent" ? "agent" : null;
  const content = typeof body.content === "string" ? body.content : "";
  const description = typeof body.description === "string" ? body.description : null;

  if (!SKILL_NAME_PATTERN.test(name)) {
    return res.status(400).json({ error: "name is required and must match ^[a-zA-Z0-9_.-]+$" });
  }
  if (!kind) {
    return res.status(400).json({ error: "kind must be 'controller' or 'agent'" });
  }
  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }

  try {
    const existing = await knex("skills").where({ name }).first();
    if (existing) {
      return res.status(409).json({ error: "a skill with this name already exists" });
    }
    const now = new Date();
    const [id] = await knex("skills").insert({
      name,
      kind,
      content,
      source: "imported", // forced server-side regardless of what the client sent
      description,
      created_at: now,
      updated_at: now,
    });
    const row = await knex("skills").where({ id }).first();
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: "db write failed", detail: err.message });
  }
});

app.delete("/api/skills/:name", async (req, res) => {
  const name = req.params.name;
  if (!SKILL_NAME_PATTERN.test(name)) {
    return res.status(400).json({ error: "invalid skill name" });
  }
  try {
    const row = await knex("skills").where({ name }).first();
    if (!row) return res.status(404).json({ error: "skill not found" });
    if (row.source !== "imported") {
      return res.status(403).json({ error: "only imported skills can be deleted" });
    }
    await knex("skills").where({ name }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "db write failed", detail: err.message });
  }
});

// Per-run effective skill set: every library skill, flagged `overridden`
// and, when overridden, showing the override's content in place of the
// library content.
app.get("/api/sessions/:id/skills", async (req, res) => {
  const id = req.params.id;
  if (!SESSION_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: "invalid session id" });
  }
  try {
    const skills = await knex("skills").select("*").orderBy("name", "asc");
    const overrides = await knex("run_skill_overrides").where({ run_id: id });
    const overrideByName = new Map(overrides.map((o) => [o.skill_name, o]));
    const merged = skills.map((s) => {
      const override = overrideByName.get(s.name);
      if (override) {
        return {
          id: s.id,
          name: s.name,
          kind: s.kind,
          source: s.source,
          description: s.description,
          overridden: true,
          content: override.content,
          library_content: s.content,
          override_updated_at: override.updated_at,
        };
      }
      return {
        id: s.id,
        name: s.name,
        kind: s.kind,
        source: s.source,
        description: s.description,
        overridden: false,
        content: s.content,
        library_content: s.content,
        override_updated_at: null,
      };
    });
    res.json({ run_id: id, skills: merged });
  } catch (err) {
    res.status(500).json({ error: "db read failed", detail: err.message });
  }
});

app.put("/api/sessions/:id/skills/:name", async (req, res) => {
  const id = req.params.id;
  const name = req.params.name;
  if (!SESSION_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: "invalid session id" });
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return res.status(400).json({ error: "invalid skill name" });
  }
  const content = req.body && typeof req.body.content === "string" ? req.body.content : null;
  if (content === null) {
    return res.status(400).json({ error: "content (string) is required" });
  }
  try {
    const skill = await knex("skills").where({ name }).first();
    if (!skill) return res.status(404).json({ error: "skill not found in library" });

    const existing = await knex("run_skill_overrides")
      .where({ run_id: id, skill_name: name })
      .first();
    const now = new Date();
    if (existing) {
      await knex("run_skill_overrides")
        .where({ run_id: id, skill_name: name })
        .update({ content, updated_at: now });
    } else {
      await knex("run_skill_overrides").insert({
        run_id: id,
        skill_name: name,
        content,
        updated_at: now,
      });
    }
    const row = await knex("run_skill_overrides")
      .where({ run_id: id, skill_name: name })
      .first();
    res.json({ override: row });
  } catch (err) {
    res.status(500).json({ error: "db write failed", detail: err.message });
  }
});

app.delete("/api/sessions/:id/skills/:name", async (req, res) => {
  const id = req.params.id;
  const name = req.params.name;
  if (!SESSION_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: "invalid session id" });
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return res.status(400).json({ error: "invalid skill name" });
  }
  try {
    const deleted = await knex("run_skill_overrides")
      .where({ run_id: id, skill_name: name })
      .del();
    if (!deleted) {
      return res.status(404).json({ error: "no override set for this run/skill" });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "db write failed", detail: err.message });
  }
});

// ---------------------------------------------------------------------
// Session inbox (steer/question/info messages) -- read/write surface
// over the on-disk format scripts/_mailbox.mjs owns. We reimplement the
// same read/write logic here (rather than shelling out to _mailbox.mjs)
// to avoid a child-process/arg-injection surface; file naming and JSON
// shape are kept byte-compatible so `_mailbox.mjs list/reply` keep
// working against files the API wrote, and vice versa.
// ---------------------------------------------------------------------

const INBOX_TYPES = ["steer", "question", "info"];
const INBOX_FILENAME_PATTERN = /^[A-Za-z0-9_.-]+\.json$/;

function inboxDir(id) {
  return path.join(sessionDir(id), "inbox");
}

function inboxArchiveDir(id) {
  return path.join(inboxDir(id), "archive");
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  // Message files carry operator-authored steer/question text: keep them
  // readable/writable by the owner only (not group/world), overriding the
  // process umask.
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

// Per-run cap on pending (unarchived) inbox messages -- keeps an
// authenticated-but-abusive caller from filling disk one JSON file at a
// time.
const MAX_PENDING_MESSAGES = 500;
// Hard caps on how much listInboxMessages will read+parse in one pass, so a
// directory with an unexpectedly large number/size of files can't block the
// single-threaded console for the duration of one request.
const MAX_LIST_FILES = 2000;
const MAX_LIST_BYTES = 25 * 1024 * 1024; // 25MB
// Per-FILE cap, checked against lstat().size BEFORE any read. The whole-pass
// MAX_LIST_BYTES budget above can only stop the *next* file, so on its own it
// does nothing about a single huge one: the API caps a message body at 8000
// chars, but scripts/_mailbox.mjs (and any other local process) writes into
// these directories uncapped, and archive/ grows without limit. Reading one
// such file with the synchronous readFileSync below would stall -- or OOM --
// the single-threaded console for the length of the read.
const MAX_MESSAGE_BYTES = 256 * 1024; // 256KB

// Read a JSON file, but only if it's a regular file (not a symlink, fifo,
// device, etc). Symlinks inside a run's inbox directory could otherwise be
// used to read arbitrary files elsewhere on disk via this "list the inbox"
// codepath, since fs.statSync (unlike fs.lstatSync) follows symlinks.
function readRegularJsonSafe(filePath) {
  let lst;
  try {
    lst = fs.lstatSync(filePath);
  } catch {
    return null;
  }
  if (!lst.isFile()) return null;
  // Refuse to buffer something far too large to be a message (see
  // MAX_MESSAGE_BYTES) -- checked before the blocking read, not after.
  if (lst.size > MAX_MESSAGE_BYTES) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// readdirSync throws ENOTDIR (not ENOENT) when the path exists but is a
// regular file -- e.g. someone dropped a file literally named `inbox` into a
// run directory. Callers want the same "nothing to list" behaviour they get
// for a missing directory for the *absent* case, but a clean, explicit error
// for the not-a-directory case rather than an unhandled 500.
class InboxNotADirectoryError extends Error {
  constructor() {
    super("inbox path exists but is not a directory");
    this.code = "INBOX_NOT_A_DIRECTORY";
  }
}

function readdirInboxSafe(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    if (err.code === "ENOTDIR") throw new InboxNotADirectoryError();
    throw err;
  }
}

function countPendingMessages(id) {
  const files = readdirInboxSafe(inboxDir(id));
  let count = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(inboxDir(id), f);
    let lst;
    try {
      lst = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (lst.isFile()) count += 1;
  }
  return count;
}

// A message file is only JSON-parseable, not trustworthy: `[1,2,3]`,
// `"just a string"` and `null` all parse fine, and reading .type/.text/.ts
// off them yielded `undefined`, which JSON.stringify then DROPS -- so the
// response contained entries missing the very keys every consumer indexes.
// Reject anything that isn't an object carrying a usable message shape, and
// always emit the full key set for the ones we keep.
function normalizeInboxMessage(filename, msg, archived) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  if (typeof msg.type !== "string" || msg.type.length === 0) return null;
  if (typeof msg.text !== "string" || msg.text.length === 0) return null;
  const ts = typeof msg.ts === "string" && Number.isFinite(Date.parse(msg.ts)) ? msg.ts : null;
  return {
    filename,
    type: msg.type,
    text: msg.text,
    ts,
    reply: typeof msg.reply === "string" ? msg.reply : null,
    replied_ts: typeof msg.replied_ts === "string" ? msg.replied_ts : null,
    archived,
  };
}

// Undated entries sort last (Infinity), never above a dated one.
function messageSortKey(m) {
  const t = Date.parse(m.ts || "");
  return Number.isFinite(t) ? t : Infinity;
}

function listInboxMessages(id) {
  const dir = inboxDir(id);
  const archive = inboxArchiveDir(id);
  const messages = [];
  let filesRead = 0;
  let bytesRead = 0;

  function collect(base, archived) {
    if (filesRead >= MAX_LIST_FILES || bytesRead >= MAX_LIST_BYTES) return;
    const entries = readdirInboxSafe(base);
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      if (filesRead >= MAX_LIST_FILES || bytesRead >= MAX_LIST_BYTES) break;
      const full = path.join(base, f);
      let lst;
      try {
        lst = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!lst.isFile()) continue; // skips the archive/ subdir and any symlinks
      // Size check BEFORE the read: never call readFileSync on a file we
      // already know is too big to be a message (see MAX_MESSAGE_BYTES).
      if (lst.size > MAX_MESSAGE_BYTES) continue;
      filesRead += 1;
      bytesRead += lst.size;
      const msg = readRegularJsonSafe(full);
      const normalized = normalizeInboxMessage(f, msg, archived);
      if (!normalized) continue;
      messages.push(normalized);
    }
  }

  collect(dir, false);
  collect(archive, true);

  // Oldest first. An entry whose ts is missing/unparsable has no position
  // on the timeline, so it sorts AFTER every dated entry (previously
  // `Date.parse(undefined) || 0` sent it to the very top, so a chat UI
  // rendered junk as the oldest messages); ties fall back to filename,
  // which is itself timestamp-prefixed, for a stable order.
  messages.sort((a, b) => {
    const ta = messageSortKey(a);
    const tb = messageSortKey(b);
    if (ta !== tb) return ta - tb;
    return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0;
  });

  return messages;
}

// Shared by the inbox GET and POST: a run has to actually exist. On GET
// this is the difference between "this run has no messages" and "this run
// does not exist" (it used to answer 200 {"messages":[]} for any
// well-formed id); on POST it also stops an authenticated caller minting
// junk run directories under LIBERTA_RUNS_DIR.
async function sessionExists(id) {
  try {
    const run = await knex("runs").where({ id }).first();
    if (run) return true;
  } catch {
    // DB unavailable -- fall through to the filesystem check.
  }
  return fs.existsSync(sessionDir(id));
}

function sendInboxError(res, err, context) {
  if (err instanceof InboxNotADirectoryError) {
    return res.status(409).json({ error: "inbox path is not a directory" });
  }
  console.error(context, err);
  return res.status(500).json({ error: "inbox read failed" });
}

app.get("/api/sessions/:id/inbox", async (req, res) => {
  const id = req.params.id;
  if (!SESSION_ID_PATTERN.test(id) || !isPathInsideRunsDir(sessionDir(id))) {
    return res.status(400).json({ error: "invalid session id" });
  }
  try {
    if (!(await sessionExists(id))) {
      return res.status(404).json({ error: "session not found" });
    }
    const messages = listInboxMessages(id);
    res.json({ run_id: id, messages });
  } catch (err) {
    return sendInboxError(res, err, `inbox read failed for session ${id}:`);
  }
});

app.post("/api/sessions/:id/inbox", async (req, res) => {
  const id = req.params.id;
  if (!SESSION_ID_PATTERN.test(id) || !isPathInsideRunsDir(sessionDir(id))) {
    return res.status(400).json({ error: "invalid session id" });
  }
  const body = req.body || {};
  const type = body.type === undefined || body.type === null || body.type === "" ? "steer" : body.type;
  if (!INBOX_TYPES.includes(type)) {
    return res.status(400).json({ error: "type must be one of steer|question|info" });
  }
  const text = body.text;
  if (typeof text !== "string" || text.length === 0) {
    return res.status(400).json({ error: "text (non-empty string) is required" });
  }
  if (text.length > 8000) {
    return res.status(400).json({ error: "text exceeds 8000 characters" });
  }

  try {
    // The run must actually exist -- otherwise an authenticated caller
    // could mint unlimited junk run directories under LIBERTA_RUNS_DIR
    // just by POSTing to any id that passes the pattern+containment
    // checks, which also pollutes the dashboard's disk-fallback session
    // listing. Mirrors the existing-run check in GET /api/sessions/:id.
    if (!(await sessionExists(id))) {
      return res.status(404).json({ error: "session not found" });
    }

    if (countPendingMessages(id) >= MAX_PENDING_MESSAGES) {
      return res.status(429).json({ error: "inbox is full, wait for pending messages to be processed" });
    }

    const dir = inboxDir(id);
    // mkdirSync would throw EEXIST/ENOTDIR if `inbox` exists as a regular
    // file; report that as a clean error instead of an unhandled 500.
    let inboxLst = null;
    try {
      inboxLst = fs.lstatSync(dir);
    } catch {
      inboxLst = null;
    }
    if (inboxLst && !inboxLst.isDirectory()) {
      throw new InboxNotADirectoryError();
    }
    fs.mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString();
    const stamp = ts.replace(/[:.]/g, "-");
    const rand = crypto.randomBytes(3).toString("hex");
    const filename = `${stamp}-${type}-${rand}.json`;
    const filePath = path.join(dir, filename);

    const msg = { type, text, ts };
    writeJsonAtomic(filePath, msg);

    res.status(201).json({ ok: true, message: { filename, ...msg } });
  } catch (err) {
    if (err instanceof InboxNotADirectoryError) {
      return res.status(409).json({ error: "inbox path is not a directory" });
    }
    console.error(`inbox write failed for session ${id}:`, err);
    res.status(500).json({ error: "inbox write failed" });
  }
});

app.get("/api/sessions/:id/inbox/:filename", async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  if (!SESSION_ID_PATTERN.test(id) || !isPathInsideRunsDir(sessionDir(id))) {
    return res.status(400).json({ error: "invalid session id" });
  }
  if (
    !INBOX_FILENAME_PATTERN.test(filename) ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return res.status(400).json({ error: "invalid filename" });
  }

  const pendingPath = path.join(inboxDir(id), filename);
  const archivedPath = path.join(inboxArchiveDir(id), filename);
  if (!isPathInsideRunsDir(pendingPath) || !isPathInsideRunsDir(archivedPath)) {
    return res.status(400).json({ error: "invalid filename" });
  }

  try {
    let msg = readRegularJsonSafe(pendingPath);
    let archived = false;
    if (!msg) {
      msg = readRegularJsonSafe(archivedPath);
      archived = true;
    }
    if (!msg) {
      return res.status(404).json({ error: "message not found" });
    }
    const normalized = normalizeInboxMessage(filename, msg, archived);
    if (!normalized) {
      // Parsed, but not a message (see normalizeInboxMessage) -- say so
      // rather than emitting an object with keys silently missing.
      return res.status(422).json({ error: "message file is malformed" });
    }
    res.json(normalized);
  } catch (err) {
    return sendInboxError(res, err, `inbox read failed for session ${id}, file ${filename}:`);
  }
});

// ---------------------------------------------------------------------
// Dashboard (authenticated, served after the global auth middleware ran)
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// ---------------------------------------------------------------------
// Error handler -- LAST, so it catches errors from every layer above,
// including body-parser (which runs before auth, so its errors were
// reaching unauthenticated callers). Express's default handler renders an
// HTML stack trace containing absolute filesystem paths and node_modules
// internals; every client of this app speaks JSON, so answer with a small
// JSON object carrying no stack frame and no path.
// ---------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const status = Number(err && (err.status || err.statusCode)) || 500;
  let message;
  if (err && err.type === "entity.too.large") {
    message = "request body too large";
  } else if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    message = "malformed JSON body";
  } else if (err && err.type === "encoding.unsupported") {
    message = "unsupported content encoding";
  } else if (status >= 400 && status < 500) {
    message = "bad request";
  } else {
    message = "internal server error";
  }
  // Detail (with the stack) goes to the server log only, never the wire.
  if (status >= 500) {
    console.error("unhandled error:", (err && (err.stack || err.message)) || err);
  }
  res.status(status).json({ error: message });
});

// ---------------------------------------------------------------------
// Bind the port, then boot the DB. Order matters twice over:
//
// 1. Bind before mutating anything. A second console that loses the port
//    race must not have already created/altered a database file, so the
//    schema/seed/sync steps only run AFTER app.listen's callback fires.
// 2. The sqlite mirror's filename is a function of the port this process
//    actually ends up bound to (see db.js's resolveDbFile), which is only
//    known for certain once the bind succeeds -- PORT_AUTO can move it up
//    from the requested port. So initDb() is called from inside the
//    listen callback with the REAL bound port, never with the requested
//    one.
//
// Binding itself: attempt `port`; if that's taken (EADDRINUSE), either
// scan upward for a free one (PORT_AUTO) or exit non-zero with a clear,
// actionable one-line message. Every other listen error also gets a
// clear message and a non-zero exit instead of an unhandled stack trace.
// ---------------------------------------------------------------------
function listenWithRetry(port, triesLeft, onListening) {
  const server = app.listen(port, HOST, () => {
    // Read the real bound port back off the OS rather than trusting the
    // `port` we asked for: PORT=0 asks the OS for an arbitrary free port
    // (used by some test harnesses), and PORT_AUTO's retries also want the
    // port actually granted, not merely the one requested.
    const boundPort = server.address().port;
    if (PORT_AUTO && boundPort !== PORT) {
      process.stdout.write(
        "NOTE: the requested PORT was already in use; " +
          `LIBERTA_CONSOLE_PORT_AUTO picked free port ${boundPort} instead.\n`
      );
    }
    // NOTE: the wording/format of the line below is a contract --
    // console/scripts/shot.mjs matches "listening on http://localhost:<port>"
    // on the child's stdout to prove the console it screenshots is the one
    // it started. Don't reword it (the bind host deliberately isn't in it).
    process.stdout.write(`liberta-console listening on http://localhost:${boundPort}\n`);
    onListening(boundPort);
  });

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      if (PORT_AUTO && triesLeft > 0) {
        listenWithRetry(port + 1, triesLeft - 1, onListening);
        return;
      }
      if (PORT_AUTO) {
        process.stderr.write(
          `FATAL: port ${PORT} and the ${PORT_AUTO_MAX_TRIES} ports above it ` +
            "are all in use. Free one of them, set PORT to an open port, or " +
            "stop the other console(s) and try again.\n"
        );
      } else {
        process.stderr.write(
          `FATAL: port ${port} is already in use (probably another ` +
            "liberta-console instance). Set PORT to a free port, or set " +
            "LIBERTA_CONSOLE_PORT_AUTO=1 to have this instance pick the next " +
            "free port automatically.\n"
        );
      }
      process.exit(1);
      return;
    }
    process.stderr.write(
      `FATAL: failed to start liberta-console: ${(err && err.message) || err}\n`
    );
    process.exit(1);
  });
}

// ---------------------------------------------------------------------
// Boot: bind the port first (see listenWithRetry above), then -- once the
// real port is known -- create the DB connection scoped to it, ensure its
// schema, seed it, and start the background file->DB sync loop. The DB is
// a read cache synced from the file-based run store -- the harness itself
// still writes files; see db.js/sync.js and the README's "Database"
// section.
// ---------------------------------------------------------------------
async function main() {
  listenWithRetry(PORT, PORT_AUTO_MAX_TRIES, async (boundPort) => {
    try {
      initDb(boundPort);
      await ensureSchema();
      await seedSkillsFromDisk();
      startSyncLoop();
    } catch (err) {
      process.stderr.write(
        `FATAL: failed to initialize liberta-console database: ${(err && err.stack) || err}\n`
      );
      process.exit(1);
    }
  });
}

main().catch((err) => {
  process.stderr.write(`FATAL: failed to start liberta-console: ${err.stack || err}\n`);
  process.exit(1);
});
