#!/usr/bin/env node
"use strict";

// shot-site.mjs -- browser-evidence tool for the PUBLIC STATIC SITE in
// site/.
//
// WHY THIS IS NOT shot.mjs.
//
// console/scripts/shot.mjs is hardcoded to the console application: it
// boots console/server.js as a child, performs a real password login to
// obtain the liberta_console_session cookie, and then refuses to write a
// PNG unless the live DOM positively proves it is the authenticated
// dashboard (#sessions-table AND #whoami, which exist only in
// console/public/dashboard.html). Pointing it at site/index.html would
// boot the wrong server, log in for no reason, and then -- correctly --
// refuse the capture. Defeating that with --expect-selector is not an
// option either: the dashboard markers are unconditional there by
// design, and it would still boot and log into the console.
//
// So this is a separate tool with the same shape and the same
// discipline: an equally positive allowlist, aimed at a static page.
//
// WHY IT LIVES UNDER console/.
//
// For exactly one reason: puppeteer-core is a devDependency of
// console/package.json and only resolves from inside console/. It must
// NOT be copied into site/ -- site/ is the published artifact and stays
// dependency-free, no build step, no npm, no CDN. Anything that publishes
// site/ publishes site/ only, so this file never ships.
//
// POSITIVE ALLOWLIST -- a broken page must FAIL, not be certified.
//
// A capture is written only if ALL of the following hold:
//   (i)   the HTTP response for the navigated document was 200;
//   (ii)  document.contentType is exactly "text/html";
//   (iii) the page's own required marker is present: `main h1` exists and
//         has non-empty text (a blank page, a directory listing, or the
//         404 body cannot satisfy this);
//   (iv)  NO request logged during the load returned 404. This is the
//         check that catches the classic GitHub Pages failure, where the
//         HTML returns 200 but a root-absolute /style.css 404s and the
//         page renders unstyled;
//   (v)   the stylesheet actually APPLIED: document.styleSheets has at
//         least one sheet with cssRules.length > 0. A 200 on the CSS is
//         not the same as the CSS being parsed and in effect, and an
//         unstyled screenshot is worthless as visual evidence;
//   (vi)  at a viewport <= 480px wide, document.documentElement.scrollWidth
//         is <= the viewport width -- no horizontal page scrollbar. A
//         narrow capture that silently overflows is a failed
//         responsiveness claim, so the harness refuses to produce one.
//
// These are re-checked immediately BEFORE EACH PNG write, because the
// viewport resize between the wide and narrow shots can change all of
// (v) and (vi). On any failure every PNG this invocation already wrote is
// deleted and the process exits non-zero, so a failed run never leaves
// partial evidence for a later task to pick up. Stale PNGs at the target
// paths are also deleted up front, before anything can fail.
//
// SUBPATH. The site deploys to https://qubusp.github.io/liberta/ , i.e.
// under the "/liberta" prefix, never at the origin root. The static
// server therefore mounts site/ under that same prefix by default
// (override with SHOT_SITE_BASE; use "" to serve at the root) so that a
// root-absolute path such as href="/style.css" -- which works at the root
// and 404s in production -- is caught here by check (iv) rather than
// after deployment.
//
// Usage:
//   node console/scripts/shot-site.mjs [--out <dir>] [--path </page.html>]
//     [--label <name>] [--reduced-motion] [--no-js]
//
// --path is relative to the mounted base path, so "/" is the site index.
//
// Environment:
//   SHOT_SITE_PORT        port for the static server (default 4998). A
//                         port already held by anything is refused, and
//                         an OS-assigned free port is used instead, so
//                         concurrent runs cannot capture each other's
//                         tree.
//   SHOT_SITE_BASE        base path to mount site/ under (default
//                         "/liberta", mirroring production; "" = root).
//   LIBERTA_CHROME_PATH / CHROME_PATH
//                         Chrome/Chromium binary, overriding the macOS
//                         default (same convention as shot.mjs).

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONSOLE_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CONSOLE_DIR, "..");
const SITE_ROOT = path.join(REPO_ROOT, "site");

const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_PATH =
  process.env.LIBERTA_CHROME_PATH ||
  process.env.CHROME_PATH ||
  DEFAULT_CHROME_PATH;

const HOST = "127.0.0.1";

const PREFERRED_PORT = (() => {
  const raw = process.env.SHOT_SITE_PORT;
  const n = raw ? Number(raw) : NaN;
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  if (raw) {
    process.stderr.write(
      `WARNING: ignoring invalid SHOT_SITE_PORT ${JSON.stringify(raw)}\n`
    );
  }
  return 4998;
})();

// Mirrors production (https://qubusp.github.io/liberta/). Normalised to
// either "" or "/something" with no trailing slash.
const BASE_PATH = (() => {
  const raw = process.env.SHOT_SITE_BASE ?? "/liberta";
  const trimmed = String(raw).replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
})();

const VIEWPORTS = [
  { width: 1440, height: 900, suffix: "1440" },
  { width: 390, height: 844, suffix: "390" },
];

// Below this width we insist there is no horizontal page scrollbar.
const NARROW_MAX_WIDTH = 480;

const SETTLE_MS = 400;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function parseArgs(argv) {
  const args = {
    out: "./shots",
    path: "/",
    label: "site",
    reducedMotion: false,
    noJs: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--path") args.path = argv[++i];
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--reduced-motion") args.reducedMotion = true;
    else if (a === "--no-js") args.noJs = true;
    else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      process.exit(1);
    }
  }
  if (!args.path.startsWith("/")) args.path = `/${args.path}`;
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Static file server (dependency-free)
// ---------------------------------------------------------------------

// Resolves a URL pathname to a file inside SITE_ROOT, or null. The
// realpath-free containment check below is what stops "..%2f" and
// friends: whatever the request decodes to, the resolved absolute path
// must still sit under SITE_ROOT.
function resolveRequestPath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, "http://x").pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;

  if (BASE_PATH) {
    if (pathname === BASE_PATH) return { redirect: `${BASE_PATH}/` };
    if (!pathname.startsWith(`${BASE_PATH}/`)) return null;
    pathname = pathname.slice(BASE_PATH.length);
  }

  const rel = pathname.replace(/^\/+/, "");
  const resolved = path.resolve(SITE_ROOT, rel);
  const within =
    resolved === SITE_ROOT || resolved.startsWith(SITE_ROOT + path.sep);
  if (!within) return null;

  let file = resolved;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  } catch {
    return { file };
  }
  return { file };
}

function startStaticServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const target = resolveRequestPath(req.url || "/");
      if (!target) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("404 Not Found\n");
        return;
      }
      if (target.redirect) {
        res.writeHead(302, { location: target.redirect });
        res.end();
        return;
      }
      fs.readFile(target.file, (err, body) => {
        if (err) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("404 Not Found\n");
          return;
        }
        const type =
          MIME[path.extname(target.file).toLowerCase()] ||
          "application/octet-stream";
        res.writeHead(200, {
          "content-type": type,
          "content-length": body.length,
          "cache-control": "no-store",
        });
        res.end(body);
      });
    });
    server.once("error", reject);
    server.listen({ port, host: HOST, exclusive: true }, () =>
      resolve(server)
    );
  });
}

function probeBind(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (err) => {
      const code = err && err.code;
      if (["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL"].includes(code)) {
        resolve("unavailable");
      } else {
        resolve("taken");
      }
    });
    probe.once("listening", () => probe.close(() => resolve("free")));
    probe.listen({ port, host, exclusive: true });
  });
}

async function isPortFree(port) {
  for (const host of ["127.0.0.1", "::1", "0.0.0.0"]) {
    if ((await probeBind(host, port)) === "taken") return false;
  }
  return true;
}

// Serves site/ on a port nothing else holds. As in shot.mjs, we bind the
// single literal address we then talk to, so no name-resolution trick can
// route our requests to a foreign listener; and because we serve the
// bytes ourselves out of SITE_ROOT, the identity question shot.mjs solves
// with an HMAC does not arise here.
async function startOwnServer() {
  const ports = [];
  if (await isPortFree(PREFERRED_PORT)) {
    ports.push(PREFERRED_PORT);
  } else {
    process.stderr.write(
      `NOTE: port ${PREFERRED_PORT} is already held by something this ` +
        `script did not start -- using an OS-assigned free port instead so ` +
        `we cannot capture another run's tree.\n`
    );
  }
  ports.push(0, 0);

  const failures = [];
  for (const p of ports) {
    try {
      const server = await startStaticServer(p);
      const actual = server.address().port;
      return {
        server,
        baseUrl: `http://${HOST}:${actual}`,
        stop: () => new Promise((r) => server.close(r)),
      };
    } catch (err) {
      failures.push(`port ${p}: ${err && err.message ? err.message : err}`);
    }
  }
  throw new Error(
    `could not start the static server. Attempts:\n  ` + failures.join("\n  ")
  );
}

// ---------------------------------------------------------------------
// Capture guard
// ---------------------------------------------------------------------

class CaptureError extends Error {}

// Probe the live page with JS. Returns the raw facts; assertCapture
// decides.
async function probeWithJs(page) {
  return page.evaluate(() => {
    const h1 = document.querySelector("main h1");
    let styledRules = 0;
    let sheetCount = 0;
    try {
      sheetCount = document.styleSheets.length;
      for (const sheet of document.styleSheets) {
        try {
          styledRules += sheet.cssRules ? sheet.cssRules.length : 0;
        } catch {
          /* cross-origin sheet: not counted */
        }
      }
    } catch {
      /* ignore */
    }
    return {
      url: String(location.href),
      contentType: String(document.contentType || ""),
      h1Text: h1 ? String(h1.textContent || "").trim() : null,
      sheetCount,
      styledRules,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
}

// Probe the page WITHOUT page JS, over CDP. page.evaluate cannot run when
// setJavaScriptEnabled(false), so the same facts are gathered from the
// DOM/CSS/Page protocol domains, which are served by the browser, not by
// the page. This is how the "renders identically with JS disabled" claim
// is checked with the same guard rather than a weaker one.
async function probeWithoutJs(page) {
  const client = await page.createCDPSession();
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await client.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "main h1",
    });
    let h1Text = null;
    let h1Color = null;
    if (nodeId) {
      const { outerHTML } = await client.send("DOM.getOuterHTML", { nodeId });
      h1Text = outerHTML.replace(/<[^>]*>/g, "").trim();
      const { computedStyle } = await client.send(
        "CSS.getComputedStyleForNode",
        { nodeId }
      );
      const found = computedStyle.find((p) => p.name === "color");
      h1Color = found ? found.value : null;
    }
    const metrics = await client.send("Page.getLayoutMetrics");
    return {
      url: page.url(),
      // Reported by the guard's HTTP-level check instead; the CDP path
      // has no document.contentType without page JS.
      contentType: null,
      h1Text,
      h1Color,
      sheetCount: null,
      styledRules: null,
      scrollWidth: Math.ceil(
        (metrics.cssContentSize || metrics.contentSize).width
      ),
      innerWidth: Math.round(
        (metrics.cssLayoutViewport || metrics.layoutViewport).clientWidth
      ),
    };
  } finally {
    await client.detach().catch(() => {});
  }
}

// The positive allowlist. Throws (never returns false) naming the failed
// condition. `where` labels the checkpoint so a failure says which one
// tripped. `state` carries the facts collected during navigation (HTTP
// status, content-type header, 404s seen).
async function assertCapture(page, state, args, viewport, where) {
  const fail = (condition) => {
    throw new CaptureError(
      `capture rejected (${where}): ${condition}. url=${page.url()}`
    );
  };

  // (i) The document's own HTTP status.
  if (state.status !== 200) {
    fail(
      `the navigated document returned HTTP ${state.status}, not 200 -- a ` +
        `404/error body is not evidence about the site`
    );
  }

  // (iv) Nothing 404'd during the load. Checked before the DOM probe
  //      because "the CSS 404'd" is the failure most likely to make the
  //      rest of the page look superficially fine.
  if (state.notFound.length > 0) {
    fail(
      `${state.notFound.length} sub-request(s) returned 404 during load: ` +
        state.notFound.join(", ") +
        ` -- a page missing an asset (typically its stylesheet) must not be ` +
        `certified as a screenshot of the finished site`
    );
  }

  let probe;
  try {
    probe = args.noJs ? await probeWithoutJs(page) : await probeWithJs(page);
  } catch (err) {
    fail(
      `could not inspect the live page (${err && err.message ? err.message : err})`
    );
  }

  // (ii) Content type. With page JS disabled document.contentType is
  //      unreachable, so the response header recorded at navigation time
  //      stands in for it -- same fact, different source.
  const contentType = probe.contentType ?? state.contentTypeHeader;
  const normalised = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (normalised !== "text/html") {
    fail(
      `content type is "${contentType}", not "text/html" -- this is not an ` +
        `HTML page of the site`
    );
  }

  // (iii) The site's own required marker.
  if (!probe.h1Text) {
    fail(
      `no \`main h1\` with non-empty text found -- the page is blank, is a ` +
        `directory listing, or is not a page of the Liberta site`
    );
  }

  // (v) The stylesheet actually applied.
  if (args.noJs) {
    // document.styleSheets is unreachable; instead assert the h1's
    // COMPUTED colour is not the browser default (rgb(0, 0, 0)), which
    // it can only be if site/style.css parsed and applied.
    if (!probe.h1Color || /^rgba?\(0,\s*0,\s*0/.test(probe.h1Color)) {
      fail(
        `the h1's computed colour is ${probe.h1Color || "<unknown>"}, i.e. the ` +
          `browser default -- site/style.css did not apply`
      );
    }
  } else {
    if (!(probe.styledRules > 0)) {
      fail(
        `document.styleSheets holds ${probe.sheetCount} sheet(s) with ` +
          `${probe.styledRules} usable rules -- the stylesheet did not apply, ` +
          `so this would be a screenshot of an unstyled page (a 200 on the ` +
          `CSS is not proof it was parsed and used)`
      );
    }
  }

  // (vi) No horizontal page scrollbar at narrow viewports.
  if (viewport && viewport.width <= NARROW_MAX_WIDTH) {
    if (probe.scrollWidth > viewport.width) {
      fail(
        `document.documentElement.scrollWidth is ${probe.scrollWidth}px at a ` +
          `${viewport.width}px viewport -- the page scrolls horizontally, ` +
          `which is a failed responsiveness claim, not evidence of one`
      );
    }
  }

  return probe;
}

function outputPaths(args) {
  return VIEWPORTS.map((v) =>
    path.join(args.out, `${args.label}-${v.suffix}.png`)
  );
}

async function removePaths(paths, reason) {
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      await fsp.rm(p, { force: true });
      process.stderr.write(`removed ${reason} ${p}\n`);
    } catch (err) {
      process.stderr.write(
        `WARNING: could not remove ${reason} ${p}: ${err.message || err}\n`
      );
    }
  }
}

async function settle(page) {
  await sleep(SETTLE_MS);
  try {
    await page.waitForNetworkIdle({ idleTime: 200, timeout: 2000 });
  } catch {
    // Not fatal: assertCapture is the actual gate.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = outputPaths(args);

  // Clear stale evidence BEFORE anything can fail, so a run that dies at
  // the first checkpoint cannot leave the previous run's PNGs in place.
  await removePaths(targets, "stale evidence from a previous run");

  if (!fs.existsSync(SITE_ROOT)) {
    process.stderr.write(`FATAL: no site directory at ${SITE_ROOT}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(CHROME_PATH)) {
    process.stderr.write(
      `FATAL: Chrome not found at "${CHROME_PATH}". This script reuses the ` +
        `system Chrome via puppeteer-core rather than downloading its own -- ` +
        `install Chrome there, or set LIBERTA_CHROME_PATH.\n`
    );
    process.exit(1);
  }

  let server;
  try {
    server = await startOwnServer();
  } catch (err) {
    process.stderr.write(`FATAL: ${err.message || err}\n`);
    process.exit(1);
  }

  const targetUrl = `${server.baseUrl}${BASE_PATH}${args.path}`;
  process.stdout.write(
    `serving ${SITE_ROOT} at ${server.baseUrl}${BASE_PATH || "/"} ` +
      `(base path ${BASE_PATH ? JSON.stringify(BASE_PATH) : "<root>"})\n`
  );

  let exitCode = 0;
  let browser;
  try {
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });

    const page = await browser.newPage();
    if (args.noJs) await page.setJavaScriptEnabled(false);
    if (args.reducedMotion) {
      await page.emulateMediaFeatures([
        { name: "prefers-reduced-motion", value: "reduce" },
      ]);
    }

    // Facts gathered from the network, independent of anything the page
    // could claim about itself.
    const state = { status: null, contentTypeHeader: null, notFound: [] };
    page.on("response", (res) => {
      if (res.status() === 404) {
        state.notFound.push(`${res.status()} ${res.url()}`);
      }
    });

    const response = await page.goto(targetUrl, { waitUntil: "networkidle0" });
    state.status = response ? response.status() : null;
    state.contentTypeHeader = response
      ? response.headers()["content-type"] || null
      : null;

    // Checkpoint 1: right after navigation, at the default viewport.
    await settle(page);
    const first = await assertCapture(
      page,
      state,
      args,
      null,
      `after navigation to ${targetUrl}`
    );
    process.stdout.write(
      `guard OK: status=${state.status} h1=${JSON.stringify(first.h1Text)} ` +
        `404s=${state.notFound.length} ` +
        (args.noJs
          ? `h1-computed-color=${first.h1Color} (JS disabled)\n`
          : `stylesheets=${first.sheetCount} cssRules=${first.styledRules}\n`)
    );

    await fsp.mkdir(args.out, { recursive: true });

    for (const size of VIEWPORTS) {
      await page.setViewport({ width: size.width, height: size.height });
      const outPath = path.join(args.out, `${args.label}-${size.suffix}.png`);

      // Checkpoint 2, the decisive one: immediately before every write.
      // The resize alone can break (v) and (vi).
      await settle(page);
      const probe = await assertCapture(
        page,
        state,
        args,
        size,
        `immediately before writing ${path.basename(outPath)}`
      );

      await page.screenshot({ path: outPath, fullPage: true });
      process.stdout.write(
        `wrote ${outPath} (viewport ${size.width}x${size.height}, ` +
          `scrollWidth ${probe.scrollWidth})\n`
      );
    }
  } catch (err) {
    process.stderr.write(`FATAL: ${err.message || err}\n`);
    exitCode = 1;
    // Never leave partial evidence behind.
    await removePaths(targets, "partial evidence");
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }

  process.exit(exitCode);
}

main();
