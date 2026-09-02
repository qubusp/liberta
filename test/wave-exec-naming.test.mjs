// Regression test for the session-scoping invariants of scripts/wave-exec.js
// (see the NAMING AND OWNERSHIP INVARIANTS block at the top of that file and
// site/docs/concurrency.md section 5).
//
// What can go wrong without these guards, concretely:
//   * A session id containing "/" or ".." is pasted straight into
//     `liberta/<id>-wave<n>` and into a run-store path, producing a ref in a
//     surprising namespace (or a path escaping the run store).
//   * `worktree add` falls back to reusing an EXISTING branch of the target
//     name. If that branch belongs to another owner, this session silently
//     builds on, and later merges, somebody else's commits.
//   * The teardown loop force-removes whatever worktree_path happens to be in
//     dispatch-plan.json. A stale or hand-edited plan pointing at another
//     live session's worktree deregisters and deletes that session's tree
//     mid-run.
//   * The merge worktree used to live in os.tmpdir() keyed only by repo
//     basename + wave branch, i.e. outside any session's own directory.
//
// EVERY git command in this file runs against a throwaway repo created with
// `git init` under mkdtemp. Nothing here touches the developer's checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const waveExec = path.join(repoRoot, 'scripts', 'wave-exec.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A fresh throwaway repo + run store. Never the caller's repo. */
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-exec-naming-'));
  const repo = path.join(root, 'repo');
  const runs = path.join(root, 'runs');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  git(root, ['init', '-q', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'wave-exec test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'seed']);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, runs };
}

function seedSession(sb, sessionId, tasks, wave = 1) {
  const dir = path.join(sb.runs, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plan.json'),
    JSON.stringify({ tasks: tasks.map((id) => ({ id, wave, role: 'builder', model: 'sonnet' })) }, null, 2)
  );
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ git_root: sb.repo }, null, 2));
  fs.writeFileSync(path.join(dir, 'goal.md'), 'base_branch: main\n');
  return dir;
}

function run(sb, args) {
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

function worktreePaths(repo) {
  return git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

/** git reports realpaths; compare like with like. */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// --- I1 + I2: names are unique across sessions, waves and tasks ------------

test('branch and worktree names are disjoint across concurrent sessions', (t) => {
  const sb = sandbox(t);
  const sessions = ['sess-alpha', 'sess-beta', 'sess-alpha-2'];
  const waves = [1, 2];
  const tasks = ['T1', 'T2', 'T10'];

  const seen = new Map(); // branch -> owner label
  const seenPaths = new Map();
  for (const s of sessions) {
    const dir = path.join(sb.runs, s);
    fs.mkdirSync(dir, { recursive: true });
    const all = [];
    for (const w of waves) for (const id of tasks) all.push({ id, wave: w, role: 'builder' });
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ tasks: all }, null, 2));
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ git_root: sb.repo }, null, 2));
    fs.writeFileSync(path.join(dir, 'goal.md'), 'base_branch: main\n');
    for (const w of waves) {
      const r = run(sb, [s, String(w)]);
      assert.equal(r.code, 0, `generate ${s} wave ${w} failed: ${r.err}`);
      const plan = JSON.parse(
        fs.readFileSync(path.join(dir, 'waves', String(w), 'dispatch-plan.json'), 'utf8')
      );
      const owner = `${s}/${w}`;
      for (const b of [plan.wave_branch, ...plan.tasks.map((e) => e.branch)]) {
        if (seen.has(b) && seen.get(b) !== owner) {
          assert.fail(`branch ${b} claimed by both ${seen.get(b)} and ${owner}`);
        }
        seen.set(b, owner);
      }
      for (const e of plan.tasks) {
        assert.ok(
          e.worktree_path.startsWith(path.join(sb.runs, s, 'waves', String(w)) + path.sep),
          `worktree ${e.worktree_path} escapes ${s} wave ${w}`
        );
        assert.equal(seenPaths.has(e.worktree_path), false, `worktree path reused: ${e.worktree_path}`);
        seenPaths.set(e.worktree_path, owner);
      }
    }
  }
  // 3 sessions x 2 waves x (1 wave branch + 3 task branches) = 24 distinct names.
  assert.equal(seen.size, 24);
  assert.equal(seenPaths.size, 18);
  // Every ref that exists in the repo is inside exactly one session namespace.
  for (const b of branches(sb.repo)) {
    if (b === 'main') continue;
    const owners = sessions.filter((s) => b.startsWith(`liberta/${s}-wave`));
    assert.ok(owners.length >= 1, `ref ${b} belongs to no session`);
  }
});

// --- I1: hostile ids are rejected, not pasted into refs --------------------

const HOSTILE_SESSION_IDS = [
  'a/b',
  '../escape',
  'dot..dot',
  '-leading-dash',
  'trailing.',
  'has space',
  'refs.lock',
  '@',
  'caret^1',
  'tilde~1',
  'colon:name',
  'star*',
  'quest?',
  'brack[1]',
  'back\\slash',
  'new\nline',
  '',
];

test('hostile session ids fail loudly instead of producing weird refs', (t) => {
  const sb = sandbox(t);
  for (const bad of HOSTILE_SESSION_IDS) {
    const r = run(sb, [bad, '1']);
    assert.notEqual(r.code, 0, `session id ${JSON.stringify(bad)} was accepted`);
    assert.match(r.err, /wave-exec:/);
    if (bad !== '') assert.match(r.err, /session id|usage:/);
  }
  // Nothing hostile ever reached the ref namespace.
  assert.deepEqual(branches(sb.repo), ['main']);
  assert.deepEqual(worktreePaths(sb.repo), [real(sb.repo)]);
});

test('hostile wave numbers and task ids fail loudly', (t) => {
  const sb = sandbox(t);
  for (const bad of ['-1', '1.5', 'one', '../2', '1;rm', '']) {
    const r = run(sb, ['sess-ok', bad]);
    assert.notEqual(r.code, 0, `wave ${JSON.stringify(bad)} was accepted`);
  }
  seedSession(sb, 'sess-ok', ['../evil', 'a/b', 'x..y']);
  const r = run(sb, ['sess-ok', '1']);
  assert.notEqual(r.code, 0, 'hostile task id was accepted');
  assert.match(r.err, /task id/);
  assert.deepEqual(branches(sb.repo).filter((b) => b !== 'main' && b.includes('evil')), []);
});

// --- I3: a foreign branch of the target name is never silently reused ------

test('an existing branch not owned by this session is a loud failure', (t) => {
  const sb = sandbox(t);
  seedSession(sb, 'sess-a', ['T1']);
  // Simulate another owner having already created the exact task branch.
  git(sb.repo, ['branch', 'liberta/sess-a-wave1-task-T1', 'main']);
  const head = git(sb.repo, ['rev-parse', 'liberta/sess-a-wave1-task-T1']).trim();

  const r = run(sb, ['sess-a', '1']);
  assert.notEqual(r.code, 0, 'foreign branch collision was silently reused');
  assert.match(r.err, /not owned by session/i);
  // The foreign branch is left exactly as it was: never reused, never deleted.
  assert.equal(git(sb.repo, ['rev-parse', 'liberta/sess-a-wave1-task-T1']).trim(), head);
  assert.deepEqual(worktreePaths(sb.repo), [real(sb.repo)]);
});

test('a branch this session already owns is reused without complaint', (t) => {
  const sb = sandbox(t);
  seedSession(sb, 'sess-a', ['T1']);
  const first = run(sb, ['sess-a', '1']);
  assert.equal(first.code, 0, first.err);
  const wt = path.join(sb.runs, 'sess-a', 'waves', '1', 'worktrees', 'T1');
  assert.ok(fs.existsSync(wt));
  assert.ok(worktreePaths(sb.repo).some((p) => p === real(wt)));
  const owned = JSON.parse(
    fs.readFileSync(path.join(sb.runs, 'sess-a', 'waves', '1', 'owned-branches.json'), 'utf8')
  );
  assert.ok(owned.branches.includes('liberta/sess-a-wave1-task-T1'));
  // Re-running generate is idempotent, not a self-inflicted collision.
  const second = run(sb, ['sess-a', '1']);
  assert.equal(second.code, 0, second.err);
});

// --- I5: removal is fenced to this session's own wave directory ------------

test('teardown refuses to remove another session paths and still removes its own', (t) => {
  const sb = sandbox(t);
  seedSession(sb, 'sess-a', ['T1']);
  seedSession(sb, 'sess-b', ['T1']);
  assert.equal(run(sb, ['sess-a', '1']).code, 0);
  assert.equal(run(sb, ['sess-b', '1']).code, 0);

  const aWave = path.join(sb.runs, 'sess-a', 'waves', '1');
  const bWorktree = path.join(sb.runs, 'sess-b', 'waves', '1', 'worktrees', 'T1');
  assert.ok(fs.existsSync(bWorktree));

  const planPath = path.join(aWave, 'dispatch-plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const aWorktree = plan.tasks[0].worktree_path;
  // Point session A's plan at session B's live worktree (stale/hand-edited
  // plan, or a path escaping via ".." / a symlink).
  plan.tasks[0].worktree_path = bWorktree;
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  fs.writeFileSync(
    path.join(aWave, 'wave-state.json'),
    JSON.stringify({
      wave_branch: 'liberta/sess-a-wave1',
      task_ids: ['T1'],
      role_warnings: [],
      spend: 0,
      results: { T1: { task_id: 'T1', passed: true, model_used: 'sonnet', evidence: 'x', branch: 'liberta/sess-a-wave1-task-T1', merged: true, blocker: null } },
    }, null, 2)
  );

  const r = run(sb, ['sess-a', '1', '--summary']);
  assert.notEqual(r.code, 0, "session A tore down session B's worktree");
  assert.match(r.err, /outside this session/i);
  assert.ok(fs.existsSync(bWorktree), "session B's worktree was deleted");
  assert.ok(
    worktreePaths(sb.repo).some((p) => p === real(bWorktree)),
    "session B's worktree was deregistered"
  );

  // Also try a traversal path that lexically starts inside A but resolves out.
  const traversal = path.join(aWave, 'worktrees', '..', '..', '..', '..', 'sess-b', 'waves', '1', 'worktrees', 'T1');
  plan.tasks[0].worktree_path = traversal;
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const r2 = run(sb, ['sess-a', '1', '--summary']);
  assert.notEqual(r2.code, 0, 'a ".." traversal path defeated the fence');
  assert.ok(fs.existsSync(bWorktree));

  // With its own path restored, teardown works normally.
  plan.tasks[0].worktree_path = aWorktree;
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const r3 = run(sb, ['sess-a', '1', '--summary']);
  assert.equal(r3.code, 0, r3.err);
  assert.equal(fs.existsSync(aWorktree), false, "session A's own worktree was not removed");
  assert.ok(fs.existsSync(bWorktree), "session B's worktree was collateral damage");
});

// --- I4: the merge worktree lives under the session's own wave directory ---

test('merging happens in a session-scoped worktree, never in the shared tmpdir', (t) => {
  const sb = sandbox(t);
  seedSession(sb, 'sess-m', ['T1']);
  assert.equal(run(sb, ['sess-m', '1']).code, 0);
  const wt = path.join(sb.runs, 'sess-m', 'waves', '1', 'worktrees', 'T1');
  fs.writeFileSync(path.join(wt, 'done.txt'), 'work\n');
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-qm', 'task work']);

  const tmpBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('liberta-wave-merge-'));
  const r = run(sb, ['sess-m', '1', '--record', 'T1', '--result', 'passed', '--evidence', 'ok']);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).merged, true);

  const tmpAfter = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('liberta-wave-merge-'));
  assert.deepEqual(tmpAfter, tmpBefore, 'a merge worktree was created in the shared tmpdir');
  for (const p of worktreePaths(sb.repo)) {
    if (p === real(sb.repo)) continue;
    assert.ok(
      p.startsWith(real(sb.runs) + path.sep),
      `worktree registered outside the run store: ${p}`
    );
    assert.equal(/liberta-wave-merge-/.test(p), false, `shared-tmpdir merge worktree: ${p}`);
  }
  // The wave branch really did get the task commit.
  const log = git(sb.repo, ['log', '--oneline', 'liberta/sess-m-wave1']);
  assert.match(log, /task work/);
  // And the merge tree was cleaned up from inside the session's own dir.
  assert.equal(fs.existsSync(path.join(sb.runs, 'sess-m', 'waves', '1', 'merge')), false);
});

// --- I6: the banned commands appear nowhere in the shipped scripts ---------

test('no script or skill runs a bare worktree prune, foreign removal or forced branch delete', () => {
  const offenders = [];
  const banned = [
    /worktree["'\s,\]]+\s*["']?prune/,
    /git\s+worktree\s+prune/,
    /branch["']\s*,\s*["']-D/,
    /git\s+branch\s+-D/,
  ];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (/\.(js|cjs|mjs|sh|md)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        for (const line of text.split('\n')) {
          if (/never|refus|ban|not allowed|forbid/i.test(line)) continue; // prose about the ban
          if (banned.some((re) => re.test(line))) offenders.push(`${full}: ${line.trim()}`);
        }
      }
    }
  };
  walk(path.join(repoRoot, 'scripts'));
  walk(path.join(repoRoot, 'skills'));
  assert.deepEqual(offenders, []);
});
