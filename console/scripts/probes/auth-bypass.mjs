#!/usr/bin/env node
"use strict";

// auth-bypass.mjs -- PERMANENT REGRESSION PROBE for console/scripts/shot.mjs.
//
// This is the exact attack that defeated shot.mjs's original auth guard.
// That guard was a BLOCKLIST: it rejected a capture only when
// input[name=password] was present. This probe, supplied via the
// spec-required `--script` hook, clears every cookie (dropping the signed
// session) and navigates to /api/sessions. The server correctly answers
// 401 with the plain body {"error":"unauthorized"}; Chrome renders that as
// a non-HTML document containing no password input, so the old guard saw
// nothing wrong and shot.mjs exited 0 having written two real, non-empty
// PNGs of an UNAUTHENTICATED page.
//
// shot.mjs's guard is now a positive allowlist (contentType must be
// text/html, same-origin, authenticated-dashboard markers present in the
// live DOM), asserted immediately before every screenshot write, and any
// PNG already written is deleted when an assertion fails.
//
// EXPECTED RESULT, and the reason this file is committed: running
//
//   node console/scripts/shot.mjs --label bypass --out <dir> \
//     --script console/scripts/probes/auth-bypass.mjs
//
// MUST exit NON-ZERO, must print a FATAL naming the failed condition, and
// must leave ZERO PNGs in <dir>. If it ever exits 0 or writes a PNG, the
// hole is open again and every visual-evidence task downstream is
// untrustworthy. Re-run it whenever shot.mjs's guard is touched.

export async function run(page) {
  // Drop the session cookie. Belt and braces: the CDP call clears the
  // whole cookie jar, page.deleteCookie clears anything scoped to this
  // document that survived.
  const client = await page.target().createCDPSession();
  await client.send("Network.clearBrowserCookies");
  await client.detach();

  const cookies = await page.cookies();
  if (cookies.length > 0) {
    await page.deleteCookie(...cookies);
  }

  // Now un-authenticated: this renders {"error":"unauthorized"} as a
  // plain-text/JSON document with no password input anywhere.
  await page.goto("http://localhost:4999/api/sessions", {
    waitUntil: "networkidle0",
  });
}
