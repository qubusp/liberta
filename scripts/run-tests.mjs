#!/usr/bin/env node
// Test entrypoint for `npm test` and `npm run test:one`.
//
// When invoked with no positional arguments, this discovers and runs every
// *.test.mjs file under test/ (see below for why). When invoked with one or
// more positional arguments (e.g. `npm run test:one -- test/foo.test.mjs`),
// those explicit file paths are run instead of doing discovery, so a single
// test file (including one that does not follow the *.test.mjs naming
// convention, as long as it is named explicitly) can still be run directly.
//
// Why this exists instead of a plain `node --test test/`:
//   * Passing a bare DIRECTORY positionally to `node --test` throws
//     MODULE_NOT_FOUND on current Node (v25.x), so `node --test test/` is out.
//   * A shell glob (`node --test test/*.test.mjs`) does not recurse into
//     subdirectories, and silently exits 0 when it matches nothing.
//   * A bare `node --test` (no positional args) recurses, but treats EVERY
//     .js/.mjs/.cjs file under a directory named `test` as a test file, so a
//     plain helper module like test/helpers/http.mjs would be executed
//     standalone: it either crashes the run or inflates the pass count with a
//     zero-assertion pseudo-test.
//
// So: discover *.test.mjs recursively ourselves, fail loudly when nothing is
// found, and hand the explicit FILE paths to `node --test`. Explicit file
// paths are fine positionally; only the bare-directory form is broken.
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testRoot = join(repoRoot, 'test');

const IGNORED_DIRS = new Set(['node_modules', '.git']);

/** @returns {string[]} absolute paths of every *.test.mjs under dir, recursively */
function discover(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      found.push(...discover(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      found.push(full);
    }
  }
  return found;
}

const explicitArgs = process.argv.slice(2);

let files;
if (explicitArgs.length > 0) {
  // Explicit file(s) given (e.g. `npm run test:one -- test/foo.test.mjs`):
  // run exactly those, no discovery, no recursive fallback.
  files = explicitArgs.map((f) => resolve(repoRoot, f));
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`[run-tests] no such file: ${relative(repoRoot, f)}`);
      process.exit(1);
    }
  }
} else {
  if (!existsSync(testRoot)) {
    console.error(`[run-tests] no test directory at ${testRoot}`);
    process.exit(1);
  }

  files = discover(testRoot).sort();

  if (files.length === 0) {
    console.error('[run-tests] no test files found (looked for **/*.test.mjs under test/).');
    console.error('[run-tests] refusing to report success for a run with zero tests.');
    process.exit(1);
  }
}

// Node's default reporter varies by version; pin it so piped output is stable
// and machine-greppable (TAP `# tests N` / `# pass N` summary lines) while an
// interactive terminal keeps the readable spec output. Override with
// TEST_REPORTER=<name>.
const reporter = process.env.TEST_REPORTER || (process.stdout.isTTY ? 'spec' : 'tap');

const args = ['--test', `--test-reporter=${reporter}`, ...files.map((f) => relative(repoRoot, f))];
console.log(`[run-tests] ${files.length} test file(s): ${files.map((f) => relative(repoRoot, f)).join(' ')}`);

const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });

if (result.error) {
  console.error(`[run-tests] failed to start node: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
