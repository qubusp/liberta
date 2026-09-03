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

## Environment variables that matter

| Variable | Effect |
|---|---|
| `LIBERTA_CONSOLE_PASSWORD` | Console login. When unset or empty, falls back to the built-in default `libert@123!` and prints a warning. Always wins when set. |
| `LIBERTA_RUNS_DIR` | Run-store root. Also scopes the console sqlite mirror. |
| `LIBERTA_CONSOLE_DB` | Explicit sqlite path. Overrides everything; two instances can deliberately share a database this way. |
| `LIBERTA_CONSOLE_PORT_AUTO` | When the requested port is taken, bind the next free port instead of exiting. |
| `PORT` | Console port, default 4177. `PORT=0` asks the OS for a free port. |

## Remaining work

Everything below lives in the `installer-hardening` chunk and every task edits
`install.sh` only, so they are chained rather than run in parallel. Branch:
`harness/liberta-parallel-sessions-2026-09-02-installer-hardening` (tip `41ec919`).

Already merged onto that branch:

- **T27** `install.sh --start` now confirms via `lsof` that the pid it spawned is
  the process actually holding the port, instead of accepting any HTTP 200. Without
  this, a second session on a taken port was told its console was running when the
  first session's console had answered and its own process had died.
- **T25** unique per-run log file (`/tmp/liberta-console-<port>-<pid>.log`), so two
  installs no longer clobber each other's diagnostics.

Still open, in dependency order:

### T26 (in progress, unverified)

Make the backgrounded console discoverable by path so the documented pid cleanup
works, and resolve the real bound port instead of the requested one.

There is a commit for this, `2760110`, on branch
`...-installer-hardening--T26`. It was **never independently verified and never
passed QA**, because the run was stopped mid-wave. Do not treat it as done because
the commit exists. Re-run it through the gates.

### T31 (the bug that matters most here)

`install.sh --start` with `PORT=0`, which `server.js` explicitly supports for test
harnesses, builds its health-check URL from the literal requested port and gets
`http://localhost:0`. The console binds a real OS-assigned port and logs it, the
health check can never succeed, and after the timeout `install.sh` prints its
did-not-start error and exits 1 **without killing the process it spawned**. The
console was confirmed alive more than three seconds after exit, reparented to init.
A permanent orphan, which is exactly what this chunk exists to prevent.

Acceptance: exits non-zero and leaves zero `console/server.js` processes, checked at
least three seconds after `install.sh` has exited, on every failure path.

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
