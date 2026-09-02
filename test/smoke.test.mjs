// Test layout convention:
//   * Every executable test lives at test/**/<name>.test.mjs and is run by
//     `npm test` (scripts/run-tests.mjs discovers them recursively).
//   * Any other file under test/ (e.g. test/helpers/http.mjs) is a plain
//     importable module and is never executed as a test.
//   * Tests are ESM (.mjs) and use node:test + node:assert/strict only. No npm
//     dependencies are allowed in this repo.
//
// Reaching console/ code from a test: the console modules are CommonJS and
// their dependencies are installed in console/node_modules, not at the repo
// root. So do NOT `import` them directly. Either build a CommonJS resolver
// rooted in console/:
//     import { createRequire } from 'node:module';
//     const requireFromConsole = createRequire(new URL('../console/', import.meta.url));
//     const mod = requireFromConsole('./some-module.js');
// or spawn a child process with cwd set to console/ so Node resolves against
// console/node_modules:
//     spawnSync(process.execPath, ['some-script.js'], { cwd: consoleDir });
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the test runner runs', () => {
  assert.equal(1 + 1, 2);
  assert.ok(true);
});

test('scripts/_status.mjs parses (node --check)', () => {
  const target = fileURLToPath(new URL('../scripts/_status.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  assert.equal(result.status, 0, `node --check failed:\n${result.stderr}`);
});
