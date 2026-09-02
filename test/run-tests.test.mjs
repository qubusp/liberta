// Regression tests for scripts/run-tests.mjs.
//
// The runner must hand EXPLICIT *.test.mjs file paths to `node --test`. A bare
// `node --test` (no positional args) treats every .js/.mjs/.cjs file under a
// directory named `test` as a test file, so a plain helper module such as
// test/helpers/http.mjs would be imported and executed standalone: a throwing
// helper crashes the whole run, a harmless one shows up as a green
// zero-assertion pseudo-test. Shared fixtures under test/ are expected here, so
// these tests pin the behaviour.
//
// Each case builds a throwaway fixture "repo" in a temp dir (a copy of the real
// scripts/run-tests.mjs plus a synthetic test/ tree) and runs it for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const realRunner = join(repoRoot, 'scripts', 'run-tests.mjs');

const PASSING_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('%NAME%', () => assert.equal(1, 1));",
  '',
].join('\n');

function passingTest(name) {
  return PASSING_TEST.replace('%NAME%', name);
}

/**
 * Build a fixture repo containing a copy of the real runner.
 * @param {Record<string, string>} files repo-relative path -> contents
 * @returns {{ status: number|null, stdout: string, stderr: string, all: string }}
 */
function runRunner(files) {
  const root = mkdtempSync(join(tmpdir(), 'run-tests-fixture-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    copyFileSync(realRunner, join(root, 'scripts', 'run-tests.mjs'));
    mkdirSync(join(root, 'test'), { recursive: true });
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    // Strip NODE_TEST_CONTEXT: node sets it for the file we are running in, and
    // inheriting it would make the child processes think they are test children
    // and emit the v8-serialized runner protocol instead of plain TAP.
    const env = { ...process.env, TEST_REPORTER: 'tap' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'run-tests.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    return { status: result.status, stdout, stderr, all: `${stdout}\n${stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a throwing non-*.test.mjs module under test/ is ignored entirely', () => {
  const run = runRunner({
    'test/a.test.mjs': passingTest('real-test'),
    'test/helpers/util.mjs':
      "export function helperFn(){ throw new Error('boom from helper'); }\nhelperFn();\n",
  });
  assert.equal(run.status, 0, `runner should exit 0, got ${run.status}:\n${run.all}`);
  assert.ok(!run.all.includes('helpers/util.mjs'), `helper leaked into output:\n${run.all}`);
  assert.ok(!run.all.includes('boom from helper'), `helper was executed:\n${run.all}`);
  assert.match(run.stdout, /^# pass 1$/m);
  assert.match(run.stdout, /^# fail 0$/m);
});

test('a harmless non-*.test.mjs module under test/ does not inflate the pass count', () => {
  const withHelper = runRunner({
    'test/a.test.mjs': passingTest('real-test'),
    'test/helpers/util.mjs': 'export function helperFn(){ return 1; }\n',
  });
  assert.equal(withHelper.status, 0, withHelper.all);
  assert.ok(!withHelper.all.includes('helpers/util.mjs'), withHelper.all);
  assert.match(withHelper.stdout, /^# tests 1$/m);
  assert.match(withHelper.stdout, /^# pass 1$/m);
});

test('nested *.test.mjs files are still discovered and run', () => {
  const run = runRunner({
    'test/a.test.mjs': passingTest('top-level-probe'),
    'test/sub/extra.test.mjs': passingTest('nested-discovery-probe'),
    'test/sub/deeper/more.test.mjs': passingTest('deeply-nested-probe'),
  });
  assert.equal(run.status, 0, run.all);
  assert.ok(run.stdout.includes('nested-discovery-probe'), run.all);
  assert.ok(run.stdout.includes('deeply-nested-probe'), run.all);
  assert.match(run.stdout, /^# pass 3$/m);
});

test('a real failing test still fails the run', () => {
  const run = runRunner({
    'test/a.test.mjs': "import test from 'node:test';\ntest('nope', () => { throw new Error('x'); });\n",
  });
  assert.notEqual(run.status, 0, `expected non-zero exit:\n${run.all}`);
});

test('zero *.test.mjs files exits non-zero with a clear message', () => {
  const run = runRunner({ 'test/helpers/util.mjs': 'export const x = 1;\n' });
  assert.notEqual(run.status, 0, `expected non-zero exit:\n${run.all}`);
  assert.match(run.stderr, /no test files found/);
});
