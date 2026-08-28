"use strict";

// ---------------------------------------------------------------------
// GitHub OAuth2 (web application flow), hand-rolled with the global
// `fetch` (Node 18+) instead of a client library, to keep this console's
// dependency footprint small -- matches the reasoning already documented
// in auth.js for hand-rolling the signed-cookie session helper instead of
// pulling in a session-store library.
//
// This is a SECOND, optional login method layered on top of the existing
// password login (see auth.js/server.js) -- it never replaces it. If none
// of the OAuth env vars are set, this module quietly reports itself as
// "not configured" and the rest of the app must not depend on it at all.
// ---------------------------------------------------------------------

const crypto = require("crypto");

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

const CLIENT_ID = process.env.LINDA_OAUTH_GITHUB_CLIENT_ID;
const CLIENT_SECRET = process.env.LINDA_OAUTH_GITHUB_CLIENT_SECRET;
const CALLBACK_URL = process.env.LINDA_OAUTH_CALLBACK_URL;
const ALLOWED_USERS_RAW = process.env.LINDA_ALLOWED_GITHUB_USERS;

const OAUTH_CONFIGURED = !!(CLIENT_ID && CLIENT_ID.length > 0 && CLIENT_SECRET && CLIENT_SECRET.length > 0);

// ---------------------------------------------------------------------
// Fail-closed check, run at module-load time (i.e. at server boot, same
// timing as the existing LINDA_CONSOLE_PASSWORD/DB_CLIENT checks in
// server.js/db.js): if OAuth credentials are configured but no allowlist
// is given, refuse to start rather than silently let any GitHub account
// in. This mirrors the "never fall back to a permissive default" rule
// the password check already follows.
// ---------------------------------------------------------------------
let ALLOWED_USERS = new Set();
if (OAUTH_CONFIGURED) {
  const parsed = (ALLOWED_USERS_RAW || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (parsed.length === 0) {
    process.stderr.write(
      "FATAL: LINDA_OAUTH_GITHUB_CLIENT_ID/_SECRET are set but " +
        "LINDA_ALLOWED_GITHUB_USERS is empty or unset. Refusing to start " +
        "with GitHub OAuth enabled and no allowlist -- that would let any " +
        "GitHub account log in. Set LINDA_ALLOWED_GITHUB_USERS to a " +
        "comma-separated list of allowed GitHub usernames and try again.\n"
    );
    process.exit(1);
  }
  ALLOWED_USERS = new Set(parsed);
  if (!CALLBACK_URL || CALLBACK_URL.length === 0) {
    process.stderr.write(
      "FATAL: LINDA_OAUTH_GITHUB_CLIENT_ID/_SECRET are set but " +
        "LINDA_OAUTH_CALLBACK_URL is empty or unset. Set it to the exact " +
        "callback URL registered on the GitHub OAuth App (e.g. " +
        "http://localhost:4177/auth/github/callback) and try again.\n"
    );
    process.exit(1);
  }
}

function isOAuthConfigured() {
  return OAUTH_CONFIGURED;
}

function isUserAllowed(username) {
  if (!username) return false;
  return ALLOWED_USERS.has(String(username).trim().toLowerCase());
}

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    scope: "read:user",
    state,
    allow_signup: "false",
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

function generateState() {
  return crypto.randomBytes(24).toString("hex");
}

// Exchanges an authorization `code` for an access token, fetches the
// GitHub profile, and checks it against the allowlist. Returns
// {ok:true, profile:{provider_user_id, username, display_name, avatar_url}}
// or {ok:false, reason: "..."}.
async function handleCallback(code) {
  if (!OAUTH_CONFIGURED) {
    return { ok: false, reason: "not_configured" };
  }
  if (!code || typeof code !== "string") {
    return { ok: false, reason: "missing_code" };
  }

  let tokenJson;
  try {
    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: CALLBACK_URL,
      }),
    });
    if (!tokenRes.ok) {
      return { ok: false, reason: "exchange_failed" };
    }
    tokenJson = await tokenRes.json();
  } catch (err) {
    return { ok: false, reason: "exchange_failed" };
  }

  if (!tokenJson || tokenJson.error || !tokenJson.access_token) {
    return { ok: false, reason: "exchange_failed" };
  }

  let profileJson;
  try {
    const profileRes = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "linda-console",
      },
    });
    if (!profileRes.ok) {
      return { ok: false, reason: "profile_fetch_failed" };
    }
    profileJson = await profileRes.json();
  } catch (err) {
    return { ok: false, reason: "profile_fetch_failed" };
  }

  const username = profileJson && profileJson.login;
  if (!username) {
    return { ok: false, reason: "profile_fetch_failed" };
  }

  if (!isUserAllowed(username)) {
    return { ok: false, reason: "not_allowlisted" };
  }

  return {
    ok: true,
    profile: {
      provider_user_id: String(profileJson.id),
      username: profileJson.login,
      display_name: profileJson.name || profileJson.login,
      avatar_url: profileJson.avatar_url || null,
    },
  };
}

module.exports = {
  isOAuthConfigured,
  buildAuthorizeUrl,
  generateState,
  handleCallback,
  isUserAllowed,
};
