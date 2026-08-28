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
  timingSafeStringEqual,
  createLoginRateLimiter,
} = require("./auth");
const { tailLines } = require("./tail");

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
const PUBLIC_PATHS = new Set(["/login", "/logout"]);

function isAuthed(req) {
  const cookie = req.cookies && req.cookies[COOKIE_NAME];
  return verifySessionCookie(cookie, SESSION_SECRET);
}

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }
  if (isAuthed(req)) {
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
function renderLoginPage({ error } = {}) {
  const errorHtml = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Linda Console - Login</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #0f1216; color: #e6e6e6; display: flex; align-items: center;
         justify-content: center; height: 100vh; margin: 0; }
  form { background: #1a1f27; padding: 2rem 2.5rem; border-radius: 10px;
         box-shadow: 0 4px 24px rgba(0,0,0,0.4); width: 280px; }
  h1 { font-size: 1.1rem; margin: 0 0 1.2rem; color: #9fb3ff; }
  input[type=password] { width: 100%; padding: 0.6rem; border-radius: 6px;
         border: 1px solid #333; background: #0f1216; color: #eee; box-sizing: border-box; }
  button { margin-top: 1rem; width: 100%; padding: 0.6rem; border-radius: 6px;
         border: none; background: #4c6ef5; color: white; font-weight: 600; cursor: pointer; }
  button:hover { background: #3b5bdb; }
  .error { color: #ff6b6b; font-size: 0.85rem; margin: 0 0 0.8rem; }
</style>
</head>
<body>
  <form method="POST" action="/login">
    <h1>Linda Console</h1>
    ${errorHtml}
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">Log in</button>
  </form>
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
  res.type("html").send(renderLoginPage());
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

app.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.redirect("/login");
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
app.get("/api/sessions", (req, res) => {
  const idx = readIndex();
  const sessions = idx.sessions.map((s) => {
    const dir = sessionDir(s.id);
    let liveStatus = s.status;
    if (isPathInsideRunsDir(dir)) {
      const state = readJsonSafe(path.join(dir, "state.json"));
      if (state && state.status) {
        liveStatus = state.status;
      }
    }
    return {
      id: s.id,
      project_path: s.project_path,
      status: liveStatus,
      is_active: idx.active_session_id === s.id,
    };
  });
  res.json({ active_session_id: idx.active_session_id, sessions });
});

app.get("/api/sessions/:id", (req, res) => {
  const id = req.params.id;
  if (!SESSION_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: "invalid session id" });
  }
  const dir = sessionDir(id);
  if (!isPathInsideRunsDir(dir)) {
    return res.status(400).json({ error: "invalid session id" });
  }
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: "session not found" });
  }

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

  res.json({
    id,
    goal_exists: goalExists,
    state: state || null,
    tasks: plan && Array.isArray(plan.tasks) ? plan.tasks : plan || [],
    events,
  });
});

// ---------------------------------------------------------------------
// Dashboard (authenticated, served after the global auth middleware ran)
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.listen(PORT, () => {
  process.stdout.write(`linda-console listening on http://localhost:${PORT}\n`);
});
