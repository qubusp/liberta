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
const { knex, ensureSchema, seedSkillsFromDisk } = require("./db");
const { startSyncLoop } = require("./sync");
const oauth = require("./auth-oauth");

// ---------------------------------------------------------------------
// Boot-time password check. Never fall back to a default/blank password
// -- fail loudly and refuse to start instead.
// ---------------------------------------------------------------------
const ADMIN_PASSWORD = process.env.LINDA_CONSOLE_PASSWORD;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length === 0) {
  process.stderr.write(
    "FATAL: LINDA_CONSOLE_PASSWORD is not set. Refusing to start with no " +
      "password configured. Set LINDA_CONSOLE_PASSWORD and try again.\n"
  );
  process.exit(1);
}

// Secret used to HMAC-sign session cookies. If LINDA_CONSOLE_SECRET isn't
// given, generate a random one at boot -- sessions won't survive a
// restart in that case (every restart invalidates all existing session
// cookies), which is fine for a personal tool but worth a clear warning.
let SESSION_SECRET = process.env.LINDA_CONSOLE_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length === 0) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  process.stderr.write(
    "WARNING: LINDA_CONSOLE_SECRET is not set. Generated a random " +
      "session secret at boot -- all sessions will be invalidated on the " +
      "next restart. Set LINDA_CONSOLE_SECRET to a stable value to avoid " +
      "this.\n"
  );
}

const LINDA_RUNS_DIR = path.join(os.homedir(), ".claude", "linda-runs");
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

const PORT = process.env.PORT ? Number(process.env.PORT) : 4177;

const app = express();
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

app.use(async (req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }
  const principal = await resolvePrincipal(req);
  if (principal) {
    req.principal = principal;
    return next();
  }
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return res.redirect("/login");
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
<title>Linda Console - Login</title>
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
        <h1>Linda Console</h1>
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
const OAUTH_STATE_COOKIE = "linda_oauth_state";
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

function readIndex() {
  const idx = readJsonSafe(path.join(LINDA_RUNS_DIR, "index.json"));
  if (!idx || !Array.isArray(idx.sessions)) {
    return { active_session_id: null, sessions: [] };
  }
  return idx;
}

function sessionDir(id) {
  return path.join(LINDA_RUNS_DIR, id);
}

// Defense in depth on top of the regex allowlist check callers already do:
// confirm the resolved path is actually still inside LINDA_RUNS_DIR before
// touching the filesystem with it.
function isPathInsideRunsDir(p) {
  const resolved = path.resolve(p);
  const base = path.resolve(LINDA_RUNS_DIR) + path.sep;
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
      state: run.status ? { status: run.status } : null,
      tasks,
      events,
    });
  } catch (err) {
    res.status(500).json({ error: "db read failed", detail: err.message });
  }
});

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
    state: state || null,
    tasks: plan && Array.isArray(plan.tasks) ? plan.tasks : plan || [],
    events,
  };
}

// ---------------------------------------------------------------------
// Skills library + per-run overrides.
//
// This is a console-app-only management/staging layer over the harness's
// own on-disk skill files (skills/linda/SKILL.md, agents/*.md). Editing a
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
// Dashboard (authenticated, served after the global auth middleware ran)
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// ---------------------------------------------------------------------
// Boot: ensure the DB schema exists, start the background file->DB sync
// loop, then start listening. The DB is a read cache synced from the
// file-based run store -- the harness itself still writes files; see
// db.js/sync.js and the README's "Database" section.
// ---------------------------------------------------------------------
async function main() {
  await ensureSchema();
  await seedSkillsFromDisk();
  startSyncLoop();
  app.listen(PORT, () => {
    process.stdout.write(`linda-console listening on http://localhost:${PORT}\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`FATAL: failed to start linda-console: ${err.stack || err}\n`);
  process.exit(1);
});
