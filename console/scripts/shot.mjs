#!/usr/bin/env node
"use strict";

// shot.mjs -- shared browser-evidence tool for Liberta visual tasks.
//
// The console's dashboard and every /api/* route sit behind auth (see
// console/server.js), so a bare screenshot of /login proves nothing about
// what a logged-in operator actually sees. This script:
//   1. ALWAYS boots its OWN console child process, with credentials
//      generated fresh for this invocation, bound to a literal loopback
//      address:port that it holds exclusively -- and tears it down on
//      exit. It never attaches to, and cannot be shadowed by, a
//      pre-existing listener (see PORT SELECTION below);
//   2. logs in over HTTP to obtain the real signed session cookie (using
//      the exact cookie name exported by console/auth.js, never a
//      hardcoded guess);
//   3. drives real Chrome (via puppeteer-core, reusing the system Chrome
//      install -- no ~300MB puppeteer/playwright browser download) with
//      that cookie set, navigates to the requested path, optionally runs
//      a caller-supplied interaction script, and captures full-page PNGs
//      at both a wide (1440x900) and a narrow (390x844) viewport;
//   4. hard-fails (non-zero exit, clear message, and NO PNG left behind)
//      unless the page being captured positively proves it is the
//      authenticated dashboard. See assertAuthenticatedCapture below.
//
// AUTH GUARD: POSITIVE ALLOWLIST, NOT A BLOCKLIST.
//
// An earlier version of this script only rejected a capture when
// input[name=password] was present. That is a blocklist, and it was
// defeated: a --script hook that cleared cookies and navigated to
// /api/sessions rendered the plain-text body {"error":"unauthorized"},
// which contains no password input -- so the tool exited 0 and wrote two
// real PNGs of an UNAUTHENTICATED page. Since these PNGs are the evidence
// path for every downstream visual task, the guard is now an allowlist: a
// capture is valid only if the page positively demonstrates all of
//   - the DEFAULT authenticated-dashboard markers are in the live DOM
//     (#sessions-table AND #whoami, which exist only in
//     console/public/dashboard.html, served behind auth) -- these are
//     ALWAYS required and cannot be switched off from the command line;
//   - every selector passed with --expect-selector is ALSO present;
//   - document.contentType is text/html (any JSON/plain-text error body,
//     such as the /api/sessions 401 payload, fails here);
//   - the page URL is same-origin with the harness base URL;
//   - input[name=password] is absent (kept, but now subordinate).
// It is asserted after navigation, after the --script hook, and -- most
// importantly -- immediately before EACH screenshot write, because the
// viewport resize or a navigation the script scheduled can change the
// page between the hook and the write. On any failure, every PNG for this
// label/out-dir is deleted before exiting non-zero, so a failed run never
// leaves partial evidence behind for a later task to pick up.
//
// STALE EVIDENCE: before doing anything else, this script deletes any
// pre-existing PNG at the exact paths it is about to write. Otherwise a
// run that fails at the first checkpoint would leave the PREVIOUS run's
// <label>-1440.png in place, and a downstream task reading that path
// would pick up stale evidence despite the non-zero exit.
//
// PORT SELECTION AND SERVER IDENTITY (this used to be a real hole).
//
// The port was hardcoded to 4999 and ANY listener already on it was
// reused. A second concurrent shot.mjs -- or an unrelated console -- on
// that port meant this tool would screenshot a DIFFERENT console and,
// because that console serves the same markup on the same origin, the
// auth guard would happily certify it. The evidence would then be about
// the wrong tree. Now:
// A LATER audit defeated the first fix for this, and the way it did so is
// why the code below looks the way it does. The rules of TCP binding on
// macOS/BSD are NOT "one listener per port":
//   - a probe bind of 0.0.0.0:P SUCCEEDS while a foreign process holds
//     127.0.0.1:P or [::1]:P (measured on this platform). So a
//     "can I bind 0.0.0.0?" free-port probe reports FREE for a port that
//     a loopback-only server is already serving;
//   - Node sets SO_REUSEADDR, so binding 127.0.0.1:P also succeeds while
//     another process holds the wildcard 0.0.0.0:P or [::]:P;
//   - `localhost` resolves to ::1 BEFORE 127.0.0.1, and the kernel routes
//     a connection to the MOST SPECIFIC matching bind.
// Together those let an attacker hold [::1]:4999, watch this script's
// probe call the port free, watch it start a REAL child on the wildcard
// (which really does print its own "listening" line), and then serve
// every http://localhost:4999 request itself, because ::1 wins name
// resolution and the specific bind beats the wildcard. Reading the
// child's own stdout proves the CHILD started; it does NOT prove traffic
// to BASE_URL reaches the child.
//
// So server identity now rests on three things, and the second is the
// structural one:
//   - the port is SHOT_PORT, else PORT, else 4999; a port is treated as
//     free only if ALL of 127.0.0.1, ::1 and 0.0.0.0 can be bound (any
//     one refusal means somebody is there). If it is occupied we move to
//     an OS-assigned free port instead;
//   - the child is told to bind the single literal address 127.0.0.1
//     (LIBERTA_CONSOLE_HOST, see console/server.js) and BASE_URL is built
//     from that same literal -- never `localhost`. Name-resolution order
//     therefore cannot apply, and since the kernel refuses a second bind
//     of exactly 127.0.0.1:P, the child's successful bind means no other
//     process can serve the address we talk to. A foreign wildcard
//     listener loses to our more-specific bind (measured: it does);
//   - we then log in with a password generated by crypto.randomBytes for
//     this invocation only, and we verify the returned cookie's HMAC
//     against the secret we generated (auth.js verifySessionCookie), AND
//     that a deliberately WRONG password is REJECTED. A 302 carrying a
//     correctly-NAMED cookie is trivially forgeable by a hostile server;
//     a cookie that verifies under a secret generated seconds ago in this
//     process is not. That is an identity proof independent of routing;
//   - if the child exits (e.g. it lost a race for the port), we retry on
//     a fresh port a couple of times and then FAIL LOUDLY. We never fall
//     back to capturing a server we did not start.
//
// The permanent regression probe for the original bypass lives at
// console/scripts/probes/auth-bypass.mjs.
//
// Usage:
//   node console/scripts/shot.mjs [--out <dir>] [--path </some/path>]
//     [--label <name>] [--reduced-motion] [--script <file.mjs>]
//     [--expect-selector <css>]
//
// Environment:
//   SHOT_PORT / PORT      preferred port for the child console (default
//                         4999); a free port is picked if it is taken.
//   LIBERTA_CHROME_PATH   path to the Chrome/Chromium binary, overriding
//   CHROME_PATH           the built-in macOS default.
//
// --script <file.mjs> should be an ES module exporting:
//   export async function run(page) { ... }
// It runs after login + navigation, before screenshots are taken -- e.g.
// to click into a panel or type a chat message before capturing.
//
// --expect-selector <css> adds an ADDITIONAL required selector on top of
// the default dashboard markers; it does not replace them. The final
// requirement is (#sessions-table AND #whoami AND <every selector you
// passed>), ANDed with the contentType / same-origin / no-password
// conditions. It can therefore only ever NARROW what counts as
// authenticated. There is deliberately no flag that replaces the
// defaults: an earlier version let --expect-selector replace them, and
// `--expect-selector body` was then used to certify a genuinely
// unauthenticated 404 page as evidence.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONSOLE_DIR = path.resolve(__dirname, "..");

// Chrome binary. Hardcoding the macOS path made this unusable everywhere
// else, so an env override comes first and the old path is only the
// fallback default.
const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_PATH =
  process.env.LIBERTA_CHROME_PATH ||
  process.env.CHROME_PATH ||
  DEFAULT_CHROME_PATH;

// Preferred port. Occupied ports are routed around, never reused.
const PREFERRED_PORT = (() => {
  const raw = process.env.SHOT_PORT || process.env.PORT;
  const n = raw ? Number(raw) : NaN;
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  if (raw) {
    process.stderr.write(
      `WARNING: ignoring invalid SHOT_PORT/PORT value ${JSON.stringify(raw)}\n`
    );
  }
  return 4999;
})();

// Credentials for the child console, generated per invocation. These were
// once a pair of fixed constants hardcoded in a PUBLIC repo, while
// server.js binds every interface -- which meant that during a
// screenshot run anyone LAN-adjacent could forge a valid session cookie
// for the REAL console (real sqlite DB, real ~/.claude/liberta-runs, real
// inbox POST route) without ever knowing the password. Random per run
// also doubles as the proof that the server we screenshot is the one we
// started: nobody else can know this password.
// NEVER log these values.
const TEST_PASSWORD = crypto.randomBytes(24).toString("hex");
const TEST_SECRET = crypto.randomBytes(32).toString("hex");
// A password that is, by construction, NOT the one the child accepts.
// Used as a negative control: the server must REJECT it (see
// loginAndGetCookieValue).
const WRONG_PASSWORD = crypto.randomBytes(24).toString("hex") + "-wrong";

// Set once a port has been chosen and our child console is confirmed up.
let PORT = null;
let BASE_URL = null;

// Markers that exist ONLY in the authenticated dashboard document
// (console/public/dashboard.html). The login page and every JSON/plain
// error body lack them. These are ALWAYS required.
const DEFAULT_EXPECT_SELECTORS = ["#sessions-table", "#whoami"];

// How long to let any in-flight / just-scheduled navigation land before
// certifying a page. Without this, a script that schedules a delayed
// location.assign() could have the screenshot taken just before the
// navigation commits.
const SETTLE_MS = 600;

const VIEWPORTS = [
  { width: 1440, height: 900, suffix: "1440" },
  { width: 390, height: 844, suffix: "390" },
];

// Read the real cookie name from auth.js rather than hardcoding a guess.
const { COOKIE_NAME, verifySessionCookie } = require(
  path.join(CONSOLE_DIR, "auth.js")
);

function parseArgs(argv) {
  const args = {
    out: "./shots",
    path: "/",
    label: "shot",
    reducedMotion: false,
    script: null,
    expectSelectors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--path") args.path = argv[++i];
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--reduced-motion") args.reducedMotion = true;
    else if (a === "--script") args.script = argv[++i];
    else if (a === "--expect-selector") args.expectSelectors.push(argv[++i]);
    else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      process.exit(1);
    }
  }

  // AND, never replace. The defaults are unconditional; caller-supplied
  // selectors are additional requirements on top of them, so the flag can
  // only narrow the guard. Duplicates are collapsed so the failure
  // message stays readable.
  args.expectSelectors = Array.from(
    new Set([
      ...DEFAULT_EXPECT_SELECTORS,
      ...args.expectSelectors.filter((s) => typeof s === "string" && s.length),
    ])
  );

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------
// Port handling
// ---------------------------------------------------------------------

// The single literal address the child console binds AND the only address
// we ever talk to. Deliberately NOT the name `localhost`: localhost
// resolves ::1 before 127.0.0.1, so a foreign server bound to [::1]:P
// would receive every request we believed was going to our own child.
// Using one literal address removes name resolution from the trust chain.
const CHILD_HOST = "127.0.0.1";

// Addresses a probe must be able to bind before we call a port free.
// A previous version probed ONLY 0.0.0.0, and that is not sufficient:
// measured on macOS, binding 0.0.0.0:P SUCCEEDS while another process
// holds 127.0.0.1:P or [::1]:P, so a loopback-only squatter was reported
// as "port free". Every address a client could plausibly reach must be
// checked; a refusal on ANY of them means the port is taken.
const PROBE_HOSTS = ["127.0.0.1", "::1", "0.0.0.0"];

// Try to bind one address. Resolves "free", "taken", or "unavailable"
// (the address family does not exist on this machine -- e.g. ::1 on a
// host with IPv6 disabled -- which is not evidence of a squatter).
function probeBind(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (err) => {
      const code = err && err.code;
      if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT" || code === "EINVAL") {
        resolve("unavailable");
      } else {
        resolve("taken");
      }
    });
    probe.once("listening", () => probe.close(() => resolve("free")));
    probe.listen({ port, host, exclusive: true });
  });
}

// True only if NOTHING is holding this port on any address we could reach
// -- loopback v4, loopback v6, or the v4 wildcard. Note this is a
// best-effort pre-filter, not the security boundary: the real guarantee
// is that the child binds the literal CHILD_HOST address and the kernel
// refuses a second bind of exactly that address:port, so whoever holds
// 127.0.0.1:P is the only one who can answer us there.
async function isPortFree(port) {
  for (const host of PROBE_HOSTS) {
    const result = await probeBind(host, port);
    if (result === "taken") return false;
  }
  return true;
}

// An OS-assigned free port. Probed on CHILD_HOST, the address the child
// will actually bind, so the answer is about the address that matters.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.once("listening", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.listen({ port: 0, host: CHILD_HOST, exclusive: true });
  });
}

// ---------------------------------------------------------------------
// Child console
// ---------------------------------------------------------------------

// Starts OUR OWN console child process, bound to CHILD_HOST:`port`, and
// resolves only once THAT CHILD printed its "listening on" line on its
// own stdout pipe. Rejects if the child exits, errors, or is silent past
// the timeout -- which is what happens if the port is genuinely taken on
// CHILD_HOST (EADDRINUSE crashes the child).
//
// SCOPE OF THIS PROOF, stated precisely because overstating it is exactly
// how the previous version was defeated: the stdout line proves THE CHILD
// STARTED AND BOUND. On its own it says nothing about where traffic to
// BASE_URL lands. What makes the child unshadowable is that it binds the
// single literal address we then talk to, plus the cookie-signature check
// in loginAndGetCookieValue.
function startConsoleChild(port, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(CONSOLE_DIR, "server.js")],
      {
        cwd: CONSOLE_DIR,
        env: {
          ...process.env,
          PORT: String(port),
          SHOT_PORT: "",
          // Bind ONE literal address (console/server.js reads this). The
          // child then cannot be shadowed on the address we talk to: the
          // kernel refuses a second bind of exactly 127.0.0.1:port, and a
          // foreign wildcard listener loses to this more-specific bind.
          LIBERTA_CONSOLE_HOST: CHILD_HOST,
          LIBERTA_CONSOLE_PASSWORD: TEST_PASSWORD,
          LIBERTA_CONSOLE_SECRET: TEST_SECRET,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        reject,
        new Error(
          `console child did not report "listening" on port ${port} within ` +
            `${timeoutMs}ms.\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`
        )
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      // server.js's banner always says "localhost" regardless of the
      // address it bound (its wording is a documented contract, see the
      // NOTE above app.listen there) -- we match it verbatim, but we
      // address the child by CHILD_HOST, never by that name.
      if (stdoutBuf.includes(`listening on http://localhost:${port}`)) {
        finish(resolve, { child });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });

    child.once("error", (err) => finish(reject, err));
    child.once("exit", (code, signal) => {
      finish(
        reject,
        new Error(
          `console child exited (code=${code} signal=${signal}) before it ` +
            `was listening on port ${port} -- most likely the port was ` +
            `taken.\nstderr:\n${stderrBuf}`
        )
      );
    });
  });
}

// Boot a console we own on a loopback port nothing else holds, then
// prove -- via a wrong-password rejection and an HMAC check of the issued
// cookie against this invocation's secret -- that the thing answering
// BASE_URL really is that child. Never attaches to a pre-existing server,
// and cannot be shadowed by one.
async function startOwnConsole() {
  const attempts = [];
  if (await isPortFree(PREFERRED_PORT)) {
    attempts.push(PREFERRED_PORT);
  } else {
    process.stderr.write(
      `NOTE: port ${PREFERRED_PORT} is held on at least one of ` +
        `${PROBE_HOSTS.join(", ")} by something this script did not start. ` +
        `Refusing to screenshot a server we cannot prove is ours -- ` +
        `picking a free port instead.\n`
    );
  }
  while (attempts.length < 4) {
    attempts.push(await findFreePort());
  }

  const failures = [];
  for (const port of attempts) {
    let handle;
    try {
      handle = await startConsoleChild(port);
    } catch (err) {
      failures.push(`port ${port}: ${err && err.message ? err.message : err}`);
      continue;
    }

    PORT = port;
    BASE_URL = `http://${CHILD_HOST}:${port}`;

    // Independent identity proof: log in with the password generated for
    // this invocation. No foreign console can accept it.
    let cookieValue;
    try {
      cookieValue = await loginAndGetCookieValue();
    } catch (err) {
      await stopChild(handle.child);
      PORT = null;
      BASE_URL = null;
      failures.push(
        `port ${port}: could not authenticate against the server that ` +
          `answered there using this invocation's generated credentials, ` +
          `so it is NOT the console we started -- ` +
          `${err && err.message ? err.message : err}`
      );
      continue;
    }

    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      failures.push(`port ${port}: console child died right after startup`);
      PORT = null;
      BASE_URL = null;
      continue;
    }

    process.stdout.write(`console (started by this run) on ${BASE_URL}\n`);
    return {
      cookieValue,
      stop: async () => {
        await stopChild(handle.child);
      },
    };
  }

  throw new Error(
    `could not start a console this invocation owns. Attempts:\n  ` +
      failures.join("\n  ")
  );
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

// POSTs a password to /login and returns { status, cookieValue }, where
// cookieValue is the raw value (not the whole Set-Cookie header) of the
// COOKIE_NAME cookie, or null if the response did not set one.
async function attemptLogin(password) {
  const res = await fetch(`${BASE_URL}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }).toString(),
    redirect: "manual",
  });

  const setCookieHeaders =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);

  let cookieValue = null;
  for (const raw of setCookieHeaders) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name === COOKIE_NAME) {
      cookieValue = value;
      break;
    }
  }

  return { status: res.status, cookieValue };
}

// Proves, cryptographically and independently of any routing assumption,
// that the server answering BASE_URL is the child we started, then
// returns its session cookie value.
//
// An earlier version accepted "HTTP 302 plus a cookie NAMED
// liberta_console_session" as that proof. It is not one: both are chosen
// by whoever answers the socket, so a hostile server that accepts any
// password and sets a same-named cookie satisfied it completely. Two real
// checks replace it:
//
//   1. NEGATIVE: a deliberately wrong password MUST be rejected (not a
//      302, and no session cookie issued). A server that hands out
//      sessions to anyone is not the console, whatever it claims.
//   2. POSITIVE: the cookie returned for the CORRECT password must verify
//      under TEST_SECRET -- the HMAC secret crypto.randomBytes generated
//      in this process moments ago and passed only to our own child on
//      its env. Forging a payload that passes auth.js's
//      verifySessionCookie requires that secret, so a valid signature is
//      proof of identity that a foreign server cannot fake, no matter
//      what it does with status codes and cookie names.
async function loginAndGetCookieValue() {
  // 1. Wrong password must be refused. WRONG_PASSWORD is random and
  //    distinct from TEST_PASSWORD, so a correct server can only reject
  //    it.
  let negative;
  try {
    negative = await attemptLogin(WRONG_PASSWORD);
  } catch (err) {
    throw new Error(
      `could not probe the server with a deliberately wrong password: ` +
        `${err && err.message ? err.message : err}`
    );
  }
  if (negative.status === 302 || negative.cookieValue) {
    throw new Error(
      `the server answering ${BASE_URL} ACCEPTED a deliberately wrong ` +
        `password (status ${negative.status}` +
        `${negative.cookieValue ? `, and issued a "${COOKIE_NAME}" cookie` : ""}` +
        `). A console that authenticates anybody is not the child this run ` +
        `started -- refusing to screenshot it`
    );
  }

  // 2. Correct password must be accepted...
  const res = await attemptLogin(TEST_PASSWORD);
  if (res.status !== 302) {
    throw new Error(
      `login failed: expected a 302 redirect after POST /login, got ${res.status}`
    );
  }
  if (!res.cookieValue) {
    throw new Error(
      `login response did not set the "${COOKIE_NAME}" cookie -- login did not take`
    );
  }

  // 3. ...and the cookie it issued must be signed with THIS invocation's
  //    secret. This is the check a hostile server cannot pass.
  if (!verifySessionCookie(res.cookieValue, TEST_SECRET)) {
    throw new Error(
      `the "${COOKIE_NAME}" cookie returned by ${BASE_URL} does NOT verify ` +
        `against the session secret generated for this invocation. Whatever ` +
        `answered is not the console child this run started (a correctly ` +
        `named cookie is not identity) -- refusing to screenshot it`
    );
  }

  return res.cookieValue;
}

// POSITIVE ALLOWLIST auth guard. Throws (never returns false) with a
// message naming the failed condition plus the page's actual URL and
// contentType. `where` is a short label for the call site so a failure
// says which of the three checkpoints tripped.
async function assertAuthenticatedCapture(page, expectSelectors, where) {
  let probe;
  try {
    probe = await page.evaluate((selectors) => {
      const present = {};
      for (const sel of selectors) {
        try {
          present[sel] = !!document.querySelector(sel);
        } catch (err) {
          present[sel] = false;
        }
      }
      return {
        url: String(location.href),
        origin: String(location.origin),
        contentType: String(document.contentType || ""),
        present,
        passwordInput: !!document.querySelector("input[name=password]"),
      };
    }, expectSelectors);
  } catch (err) {
    throw new Error(
      `capture rejected (${where}): could not inspect the live page to ` +
        `prove it is authenticated (${err && err.message ? err.message : err}). ` +
        `url=${page.url()}`
    );
  }

  const fail = (condition) => {
    throw new Error(
      `capture rejected (${where}): ${condition}. ` +
        `url=${probe.url} contentType=${probe.contentType || "<unknown>"}`
    );
  };

  // 1. Content type. A JSON/plain-text body (e.g. the /api/sessions 401
  //    payload) fails here before any selector is consulted.
  if (probe.contentType !== "text/html") {
    fail(
      `document.contentType is "${probe.contentType}", not "text/html" -- ` +
        `this is not an HTML page of the console (an API/error body cannot ` +
        `be visual evidence)`
    );
  }

  // 2. Same-origin with the harness base URL.
  const expectedOrigin = new URL(BASE_URL).origin;
  if (probe.origin !== expectedOrigin) {
    fail(
      `page origin "${probe.origin}" is not the harness origin ` +
        `"${expectedOrigin}" -- a capture of another origin is not evidence ` +
        `about this console`
    );
  }

  // 3. The authenticated-dashboard marker(s) must be in the live DOM.
  //    This list always contains the defaults; --expect-selector can only
  //    have added to it.
  const missing = expectSelectors.filter((sel) => !probe.present[sel]);
  if (missing.length > 0) {
    fail(
      `authenticated-view marker(s) ${missing
        .map((s) => JSON.stringify(s))
        .join(", ")} not found in the DOM (required: ${expectSelectors
        .map((s) => JSON.stringify(s))
        .join(" AND ")}) -- the page is not the authenticated view`
    );
  }

  // 4. Subordinate legacy check: the login form must not be present.
  if (probe.passwordInput) {
    fail(
      `input[name=password] is present -- the login form is on screen, so ` +
        `auth did not take (or was lost)`
    );
  }
}

// Give any in-flight or just-scheduled navigation a chance to commit
// before we certify and capture the page.
async function settle(page) {
  await sleep(SETTLE_MS);
  try {
    await page.waitForNetworkIdle({ idleTime: 200, timeout: 2000 });
  } catch (err) {
    // Not fatal: assertAuthenticatedCapture is the actual gate.
  }
}

// Every path this invocation may write. Used both to clear stale evidence
// up front and to clean up on failure.
function outputPaths(args) {
  return VIEWPORTS.map((v) =>
    path.join(args.out, `${args.label}-${v.suffix}.png`)
  );
}

async function removePaths(paths, reason) {
  const fs = await import("node:fs");
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      await rm(p, { force: true });
      process.stderr.write(`removed ${reason} ${p}\n`);
    } catch (rmErr) {
      process.stderr.write(
        `WARNING: could not remove ${reason} ${p}: ` +
          `${rmErr && rmErr.message ? rmErr.message : rmErr}\n`
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = outputPaths(args);

  // Clear stale evidence BEFORE anything can fail. Otherwise a run that
  // dies at checkpoint 1 leaves the previous run's PNGs at exactly the
  // paths a downstream task will read.
  await removePaths(targets, "stale evidence from a previous run");

  const fs = await import("node:fs");
  if (!fs.existsSync(CHROME_PATH)) {
    process.stderr.write(
      `FATAL: Chrome not found at "${CHROME_PATH}". This script relies on ` +
        `puppeteer-core reusing the system Chrome install rather than ` +
        `downloading its own -- install Chrome there, or set ` +
        `LIBERTA_CHROME_PATH to the Chrome/Chromium binary.\n`
    );
    process.exit(1);
  }

  let server;
  try {
    server = await startOwnConsole();
  } catch (err) {
    process.stderr.write(`FATAL: ${err.message || err}\n`);
    process.exit(1);
  }

  let exitCode = 0;
  let browser;
  try {
    const cookieValue = server.cookieValue;

    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });

    const page = await browser.newPage();
    // Scope the cookie by URL rather than by a hardcoded domain string:
    // BASE_URL is the literal 127.0.0.1 origin of our own child, and
    // "localhost" would not even match it.
    await page.setCookie({
      name: COOKIE_NAME,
      value: cookieValue,
      url: BASE_URL,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    });

    if (args.reducedMotion) {
      await page.emulateMediaFeatures([
        { name: "prefers-reduced-motion", value: "reduce" },
      ]);
    }

    const targetUrl = `${BASE_URL}${args.path}`;
    await page.goto(targetUrl, { waitUntil: "networkidle0" });

    // Checkpoint 1: right after navigation.
    await assertAuthenticatedCapture(
      page,
      args.expectSelectors,
      `after navigation to ${targetUrl}`
    );

    if (args.script) {
      const scriptPath = path.resolve(process.cwd(), args.script);
      const mod = await import(pathToFileURL(scriptPath).href);
      if (typeof mod.run !== "function") {
        throw new Error(
          `--script ${args.script} must export an async function run(page)`
        );
      }
      await mod.run(page);

      // Checkpoint 2: right after the interaction hook.
      await settle(page);
      await assertAuthenticatedCapture(
        page,
        args.expectSelectors,
        `after --script ${args.script}`
      );
    }

    await mkdir(args.out, { recursive: true });

    for (const size of VIEWPORTS) {
      await page.setViewport({ width: size.width, height: size.height });
      const outPath = path.join(args.out, `${args.label}-${size.suffix}.png`);

      // Checkpoint 3, the decisive one: immediately before every write.
      // The viewport resize, or a navigation the --script scheduled, can
      // change the page between the hook and the screenshot.
      await settle(page);
      await assertAuthenticatedCapture(
        page,
        args.expectSelectors,
        `immediately before writing ${path.basename(outPath)}`
      );

      await page.screenshot({ path: outPath, fullPage: true });
      process.stdout.write(`wrote ${outPath}\n`);
    }
  } catch (err) {
    process.stderr.write(`FATAL: ${err.message || err}\n`);
    exitCode = 1;
    // Never leave partial evidence behind: a later task must not be able
    // to pick up a PNG at these paths from a run that failed its auth
    // assertions.
    await removePaths(targets, "partial evidence");
  } finally {
    if (browser) {
      await browser.close();
    }
    await server.stop();
  }

  process.exit(exitCode);
}

main();
