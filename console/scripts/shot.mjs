#!/usr/bin/env node
"use strict";

// shot.mjs -- shared browser-evidence tool for Liberta visual tasks.
//
// The console's dashboard and every /api/* route sit behind auth (see
// console/server.js), so a bare screenshot of /login proves nothing about
// what a logged-in operator actually sees. This script:
//   1. boots the console itself (with fixed test credentials) if nothing
//      is already listening on the target port, and tears it back down
//      on exit if it started it;
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
//   - the authenticated-dashboard marker(s) are in the live DOM
//     (default: #sessions-table AND #whoami, which exist only in
//     console/public/dashboard.html, served behind auth);
//   - document.contentType is text/html (any JSON/plain-text error body,
//     such as the /api/sessions 401 payload, fails here);
//   - the page URL is same-origin with BASE_URL;
//   - input[name=password] is absent (kept, but now subordinate).
// It is asserted after navigation, after the --script hook, and -- most
// importantly -- immediately before EACH screenshot write, because the
// viewport resize or a navigation the script scheduled can change the
// page between the hook and the write. On any failure, every PNG this
// invocation wrote is deleted before exiting non-zero, so a failed run
// never leaves partial evidence behind for a later task to pick up.
//
// The permanent regression probe for the original bypass lives at
// console/scripts/probes/auth-bypass.mjs.
//
// Usage:
//   node console/scripts/shot.mjs [--out <dir>] [--path </some/path>]
//     [--label <name>] [--reduced-motion] [--script <file.mjs>]
//     [--expect-selector <css>]
//
// --script <file.mjs> should be an ES module exporting:
//   export async function run(page) { ... }
// It runs after login + navigation, before screenshots are taken -- e.g.
// to click into a panel or type a chat message before capturing.
//
// --expect-selector <css> replaces the default dashboard marker(s) with a
// single CSS selector, for a future view whose markup differs. It is
// still ANDed with the contentType / same-origin / no-password
// conditions -- it can narrow what counts as authenticated, never weaken
// the guard. Repeat the flag to require several selectors.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONSOLE_DIR = path.resolve(__dirname, "..");

const CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const PORT = 4999;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_PASSWORD = "libtest";
const TEST_SECRET = "libtestsecret";

// Markers that exist ONLY in the authenticated dashboard document
// (console/public/dashboard.html). The login page and every JSON/plain
// error body lack them.
const DEFAULT_EXPECT_SELECTORS = ["#sessions-table", "#whoami"];

// How long to let any in-flight / just-scheduled navigation land before
// certifying a page. Without this, a script that schedules a delayed
// location.assign() could have the screenshot taken just before the
// navigation commits.
const SETTLE_MS = 600;

// Read the real cookie name from auth.js rather than hardcoding a guess.
const { COOKIE_NAME } = require(path.join(CONSOLE_DIR, "auth.js"));

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
  if (args.expectSelectors.length === 0) {
    args.expectSelectors = DEFAULT_EXPECT_SELECTORS;
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isServerUp() {
  try {
    const res = await fetch(`${BASE_URL}/login`, { redirect: "manual" });
    return res.status < 500;
  } catch (err) {
    return false;
  }
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp()) return true;
    await sleep(250);
  }
  return false;
}

// Starts the console as a child process if nothing is already listening
// on PORT. Returns a handle with a `stop()` that only actually kills the
// process if this call was the one that started it (never kills a
// pre-existing, externally-managed server).
async function ensureServerRunning() {
  if (await isServerUp()) {
    return { startedByUs: false, stop: async () => {} };
  }

  const child = spawn(process.execPath, [path.join(CONSOLE_DIR, "server.js")], {
    cwd: CONSOLE_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      LIBERTA_CONSOLE_PASSWORD: TEST_PASSWORD,
      LIBERTA_CONSOLE_SECRET: TEST_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });

  const up = await waitForServer();
  if (!up) {
    child.kill("SIGTERM");
    throw new Error(
      `console did not come up on ${BASE_URL}/login within timeout.\n` +
        `stderr so far:\n${stderrBuf}`
    );
  }

  return {
    startedByUs: true,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(resolve, 3000);
      });
    },
  };
}

// Logs in over HTTP and returns the raw session cookie *value* (not the
// whole Set-Cookie header) for COOKIE_NAME.
async function loginAndGetCookieValue() {
  const res = await fetch(`${BASE_URL}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: TEST_PASSWORD }).toString(),
    redirect: "manual",
  });

  if (res.status !== 302) {
    throw new Error(
      `login failed: expected a 302 redirect after POST /login, got ${res.status}`
    );
  }

  const setCookieHeaders =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);

  for (const raw of setCookieHeaders) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name === COOKIE_NAME) return value;
  }

  throw new Error(
    `login response did not set the "${COOKIE_NAME}" cookie -- login did not take`
  );
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const fs = await import("node:fs");
  if (!fs.existsSync(CHROME_PATH)) {
    process.stderr.write(
      `FATAL: Chrome not found at "${CHROME_PATH}". This script relies on ` +
        `puppeteer-core reusing the system Chrome install rather than ` +
        `downloading its own -- install Chrome there, or update ` +
        `CHROME_PATH in console/scripts/shot.mjs.\n`
    );
    process.exit(1);
  }

  const server = await ensureServerRunning();

  let exitCode = 0;
  let browser;
  // PNGs written by THIS invocation, so they can be removed if a later
  // assertion fails.
  const written = [];
  try {
    const cookieValue = await loginAndGetCookieValue();

    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });

    const page = await browser.newPage();
    await page.setCookie({
      name: COOKIE_NAME,
      value: cookieValue,
      domain: "localhost",
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

    const sizes = [
      { width: 1440, height: 900, suffix: "1440" },
      { width: 390, height: 844, suffix: "390" },
    ];

    for (const size of sizes) {
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
      written.push(outPath);
      process.stdout.write(`wrote ${outPath}\n`);
    }
  } catch (err) {
    process.stderr.write(`FATAL: ${err.message || err}\n`);
    exitCode = 1;
    // Never leave partial evidence behind: a later task must not be able
    // to pick up a PNG from a run that failed its auth assertions.
    for (const p of written) {
      try {
        await rm(p, { force: true });
        process.stderr.write(`removed partial evidence ${p}\n`);
      } catch (rmErr) {
        process.stderr.write(
          `WARNING: could not remove partial evidence ${p}: ` +
            `${rmErr && rmErr.message ? rmErr.message : rmErr}\n`
        );
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
    await server.stop();
  }

  process.exit(exitCode);
}

main();
