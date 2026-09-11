# CLAUDE.md

Working notes for agents in this repo. Written 2026-09-02 by the harness run
`liberta-parallel-sessions-2026-09-02`.

## Project conventions

- Docs live in `site/docs/*.md` with jekyll front matter (`layout: doc`), mirrored
  by `console/README.md` and the top-level `README.md`. A new docs page is invisible
  unless it is also added to `docs_nav` in `site/_config.yml`, because the layout,
  the sidebar and the homepage card grid all iterate that list and nothing else.
- Tests run with `npm test`, which is `node scripts/run-tests.mjs`. It collects
  `test/**/*.test.mjs` itself and passes explicit paths to `node --test`. Do not
  replace it with a bare `node --test`: that executes every `.js`/`.mjs`/`.cjs`
  under `test/` as a test file, so a shared fixture module either crashes the run or
  is counted as a passing zero-assertion test. `npm run test:one -- <file>` runs one
  file and goes through the same discovery.
- The runner exits non-zero when it collects zero test files. That is deliberate.
- No em or en dashes anywhere. Note that `grep -P` is unavailable on BSD grep, so
  `! grep -P '[\x{2013}\x{2014}]' file` passes vacuously and enforces nothing. Use a
  node scan instead.
- `console/node_modules` is not inherited by git worktrees. A fresh worktree fails
  four password tests with a missing `express` until you run `npm install` in
  `console/`. That is an environment gap, not a code defect.

## Safety rules on this machine

These are not stylistic. A different long-running session shares this repo and has
around 29 registered git worktrees pointing into it.

- Never write, prune or delete anything under `~/.claude/liberta-runs`.
- Never run `git worktree prune` or `git branch -D` here. Prune is not scoped to
  your own worktrees, and `-D` will silently discard an unmerged branch that holds
  the only copy of a commit. Use `git branch -d`, which refuses unmerged branches.
- Never `pkill -f node`. It would kill the operator console.
- Never bind or probe port 4177. The operator console answers there, so a health
  check against it returns a false success for a process you never started.
- Every concurrency test must point `LIBERTA_RUNS_DIR` at an `fs.mkdtempSync`
  directory. The console scopes its sqlite mirror to that store
  (`<LIBERTA_RUNS_DIR>/console-data/liberta-<port>.sqlite`), so a throwaway store
  gets a throwaway database.
- `pgrep -f 'console/server.js'` false-positives on any shell command whose own
  command line contains that string. Match on the process being `node` as well.
- The pid-cleanup idiom used throughout this chunk's verify scripts, collecting
  spawned console pids into a variable with a leading space (`NEW="$NEW $p"`) and
  then doing `for p in $NEW; do kill "$p" 2>/dev/null || true; done`, is not
  zsh-safe. bash word-splits an unquoted `$NEW` on IFS, so each `p` comes out as a
  clean pid; zsh does not word-split an unquoted parameter expansion by default, so
  the whole value including the leading space (e.g. `" 93828"`) is passed to `kill
  "$p"` as one token, which fails with `illegal pid:  93828` and leaves the process
  running, reparented to init. zsh is the default interactive shell on this machine
  and the shell backing an agent's Bash tool, so running one of these verify
  snippets literally in an agent's own shell silently orphans a `console/server.js`
  process: the `2>/dev/null || true` swallows the kill failure, so nothing reports
  an error even though the process leaked. `install.sh` itself is unaffected (it
  has a `#!/usr/bin/env bash` shebang), so no real end user hits this; it is purely
  an agent-verify-script hazard on this shared machine. Fix by either wrapping the
  loop in an explicit `bash -c '...'` so bash's word-splitting rules apply, or by
  rewriting the idiom to avoid relying on unquoted-parameter word splitting
  entirely, for example collecting pids newline-separated and consuming them with
  `while IFS= read -r p; do kill "$p" 2>/dev/null || true; done`, which kills the
  process identically under bash and zsh.

## Environment variables that matter

| Variable | Effect |
|---|---|
| `LIBERTA_CONSOLE_PASSWORD` | Console login. When unset or empty, falls back to the built-in default `libert@123!` and prints a warning. Always wins when set. |
| `LIBERTA_RUNS_DIR` | Run-store root. Also scopes the console sqlite mirror. |
| `LIBERTA_CONSOLE_DB` | Explicit sqlite path. Overrides everything; two instances can deliberately share a database this way. |
| `LIBERTA_CONSOLE_PORT_AUTO` | When the requested port is taken, bind the next free port instead of exiting. |
| `PORT` | Console port, default 4177. `PORT=0` asks the OS for a free port. |

## Remaining work

All of the `installer-hardening` work below edits `install.sh` only. Branch:
`harness/liberta-parallel-sessions-2026-09-02-installer-hardening` (tip `3808504`),
fully merged into `main` via PR #9.

**Status as of 2026-09-11.** T21, T22, T24, T25, T26, T27, T31, T32, T40, T44 and
T48 are all done, merged and independently verified. An earlier revision of this
section listed T26, T31, T24, T21 and T22 as open or unverified; that was stale by
several iterations. Check `tasks.json` in the run directory, not this file, for
live task status.

The operator descoped the remaining installer hardening on 2026-09-03: this is a
local single-operator tool, so edge cases beyond basic functionality are not worth
doing. T39 and T43 are `deferred` under that ruling (unwritable `TMPDIR`, and an
untrappable SIGKILL landing in a specific window). Do not re-file them.

Still open: T42 and T51 (both depend on T41, which is now done, so both are
unblocked), plus T49 (the printed no-start `npm start` instructions omit
`LIBERTA_CONSOLE_HOST`). T50 also depends on T41 but is the untrappable-SIGKILL
class the operator descoped, so treat it as deferred in practice.

### T41 (done, merged in two parts)

`install.sh` overwrites the installed skill and agent roster in place rather than
leaving `.bak-<timestamp>` directories behind. Without this, a reinstall registers
the backup directory as a second competing skill, which was observed live.

This landed in two parts, and the history is worth keeping because the intermediate
state was dangerous. PR #10 merged `25f4066`, a rebase of an *earlier* revision that
QA had already rejected: in `install_dir_in_place`, the EXIT trap was cleared with
`trap - EXIT` before the swap, so if `mv "$staging" "$dst"` failed after
`mv "$dst" "$old_aside"` had already succeeded, nothing restored the old tree and
the operator was left with no skill installed at all. For several hours `main`
carried the feature without its crash safety.

The accepted fix is commit `9f10e86` on branch `...-installer-hardening--T41`: a
`dst_moved_aside` flag and an EXIT trap that moves `$old_aside` back to `$dst` when
the final `mv` fails. That branch predates PR #9's merge, so it could not be merged
wholesale and a cherry-pick onto `main` conflicted. It was reapplied by hand as
`ea40355`, `install_dir_in_place` byte-identical to `9f10e86` and nothing else in
`install.sh` touched, and merged via **PR #11** (merge commit `22596c3`).

The lesson for the next rebase-onto-a-diverged-base: a merge commit existing is not
evidence that the intended content arrived. Verify the merged result, not the branch
you built.

The failure path is testable, but only with a failure injection that is itself
verified to fire. Override `mv` as a real executable earlier on `PATH` (a shell
function is not picked up by the already-parsed function body) that fails only when
the source basename matches `.<dst>.incoming.*`, and assert the injection actually
fired before reading the result. Confirmed against merged `main` on 2026-09-11: the
destination is restored with no leftover dot-directories, exit non-zero. Against the
pre-fix revision the destination ends up missing with two orphaned dot-directories.
An earlier probe that skipped the fired-check silently exercised the happy path and
reported a false pass.

The remaining QA withhold on T41 is a SIGKILL landing exactly between the two `mv`
calls. That is the untrappable-kill class the operator descoped on 2026-09-03; it is
tracked as T50 and is not addressed by PR #11.

### T32 (PORT=0 determinism confirmation, done)

Confirmed on branch `...-installer-hardening--T32` on top of the T26 tip.
`install.sh` was **not** changed: the real-bound-port resolution from T26/T31 is
correct as written, and a successful `--start` is supposed to leave the console
running, exactly like the free-port case.

Measured here across 77 `PORT=0 ./install.sh --start` runs:

- 75 reported success, printed a real OS-assigned port (never `localhost:0`), and
  the pid they printed was still alive three seconds after `install.sh` exited.
- 1 reported success and the console it spawned was gone three seconds later,
  silently: no `FATAL` in `/tmp/liberta-console-0-<pid>.log`, only the normal
  banner and the `listening on http://localhost:<port>` line.
- 1 took the did-not-start path, exited 1, and correctly left zero
  `console/server.js` processes behind.

The literal T32 verify (five `PORT=0` runs plus the occupied-port failure case)
was executed four times back to back and exited 0 every time, 20 consecutive runs.
A separate 45-run batch launched with a `--require` signal-tracing preload never
reproduced the death and never recorded a signal, so the rare post-success exit is
not SIGHUP or SIGTERM arriving at the process, and there is no evidence of a
daemonization defect that `install.sh` could fix from the outside.

Practical rule: a single isolated `install.sh reported success but left no running
console` is this known flake of roughly one percent. Re-run before filing it as a
regression. Two in a row is a real signal. The no-orphan requirement on the failure
paths held in every single observed run.

Running the installer also chmod +x's `scripts/*.mjs` and `scripts/*.js`, so a
verify batch leaves five mode-only diffs in the working tree. Revert them with
`git checkout -- scripts/` before committing.

### T24

Kill the backgrounded console when the liveness poll times out. Overlaps T31's
orphan half; kept separate so it re-verifies independently. Must leave
`console/server.js` untouched (the test patches it under a trap and asserts
`git diff --quiet` afterwards).

### T21 and T22 (confirmations)

T21: the summary must name the password actually in effect, never printing
`libert@123!` when `LIBERTA_CONSOLE_PASSWORD` was exported, and never echoing the
operator's own value. T22: never print `console running` unless the console really
answered. Both requirements are believed already satisfied by T3 and T27; these
tasks exist to confirm that independently rather than assume it.

## Resuming the harness

    /albert --resume liberta-parallel-sessions-2026-09-02

State is in `~/.claude/agent-runs/liberta-parallel-sessions-2026-09-02/`
(`progress.json`, `tasks.json`, `HANDOVER.md`). Six PRs are open and stacked, #3
through #8, covering the console password default and parallel-session isolation
A1 to A5. `merge_policy` is `none`, so nothing merges without a human. `main` is
untouched at `b6cfdf9`.

## One habit worth keeping

A verify command is the contract. Run it literally. If it is wrong, report it as
blocked and quote the failure so the plan can be fixed; do not substitute your own
check and report success against that. Several real defects in this run were found
only because a reviewer refused to accept a check that could not fail, including a
gate that forbade a legitimate read-only `openSync`, an em-dash guard that enforced
nothing, and a database check that supplied the very isolation it was meant to test.
