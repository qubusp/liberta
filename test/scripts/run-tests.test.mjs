// Exercises scripts/run-tests.mjs (the `npm test` entrypoint) against
// isolated fixture copies of the repo, so we can assert on the two bugs
// this script exists to fix:
//   1. a `test/` tree with zero *.test.mjs files must fail the run
//      (non-zero exit), not silently report "0 tests" and exit 0.
//   2. a *.test.mjs file nested in a subdirectory of test/ (not just
//      directly under test/) must actually be discovered and executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-fixture-'));
  cpSync(join(repoRoot, 'package.json'), join(dir, 'package.json'));
  cpSync(join(repoRoot, 'scripts'), join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  return dir;
}

function runTests(dir) {
  // Strip NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID: this test file itself
  // runs under `node --test`, which sets those on its own worker process so
  // it can talk to *its* parent over an internal channel. If we let them
  // leak into the fixture's nested `node --test` invocation (spawned inside
  // run-tests.mjs), that grandchild thinks it must report back the same way
  // instead of writing TAP to stdout, and its output goes missing here even
  // though the process still exits 0. Real `npm test` runs are never
  // invoked from inside another node --test process, so this only matters
  // for this meta-test.
  const env = { ...process.env, TEST_REPORTER: 'tap' };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return spawnSync(process.execPath, [join(dir, 'scripts', 'run-tests.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
}

test('fails loudly (non-zero exit) when zero test files are collected', () => {
  const dir = makeFixture();
  try {
    const result = runTests(dir);
    assert.notEqual(result.status, 0, `expected non-zero exit for zero-test run, got ${result.status}\nstdout:${result.stdout}\nstderr:${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovers and executes a test file nested in a subdirectory of test/', () => {
  const dir = makeFixture();
  try {
    mkdirSync(join(dir, 'test', 'nested', 'deeper'), { recursive: true });
    writeFileSync(
      join(dir, 'test', 'nested', 'deeper', 'extra.test.mjs'),
      "import { test } from 'node:test';\n" +
        "import assert from 'node:assert/strict';\n" +
        "test('nested subdirectory test must run', () => assert.equal(1, 1));\n",
    );
    const result = runTests(dir);
    assert.equal(result.status, 0, `expected success, got ${result.status}\nstdout:${result.stdout}\nstderr:${result.stderr}`);
    assert.ok(
      result.stdout.includes('nested subdirectory test must run'),
      `expected output to include the nested test name; stdout was:\n${result.stdout}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
