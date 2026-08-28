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
//   4. hard-fails (non-zero exit, clear message) if login didn't
//      actually take -- i.e. if the captured page still shows the login
//      form (input[name=password]). A pass here must mean "this is really
//      the authenticated dashboard", not merely "a PNG got written".
//
// Usage:
//   node console/scripts/shot.mjs [--out <dir>] [--path </some/path>]
//     [--label <name>] [--reduced-motion] [--script <file.mjs>]
//
// --script <file.mjs> should be an ES module exporting:
//   export async function run(page) { ... }
// It runs after login + navigation, before screenshots are taken -- e.g.
// to click into a panel or type a chat message before capturing.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
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

// Read the real cookie name from auth.js rather than hardcoding a guess.
const { COOKIE_NAME } = require(path.join(CONSOLE_DIR, "auth.js"));

function parseArgs(argv) {
  const args = {
    out: "./shots",
    path: "/",
    label: "shot",
    reducedMotion: false,
    script: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--path") args.path = argv[++i];
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--reduced-motion") args.reducedMotion = true;
    else if (a === "--script") args.script = argv[++i];
    else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      process.exit(1);
    }
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

async function pageShowsLoginForm(page) {
  const found = await page.$("input[name=password]");
  return !!found;
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

    if (await pageShowsLoginForm(page)) {
      throw new Error(
        `capture failed: navigated to ${targetUrl} but the page still shows ` +
          `the login form (input[name=password] present) -- auth did not take`
      );
    }

    if (args.script) {
      const scriptPath = path.resolve(process.cwd(), args.script);
      const mod = await import(pathToFileURL(scriptPath).href);
      if (typeof mod.run !== "function") {
        throw new Error(
          `--script ${args.script} must export an async function run(page)`
        );
      }
      await mod.run(page);

      if (await pageShowsLoginForm(page)) {
        throw new Error(
          `capture failed: after running --script ${args.script}, the page ` +
            `shows the login form -- auth did not take (or was lost)`
        );
      }
    }

    await mkdir(args.out, { recursive: true });

    const sizes = [
      { width: 1440, height: 900, suffix: "1440" },
      { width: 390, height: 844, suffix: "390" },
    ];

    for (const size of sizes) {
      await page.setViewport({ width: size.width, height: size.height });
      const outPath = path.join(args.out, `${args.label}-${size.suffix}.png`);
      await page.screenshot({ path: outPath, fullPage: true });
      process.stdout.write(`wrote ${outPath}\n`);
    }
  } catch (err) {
    process.stderr.write(`FATAL: ${err.message || err}\n`);
    exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
    await server.stop();
  }

  process.exit(exitCode);
}

main();
