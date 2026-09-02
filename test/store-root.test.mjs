// Covers scripts/_store.mjs / scripts/_store.cjs: the LIBERTA_RUNS_DIR
// override must redirect runsRoot()/sessionDir()/indexPath() to a temp
// directory, and must fall back to the real ~/.claude/liberta-runs path
// when unset (or set to an empty string).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const storeMjs = fileURLToPath(new URL('../scripts/_store.mjs', import.meta.url));
const storeCjs = fileURLToPath(new URL('../scripts/_store.cjs', import.meta.url));

function runProbe(modulePath, env) {
  const isEsm = modulePath.endsWith('.mjs');
  const code = isEsm
    ? `import { runsRoot, sessionDir, indexPath } from ${JSON.stringify(modulePath)};
       process.stdout.write(JSON.stringify({ runsRoot: runsRoot(), sessionDir: sessionDir('abc'), indexPath: indexPath() }));`
    : `const { runsRoot, sessionDir, indexPath } = require(${JSON.stringify(modulePath)});
       process.stdout.write(JSON.stringify({ runsRoot: runsRoot(), sessionDir: sessionDir('abc'), indexPath: indexPath() }));`;
  const result = spawnSync(process.execPath, ['--input-type', isEsm ? 'module' : 'commonjs', '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, `probe failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

const defaultRoot = path.join(os.homedir(), '.claude', 'liberta-runs');

test('runsRoot() defaults to ~/.claude/liberta-runs when LIBERTA_RUNS_DIR is unset', () => {
  const out = runProbe(storeMjs, { LIBERTA_RUNS_DIR: undefined });
  assert.equal(out.runsRoot, defaultRoot);
  assert.equal(out.sessionDir, path.join(defaultRoot, 'abc'));
  assert.equal(out.indexPath, path.join(defaultRoot, 'index.json'));
});

test('runsRoot() defaults when LIBERTA_RUNS_DIR is set to an empty string', () => {
  const out = runProbe(storeMjs, { LIBERTA_RUNS_DIR: '' });
  assert.equal(out.runsRoot, defaultRoot);
});

test('runsRoot() honors LIBERTA_RUNS_DIR, resolved to an absolute path', () => {
  const out = runProbe(storeMjs, { LIBERTA_RUNS_DIR: '/tmp/some-fixture-dir' });
  assert.equal(out.runsRoot, path.resolve('/tmp/some-fixture-dir'));
  assert.equal(out.sessionDir, path.join(path.resolve('/tmp/some-fixture-dir'), 'abc'));
  assert.equal(out.indexPath, path.join(path.resolve('/tmp/some-fixture-dir'), 'index.json'));
});

test('the CommonJS module (scripts/_store.cjs) resolves identically to the ESM shim', () => {
  const esm = runProbe(storeMjs, { LIBERTA_RUNS_DIR: '/tmp/some-fixture-dir' });
  const cjs = runProbe(storeCjs, { LIBERTA_RUNS_DIR: '/tmp/some-fixture-dir' });
  assert.deepEqual(cjs, esm);
});
