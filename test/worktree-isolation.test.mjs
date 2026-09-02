// Regression test: two simulated parallel Liberta sessions driving
// scripts/wave-exec.js against the SAME repository never collide on branch
// or worktree names, and a session can never remove, detach or modify
// anything that belongs to another session.
//
// Everything here runs against a throwaway repo created with
// fs.mkdtempSync + `git init`, under os.tmpdir(). Nothing in this file ever
// runs `git worktree remove` or any other mutating git command against the
// real repository under development.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const waveExec = path.join(repoRoot, 'scripts', 'wave-exec.js');

function hasGit() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

const GIT_AVAILABLE = hasGit();

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Fail loudly instead of ever letting a bug near the real repository. */
function assertInsideTmpdir(p) {
  const tmp = real(os.tmpdir());
  const target = real(p);
  if (target !== tmp && !target.startsWith(tmp + path.sep)) {
    throw new Error(
      `refusing to continue: throwaway repo path ${JSON.stringify(target)} is not inside ` +
        `os.tmpdir() (${JSON.stringify(tmp)}). This test must never touch a real repository.`
    );
  }
}

/** A fresh throwaway repo + a fresh throwaway LIBERTA_RUNS_DIR store. */
function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-isolation-'));
  assertInsideTmpdir(root);
  const repo = path.join(root, 'repo');
  const runs = path.join(root, 'runs');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  assertInsideTmpdir(repo);
  assertInsideTmpdir(runs);

  git(root, ['init', '-q', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'worktree-isolation-test@example.invalid']);
  git(repo, ['config', 'user.name', 'worktree-isolation test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'initial commit']);

  t.after(() => {
    // Only ever remove worktrees that belong to THIS throwaway repo, and
    // only reached via a real "worktree list" query against it -- never a
    // hardcoded or inherited path.
    try {
      const list = git(repo, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length))
        .filter((p) => real(p) !== real(repo));
      for (const wt of list) {
        assertInsideTmpdir(wt);
        try {
          git(repo, ['worktree', 'remove', '--force', wt]);
        } catch {
          // best-effort; the rmSync below still cleans the directory tree.
        }
      }
    } catch {
      // repo may already be gone; fall through to rmSync.
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, repo, runs };
}

function seedSession(sb, sessionId, taskIds, wave = 1) {
  const dir = path.join(sb.runs, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plan.json'),
    JSON.stringify({ tasks: taskIds.map((id) => ({ id, wave, role: 'builder', model: 'sonnet' })) }, null, 2)
  );
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ git_root: sb.repo }, null, 2));
  fs.writeFileSync(path.join(dir, 'goal.md'), 'base_branch: main\n');
  return dir;
}

function runWaveExec(sb, args) {
  const r = spawnSync(process.execPath, [waveExec, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LIBERTA_RUNS_DIR: sb.runs },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function branches(repo) {
  return git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function branchHead(repo, branch) {
  return git(repo, ['rev-parse', branch]).trim();
}

function worktreePorcelain(repo) {
  return git(repo, ['worktree', 'list', '--porcelain']);
}

function worktreePaths(repo) {
  return worktreePorcelain(repo)
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

function worktreeHead(repo, worktreePath) {
  const block = worktreePorcelain(repo).split('\n\n');
  const target = real(worktreePath);
  for (const b of block) {
    const lines = b.split('\n');
    const wtLine = lines.find((l) => l.startsWith('worktree '));
    if (wtLine && real(wtLine.slice('worktree '.length)) === target) {
      const headLine = lines.find((l) => l.startsWith('HEAD '));
      const branchLine = lines.find((l) => l.startsWith('branch '));
      return { head: headLine ? headLine.slice('HEAD '.length) : null, branch: branchLine ? branchLine.slice('branch '.length) : null, detached: lines.includes('detached') };
    }
  }
  return null;
}

test('two simulated sessions never collide on branch or worktree names', { skip: GIT_AVAILABLE ? false : 'git is not on PATH; skipping worktree-isolation test' }, async (t) => {
  const sb = makeSandbox(t);
  assertInsideTmpdir(sb.repo);

  seedSession(sb, 'sess-A', ['T1', 'T2']);
  seedSession(sb, 'sess-B', ['T1', 'T2']);

  const genA = runWaveExec(sb, ['sess-A', '1']);
  assert.equal(genA.code, 0, `sess-A generate failed: ${genA.err}`);
  const genB = runWaveExec(sb, ['sess-B', '1']);
  assert.equal(genB.code, 0, `sess-B generate failed: ${genB.err}`);

  const planA = JSON.parse(
    fs.readFileSync(path.join(sb.runs, 'sess-A', 'waves', '1', 'dispatch-plan.json'), 'utf8')
  );
  const planB = JSON.parse(
    fs.readFileSync(path.join(sb.runs, 'sess-B', 'waves', '1', 'dispatch-plan.json'), 'utf8')
  );

  const branchesA = new Set([planA.wave_branch, ...planA.tasks.map((e) => e.branch)]);
  const branchesB = new Set([planB.wave_branch, ...planB.tasks.map((e) => e.branch)]);
  for (const b of branchesA) {
    assert.equal(branchesB.has(b), false, `branch ${b} claimed by both sess-A and sess-B`);
  }

  const worktreesA = new Set(planA.tasks.map((e) => real(e.worktree_path)));
  const worktreesB = new Set(planB.tasks.map((e) => real(e.worktree_path)));
  for (const p of worktreesA) {
    assert.equal(worktreesB.has(p), false, `worktree path ${p} claimed by both sess-A and sess-B`);
  }

  // Sanity: every path really was registered as a distinct worktree.
  const liveWorktrees = new Set(worktreePaths(sb.repo).map(real));
  for (const p of [...worktreesA, ...worktreesB]) {
    assert.ok(liveWorktrees.has(p), `expected worktree ${p} to be registered`);
  }

  // Snapshot everything belonging to session A before session B does any
  // further work against the same repo.
  const aBranchHeadsBefore = new Map([...branchesA].map((b) => [b, branchHead(sb.repo, b)]));
  const aWorktreeStatesBefore = new Map(
    planA.tasks.map((e) => [real(e.worktree_path), worktreeHead(sb.repo, e.worktree_path)])
  );

  // Record + summary (which tears down worktrees) for session B only.
  for (const e of planB.tasks) {
    const rec = runWaveExec(sb, [
      'sess-B',
      '1',
      '--record',
      e.task_id,
      '--result',
      'passed',
      '--evidence',
      'ok',
      '--merged',
    ]);
    assert.equal(rec.code, 0, `sess-B record ${e.task_id} failed: ${rec.err}`);
  }
  const summaryB = runWaveExec(sb, ['sess-B', '1', '--summary']);
  assert.equal(summaryB.code, 0, `sess-B summary/teardown failed: ${summaryB.err}`);

  // Session A's branches must be untouched: same heads, still present.
  for (const b of branchesA) {
    assert.ok(branches(sb.repo).includes(b), `sess-A branch ${b} disappeared after sess-B ran`);
    assert.equal(
      branchHead(sb.repo, b),
      aBranchHeadsBefore.get(b),
      `sess-A branch ${b} was modified by sess-B's run`
    );
  }
  // Session A's worktrees must still be live, attached, and unchanged.
  for (const [p, before] of aWorktreeStatesBefore) {
    assert.ok(fs.existsSync(p), `sess-A worktree ${p} was deleted by sess-B's run`);
    const after = worktreeHead(sb.repo, p);
    assert.ok(after, `sess-A worktree ${p} vanished from git worktree list`);
    assert.equal(after.detached, false, `sess-A worktree ${p} was detached by sess-B's run`);
    assert.deepEqual(after, before, `sess-A worktree ${p} state changed by sess-B's run`);
  }
});

test('the removal guard refuses a path outside the owning session wave directory', { skip: GIT_AVAILABLE ? false : 'git is not on PATH; skipping worktree-isolation test' }, (t) => {
  const sb = makeSandbox(t);
  assertInsideTmpdir(sb.repo);

  seedSession(sb, 'sess-owner', ['T1']);
  seedSession(sb, 'sess-victim', ['T1']);
  assert.equal(runWaveExec(sb, ['sess-owner', '1']).code, 0);
  assert.equal(runWaveExec(sb, ['sess-victim', '1']).code, 0);

  const ownerWavePath = path.join(sb.runs, 'sess-owner', 'waves', '1', 'dispatch-plan.json');
  const ownerPlan = JSON.parse(fs.readFileSync(ownerWavePath, 'utf8'));
  const victimWorktree = path.join(sb.runs, 'sess-victim', 'waves', '1', 'worktrees', 'T1');
  assert.ok(fs.existsSync(victimWorktree));
  const victimHeadBefore = worktreeHead(sb.repo, victimWorktree);

  // Point the owning session's own dispatch plan at a worktree path outside
  // its own wave directory (here: another session's live worktree). This is
  // exactly the "direct call to the removal guard with a foreign path"
  // scenario: --summary is the only code path in wave-exec.js that invokes
  // the removal guard (assertOwnedWorktreePath / worktreeRemove), so driving
  // it through the CLI entry point with a foreign worktree_path calls the
  // guard directly with an out-of-bounds path.
  ownerPlan.tasks[0].worktree_path = victimWorktree;
  fs.writeFileSync(ownerWavePath, JSON.stringify(ownerPlan, null, 2));
  fs.writeFileSync(
    path.join(sb.runs, 'sess-owner', 'waves', '1', 'wave-state.json'),
    JSON.stringify(
      {
        wave_branch: ownerPlan.wave_branch,
        task_ids: ['T1'],
        role_warnings: [],
        spend: 0,
        results: {
          T1: {
            task_id: 'T1',
            passed: true,
            model_used: 'sonnet',
            evidence: 'x',
            branch: ownerPlan.tasks[0].branch,
            merged: true,
            blocker: null,
          },
        },
      },
      null,
      2
    )
  );

  const r = runWaveExec(sb, ['sess-owner', '1', '--summary']);
  assert.notEqual(r.code, 0, 'removal guard accepted a path outside the session wave directory');
  assert.match(r.err, /outside this session/i);
  assert.ok(fs.existsSync(victimWorktree), "victim's worktree was deleted by the foreign removal attempt");
  assert.deepEqual(
    worktreeHead(sb.repo, victimWorktree),
    victimHeadBefore,
    "victim's worktree state changed"
  );
});

test('a session id containing a slash, a space or a leading dash is rejected', { skip: GIT_AVAILABLE ? false : 'git is not on PATH; skipping worktree-isolation test' }, (t) => {
  const sb = makeSandbox(t);
  assertInsideTmpdir(sb.repo);

  const before = branches(sb.repo);
  const hostile = ['ses/sion', 'has space', '-leading-dash'];
  for (const id of hostile) {
    const r = runWaveExec(sb, [id, '1']);
    assert.notEqual(r.code, 0, `hostile session id ${JSON.stringify(id)} was accepted`);
    assert.match(r.err, /wave-exec:/, `no clear message for ${JSON.stringify(id)}`);
    assert.match(r.err, /session id|usage:/i, `message did not explain rejection for ${JSON.stringify(id)}`);
  }
  // Nothing hostile ever reached the ref namespace: no broken/new refs.
  assert.deepEqual(branches(sb.repo), before);
  assert.deepEqual(worktreePaths(sb.repo), [real(sb.repo)]);
});
