"use strict";

// Tiny hand-rolled signed-cookie session helper built on Node's crypto.
// No JWT library, no session store on disk/db -- sessions are just a
// base64url JSON payload plus an HMAC-SHA256 signature over that payload,
// verified with a timing-safe comparison. Chosen over cookie-parser's
// "signed cookie" helper only because writing it ourselves makes the
// exact verification steps (constant-time compare, expiry check) explicit
// and auditable in one small file.

const crypto = require("crypto");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_NAME = "linda_console_session";

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64url(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

function sign(payloadB64, secret) {
  return base64url(
    crypto.createHmac("sha256", secret).update(payloadB64).digest()
  );
}

// Constant-time compare of two strings of possibly-different length.
// crypto.timingSafeEqual throws if the buffers differ in length, which
// would itself leak a timing/behavioral signal (and crash the request) if
// called carelessly -- so we only ever call it on two equal-length
// buffers, and otherwise short-circuit to a plain `false` without ever
// branching on the *content* of the untrusted input.
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Generic signed-payload cookie helpers. Both the password-login session
// cookie and the OAuth-login session cookie are built on these -- same
// base64url-JSON-plus-HMAC-SHA256 shape, same verification steps
// (constant-time signature compare, then expiry check). Keeping this as
// one underlying mechanism (rather than two separate cookie formats) is
// what lets a single auth middleware verify either kind of login with
// one code path -- see server.js.
function makeSignedPayloadCookie(payload, secret) {
  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

// Returns the parsed payload object if the cookie's signature is valid
// and it isn't expired, otherwise `null`. Callers that only care about
// "is this a valid, unexpired signed cookie at all" (e.g. a short-lived
// CSRF state cookie) can just check the return value is truthy; callers
// that need to distinguish payload shapes (e.g. the auth middleware
// distinguishing a password session from an OAuth session) inspect the
// returned fields.
function verifySignedPayloadCookie(cookieValue, secret) {
  if (!cookieValue || typeof cookieValue !== "string") return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  const expectedSig = sign(payloadB64, secret);
  if (!timingSafeStringEqual(sig, expectedSig)) return null;

  let payload;
  try {
    payload = JSON.parse(fromBase64url(payloadB64).toString("utf8"));
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload.exp !== "number") return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

function makeSessionCookie(secret) {
  const sid = crypto.randomBytes(24).toString("hex");
  const exp = Date.now() + SESSION_TTL_MS;
  return makeSignedPayloadCookie({ sid, exp }, secret);
}

// Unchanged external behavior for existing callers: returns a boolean.
// Password-login sessions are stateless (the signed cookie itself is the
// whole session, no DB row), so "valid signature + not expired" is
// sufficient here -- this deliberately does NOT accept an OAuth-session
// payload (one with a `wsid` field), since that kind of session needs a
// live `web_sessions` DB row checked too; see
// `verifyOAuthSessionCookiePayload` / server.js's combined middleware.
function verifySessionCookie(cookieValue, secret) {
  const payload = verifySignedPayloadCookie(cookieValue, secret);
  if (!payload) return false;
  if (payload.wsid) return false;
  return true;
}

// Builds the OAuth-login session cookie: signed payload carrying a
// reference to a `web_sessions.id` row plus its own expiry (mirrors the
// row's `expires_at`, so an expired-but-not-yet-cleaned-up DB row can't
// keep a cookie valid past its stated lifetime).
function makeOAuthSessionCookie(webSessionId, expiresAtMs, secret) {
  return makeSignedPayloadCookie({ wsid: webSessionId, exp: expiresAtMs }, secret);
}

// Returns the `web_sessions.id` referenced by a valid, unexpired
// OAuth-session cookie, or `null` if the cookie isn't a valid OAuth
// session cookie at all (wrong signature, expired, or it's actually a
// password-login cookie with no `wsid`).
function verifyOAuthSessionCookiePayload(cookieValue, secret) {
  const payload = verifySignedPayloadCookie(cookieValue, secret);
  if (!payload || !payload.wsid) return null;
  return payload.wsid;
}

// Simple in-memory sliding-window rate limiter, keyed by IP.
// This is safe *only* because linda-console runs as a single Node
// process with no clustering -- if this ever runs behind a multi-process
// cluster or gets load-balanced across instances, this in-memory map
// stops being a shared view and the effective limit becomes
// limit * instance-count. Fine for a single-operator local tool.
function createLoginRateLimiter({ windowMs = 60 * 1000, max = 10 } = {}) {
  const hits = new Map(); // ip -> array of timestamps

  function isAllowed(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length <= max;
  }

  return { isAllowed };
}

module.exports = {
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
};
