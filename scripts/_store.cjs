// Shared resolver for where the Liberta run store lives on disk.
//
// Why CommonJS: scripts/wave-exec.js is CommonJS (require) while
// scripts/_status.mjs, scripts/_log-event.mjs and scripts/_mailbox.mjs are
// ESM (import). A single implementation has to be consumable by both
// module systems without duplicating the logic. Node's ESM loader can
// `import` a CommonJS module and get its `module.exports` as the default
// export (default interop), but the reverse -- a CommonJS `require()` of an
// ESM file -- does not work synchronously. So this file is written as plain
// CommonJS (the "smallest common denominator"), and scripts/_store.mjs is a
// two-line ESM shim that re-exports these same named bindings via default
// interop. That keeps exactly one copy of the logic, needs no build step,
// and both `require('./_store.cjs')` and `import './_store.mjs'` end up
// calling the identical functions.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// Override point for tests: when LIBERTA_RUNS_DIR is set to a non-empty
// string, the run store lives there instead of the real operator store at
// ~/.claude/liberta-runs. This exists so tests (and any other throwaway,
// disposable invocation) can point the whole store at a temp directory
// instead of reading or writing the operator's LIVE session data.
// Production runs must NEVER set LIBERTA_RUNS_DIR -- doing so would silently
// redirect a real session's state away from the store every other tool
// (console/sync.js, the controller, etc.) expects it in.
function runsRoot() {
  const override = process.env.LIBERTA_RUNS_DIR;
  if (typeof override === "string" && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".claude", "liberta-runs");
}

function sessionDir(sessionId) {
  return path.join(runsRoot(), sessionId);
}

function indexPath() {
  return path.join(runsRoot(), "index.json");
}

module.exports = { runsRoot, sessionDir, indexPath };
