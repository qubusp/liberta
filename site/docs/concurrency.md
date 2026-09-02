---
layout: doc
title: Concurrency and parallel sessions
summary: Every place two Liberta sessions on one machine can collide, with the exact interleaving, the blast radius, and the fix this run adopts.
description: An authoritative audit of shared mutable state in Liberta (index.json, state.json, events.jsonl, inbox files, git branches and worktrees, the console port and its sqlite mirror, and the installer), listing each interference point with a file and line reference, the losing interleaving, and the design decision taken for it.
sources: scripts/_log-event.mjs, scripts/_status.mjs, scripts/_mailbox.mjs, scripts/wave-exec.js, console/server.js, console/sync.js, console/db.js, install.sh, skills/liberta/SKILL.md
---

Liberta was designed around one live run at a time. The run store, the git
flow and the console all assume a single controller is the only writer. This
page is the audit of what actually breaks when a second session runs at the
same time, on the same machine, against the same target repository.

Scope of "at the same time": two Claude Code controller sessions each driving
the harness, plus the helper scripts they invoke (`scripts/_log-event.mjs`,
`scripts/wave-exec.js`, `scripts/_mailbox.mjs`), plus zero, one or two console
processes. Every reference below is `path:line` at the current HEAD.

Two things are true throughout and are worth stating once:

* Every JSON writer in the tree is a read, then a mutate in memory, then a
  whole-file rewrite. The rewrite is done through a temp file plus `rename`,
  which makes the *write* atomic (no reader ever sees a half-file), but does
  nothing at all about the window between the read and the write. Atomic
  replacement is not the same as a compare-and-swap, and nowhere in the tree
  is that distinction currently handled.
* There is no lock file, no `flock`, no `O_EXCL` create, no pid file and no
  advisory lease anywhere under `scripts/` or `console/`. Mutual exclusion
  between sessions does not exist today; it is assumed.

## 1. index.json read-modify-write in scripts/_log-event.mjs

**Shared resource.** `~/.claude/liberta-runs/index.json`, the single global
registry of every run, whose shape is documented at
`skills/liberta/SKILL.md:35`.

**The code.** `scripts/_log-event.mjs:187` reads the whole index,
`scripts/_log-event.mjs:192` finds this session's entry,
`scripts/_log-event.mjs:210` mutates its `status` (or
`scripts/_log-event.mjs:205` pushes a brand new entry), and
`scripts/_log-event.mjs:213` writes the whole object back.

**The losing interleaving.** Session A and session B each transition state and
each run `_log-event.mjs --status ...`:

1. A reads index.json. Its in-memory copy holds entries for A and B.
2. B reads index.json. Its in-memory copy also holds entries for A and B.
3. A sets its own entry to `running` and rewrites the file.
4. B sets its own entry to `verifying` and rewrites the file from the copy it
   took at step 2, which still carries A's *old* status.

A's update is gone. The worse variant is registration rather than status: if B
is a brand new session that appends itself at `scripts/_log-event.mjs:205`
while A is mid-cycle, whichever of the two writes second erases the other's
entry entirely, and a session that is absent from index.json is invisible to
`scripts/_status.mjs --all` (`scripts/_status.mjs:393` iterates
`idx.sessions`) and is skipped by the console sync loop, which only walks
`idx.sessions` (`console/sync.js:333` in `runSyncOnce`).

**Why the atomic write does not help.** `writeJsonAtomic` at
`scripts/_log-event.mjs:135` writes to `<file>.tmp-<pid>-<now>` and
`scripts/_log-event.mjs:138` renames it over the target. That guarantees a
concurrent reader sees either the whole old file or the whole new file, never
a truncated one. It cannot detect that the file changed after this process
read it, so the last writer silently wins with stale content. The elaborate
corruption refusal above it (`scripts/_log-event.mjs:85` onward) is defending
against a torn or hand-broken file, not against a concurrent one; a lost
update produces a perfectly well-formed index and sails straight through
`readIndexForUpdate`.

**Blast radius.** Silent deregistration of a live run. The console drops it
from the dashboard, `--all` stops listing it, and status changes stop being
visible. The run itself keeps working, which is what makes this dangerous: the
operator's only window onto it goes dark while it continues spending budget.

**Fix.** Make the read-modify-write a critical section, and make the write
itself conditional:

* Take an exclusive lock for the whole cycle. `fs.mkdirSync` on a
  `index.json.lock` directory, or `fs.openSync(..., "wx")` on a lock file, is
  atomic on both macOS and Linux and needs no dependency. Include the holder's
  pid and a timestamp in the file so a stale lock from a crashed process can be
  broken after a timeout rather than deadlocking the harness.
* Re-read the index *inside* the lock, immediately before mutating, so the
  copy that gets mutated is provably the current one.
* Keep the existing tmp-plus-rename write, which remains correct and still
  protects readers.
* On failure to acquire the lock, retry with a short backoff, then degrade the
  way the file already degrades elsewhere: log the event to events.jsonl
  (which is unaffected, see point 3) and report the index failure last, exactly
  as `scripts/_log-event.mjs:244` already does for a corrupt index. A logging
  failure must not stop the loop.

## 2. index.json.active_session_id is a global with one slot

**Shared resource.** The single `active_session_id` string at the top of
index.json (`skills/liberta/SKILL.md:35`).

**The code.** It is created as a scalar at `scripts/_log-event.mjs:91`, read as
the "which session am I" default at `scripts/_status.mjs:440`, used to star one
row in the `--all` table at `scripts/_status.mjs:393`, used by the controller
to decide whether to resume rather than start a new run at
`skills/liberta/SKILL.md:87`, and mirrored into the DB at
`console/sync.js:350`, which calls `markActiveRun`
(`console/sync.js:88`). That function clears the flag on every row
(`console/sync.js:89`) and then sets it on exactly one
(`console/sync.js:91`). The API surfaces exactly one active id at
`console/server.js:615`.

**The losing interleaving.** This one is not a race in the narrow sense; it is
a representational impossibility. The field has one slot, so two live sessions
cannot both be described by it. Concretely:

1. Session A starts and sets `active_session_id = A`.
2. Session B starts and sets `active_session_id = B`.
3. The operator runs `_status.mjs` with no argument. It resolves to B at
   `scripts/_status.mjs:440` and reports B, never mentioning that A exists and
   is running.
4. Worse: a fresh Claude Code session evaluating `skills/liberta/SKILL.md:87`
   sees `active_session_id` pointing at a `running` session and resumes *that*
   one. Two controllers can end up driving the same session id, both writing
   its `state.json` and `plan.json`.

**Blast radius.** Wrong-session resume is the severe case: two controllers
sharing one plan board, doubling iteration counts, double-dispatching the same
tasks, and merging the same task branches twice. The `--all` table and the
console dashboard also mislabel which run is live, which is how an operator
ends up steering the wrong run through the inbox.

**Fix.** Retire the scalar as the source of truth about liveness.

* Treat "active" as a derived, plural property: a session is live if its
  `state.json` has `status: "running"` and a fresh heartbeat. Add a
  `heartbeat_ts` (and the owning pid) to `state.json`, refreshed each loop
  iteration, so liveness can expire rather than being asserted forever by a
  crashed run.
* Keep `active_session_id` as a *selection* hint only (the run the CLI defaults
  to when the operator does not name one), and make it explicit in the docs
  that it means "most recently touched", not "the only one".
* `scripts/_status.mjs` with no id must refuse to guess when more than one
  session is live: print the live set and exit non-zero telling the operator to
  name one, rather than silently picking.
* `console/sync.js`'s `markActiveRun` must stop being a one-of-N flag and
  become "set `active` from each run's own status/heartbeat", so the dashboard
  can show two green rows.
* `skills/liberta/SKILL.md:87` must resume only on an explicit
  `--resume <session-id>`, never on the bare presence of an active pointer.

## 3. Per-session state.json and events.jsonl writes

**Shared resource.** `~/.claude/liberta-runs/<session-id>/state.json` and
`.../events.jsonl`.

**The code.** `scripts/_log-event.mjs:224` reads state.json,
`scripts/_log-event.mjs:235` sets `status`, and
`scripts/_log-event.mjs:237` rewrites the whole file. events.jsonl is appended
at `scripts/_log-event.mjs:179`.

**The losing interleaving for state.json.** These files are per session, so two
*different* sessions do not collide here. The collision is between the
controller and the helpers *within* one session id, and that is reachable in
normal operation and is guaranteed under a wrong-session resume (point 2):

1. The controller reads state.json to bump `iteration` and `tokens_spent`.
2. `scripts/wave-exec.js` records a task result, which calls back into
   `_log-event.mjs` (`scripts/wave-exec.js:109` shells out synchronously), which
   reads state.json at `scripts/_log-event.mjs:224`.
3. The controller writes state.json with the new iteration and the old status.
4. `_log-event.mjs` writes state.json at `scripts/_log-event.mjs:237` with the
   new status and the *old* iteration.

The iteration bump is lost. Since the budget guard at
`skills/liberta/SKILL.md:147` is `iteration >= max_iterations`, a lost bump
means the run overshoots its iteration budget. `stuck_counter` and `notes` are
lost the same way, and `notes` is the worse loss because it is an array that
gets wholesale replaced by the stale copy.

**The losing interleaving for events.jsonl.** `fs.appendFileSync` with a single
buffered write opens the file with `O_APPEND`, so concurrent appends of small
lines are effectively atomic on both macOS and Linux and do not interleave
mid-line. This is the one shared file in the design that is genuinely safe
under concurrency, and it is safe by construction (append-only, no read step),
not by accident. The residual risk is only ordering: the file is ordered by
write time, not by the `ts` field, so two writers can produce lines that are
out of timestamp order. The console's ingest is offset-based
(`console/sync.js:36`) and tolerates that, since it only refuses to consume a
partial trailing line.

**Blast radius.** Budget overshoot, lost operator notes, and a `stuck_counter`
that never trips the stall detector. Contained to one session, but it is the
session's own accounting.

**Fix.** Same lock discipline as point 1, applied per session:

* One lock per session directory (`<session-id>/.lock`), held across every
  read-modify-write of that session's `state.json` and `plan.json`.
* Narrow the writers: `_log-event.mjs` should update only the fields it owns
  (`status`) by re-reading under the lock, never by rewriting a snapshot taken
  earlier.
* Leave events.jsonl exactly as it is. Append-only with a single `appendFileSync`
  per event is already the correct primitive; document that it must stay that
  way (no read-modify-write, no rewriting, no rotation in place).

## 4. Inbox writes in scripts/_mailbox.mjs

**Shared resource.** `~/.claude/liberta-runs/<session-id>/inbox/*.json` and its
`archive/` subdirectory. There are two independent writers of these files: the
CLI at `scripts/_mailbox.mjs:172` and the console API at
`console/server.js:1412`.

**The losing interleavings.**

*Send versus send.* Filenames are timestamp plus type plus three random bytes,
built identically at `scripts/_mailbox.mjs:167` and `console/server.js:1408`.
Two sends in the same millisecond collide only on a 1-in-16-million random
suffix, and the write is a rename over the target, so a collision silently
destroys one operator message rather than erroring. Low probability, total
data loss when it hits, and no detection.

*Reply versus reply (the real one).* `cmdReply` reads the message at
`scripts/_mailbox.mjs:132`, mutates it in memory, writes it into `archive/` at
`scripts/_mailbox.mjs:145`, and only then unlinks the original at
`scripts/_mailbox.mjs:146`. Two controllers draining the same inbox (which is
exactly what a wrong-session resume produces):

1. A reads message M. B reads message M.
2. A writes `archive/M` with reply "A's answer" and unlinks `inbox/M`.
3. B writes `archive/M` with reply "B's answer", overwriting A's, then calls
   `fs.unlinkSync` on a path that no longer exists, which throws ENOENT and is
   turned into a hard `fail` at `scripts/_mailbox.mjs:148`.

So the operator sees one reply where two were given, and the second replier
exits non-zero as if the archive had failed, when in fact it succeeded
destructively. The idempotence guard at `scripts/_mailbox.mjs:123` only helps
when the message is *already* archived before this process reads it; it does
nothing for the overlap window.

*Read versus write.* `cmdList` at `scripts/_mailbox.mjs:89` iterates the
directory and parses each `.json`. The temp files written by
`writeJsonAtomic` are named `<file>.tmp-<pid>-<now>` (`scripts/_mailbox.mjs:66`,
mirrored at `console/server.js:1152`) and land in the same directory, but the
`.json` suffix filter at `scripts/_mailbox.mjs:98` excludes them, so a
concurrent send cannot make `list` fail. That part is already correct.

**Blast radius.** Lost or duplicated operator instructions to a running
controller. This is the human-in-the-loop channel, so a lost `steer` is a run
that keeps going in the direction the operator just told it to abandon.

**Fix.**

* Make claiming a message atomic: `rename` the message out of `inbox/` into an
  `inbox/inflight/` (or straight to `archive/`) *first*, and only then read,
  reply and finalise. `rename` is atomic on the same filesystem, so exactly one
  of two racing readers gets the file and the other gets ENOENT and correctly
  treats it as already claimed.
* Treat ENOENT on the unlink at `scripts/_mailbox.mjs:146` as success, not as a
  failure, once the claim-by-rename above is in place.
* Create message files with `O_EXCL` rather than `rename`-over, so a filename
  collision on send is an error that retries with a new suffix instead of a
  silent overwrite. Widen the random suffix while there.

## 5. Git branch and worktree naming in scripts/wave-exec.js

**Shared resource.** The target repository: its refs, its `.git/worktrees`
registry, and the checked-out HEAD of its main worktree.

**What is already collision free.** The wave branch is
`liberta/<session-id>-wave<n>` (`scripts/wave-exec.js:314`) and the task branch
is that plus `-task-<task-id>` (`scripts/wave-exec.js:330`). Because the session
id is in the name, two *different* sessions can never name the same branch.
Worktree paths are equally safe: they live under the session's own run-store
directory (`scripts/wave-exec.js:319`, joined with the task id at
`scripts/wave-exec.js:329`). So the naming scheme itself is sound and needs no
change. The claim at `skills/liberta/SKILL.md:251` that per-task worktrees keep
concurrent producers off each other's edits holds *within* a session and holds
*across* sessions too.

**Where it still breaks.**

*Base branch resolution reads shared HEAD.* At `scripts/wave-exec.js:315`, if
`goal.md` has no `base_branch`, the base is `currentBranch(gitRoot)`, which is
`git rev-parse --abbrev-ref HEAD` in the main worktree
(`scripts/wave-exec.js:169`). Session B doing the SETUP checkout at
`skills/liberta/SKILL.md:124` (`git -C <root> checkout -b liberta/<session-id>
<base_branch>`, which mutates the shared main worktree's HEAD) between A's
`goal.md` read and A's `currentBranch` call makes A cut its wave branch from
B's session branch. A then builds on, verifies against and merges B's
unreviewed work, believing it started from the base.

*The SETUP checkout itself.* `skills/liberta/SKILL.md:124` checks out in the
repository root, not in a worktree. Two sessions setting up at once leave the
main worktree on whichever branch won, and any subsequent plain `git commit`
run there by either session lands on the other session's branch. This is the
single most damaging item on this page, because it moves commits between runs.

*Concurrent `git worktree add`.* `scripts/wave-exec.js:331` and
`scripts/wave-exec.js:543` both add worktrees to the same repository. Git locks
individual refs but two adds racing on the same repository can fail with a lock
error; `worktreeAdd` has no retry, so the whole generate pass aborts and the
wave is half-created. The `fs.existsSync` idempotence check at
`scripts/wave-exec.js:173` is not a lock: both processes can see "absent" and
both then run `worktree add` for the same path.

*Force-removal reaching a worktree that is not this process's.* Two places run
`git worktree remove --force`. The teardown at `scripts/wave-exec.js:185`,
driven by the summary loop at `scripts/wave-exec.js:617`, only ever targets
paths read back out of this session's own dispatch plan, so it cannot reach
another session's worktree. The merge helper is different: the merge worktree
path at `scripts/wave-exec.js:531` is built from `os.tmpdir()`, the repository's
basename and the wave branch name, so it is shared by every process on the
machine that computes the same triple, and `scripts/wave-exec.js:537`
force-removes whatever is sitting there before adding its own at
`scripts/wave-exec.js:543`. Since a conflicted merge is deliberately *left on
disk* at that path for a builder to reconcile (the `finally` at
`scripts/wave-exec.js:553` only cleans up when there is no conflict), a second
`--record` for the same wave branch destroys an in-progress conflict
resolution, including any uncommitted work the builder had done in it. Two
distinct sessions cannot collide here (the session id is in the wave branch
name), but two processes for the same session can, and that is reachable via
point 2. Note also that `os.tmpdir()` is world-visible on a shared machine.

*No prune anywhere.* Worth stating explicitly since it is a common failure
mode elsewhere: nothing in `scripts/`, `console/*.js`, `install.sh` or
`skills/` runs `git worktree prune`, `git gc` or `git clean`. There is
therefore no existing operation that garbage-collects another session's
worktree registration. Any prune added later must be filtered to this
session's own worktree paths, never run bare.

*Plan and wave-state read-modify-write.* Beyond git, `modeRecord` reads
`plan.json` at `scripts/wave-exec.js:280` and `scripts/wave-exec.js:428` and writes the whole thing back
at `scripts/wave-exec.js:502`, and reads wave-state at
`scripts/wave-exec.js:450` and rewrites it at `scripts/wave-exec.js:514`. Two
`--record` invocations for two different tasks of the *same* wave, which is the
normal parallel case, lose one task's result and one task's token spend by
exactly the interleaving in point 1. The `state.spend` accumulator at
`scripts/wave-exec.js:504` is a read-modify-write over a shared counter, so the
token budget check at `scripts/wave-exec.js:307` under-counts and the budget
guard fails open.

**Blast radius.** Commits landing on another run's branch, a wave branch cut
from the wrong base, half-created waves, destroyed conflict-resolution
worktrees, lost task results and an under-counted token budget.

**Fix.**

* Keep the branch and worktree naming exactly as it is; it is already
  session-scoped and needs no change.
* Never `checkout` in the shared main worktree. `skills/liberta/SKILL.md:124`
  becomes `git branch liberta/<session-id> <base_branch>` (which does not move
  HEAD) plus a session-owned worktree for anything that needs a working tree.
* Require `base_branch` to be resolved once, at SETUP, and recorded in
  `goal.md`/`project.json`. `scripts/wave-exec.js:315` must fail loudly rather
  than fall back to reading shared HEAD.
* Put the merge worktree under the session's own run-store directory instead of
  `os.tmpdir()`, and never force-remove a path that has a conflict in it: check
  `hasConflict` before the removal at `scripts/wave-exec.js:537`, not only in
  the `finally`.
* Wrap `git worktree add` in a bounded retry so a lock contention does not
  abort a whole wave.
* Serialise `plan.json` and `wave-state.json` updates under the per-session
  lock from point 3, re-reading inside the lock.

## 6. The console's fixed port 4177 and its single sqlite file

**Shared resource.** TCP port 4177 and `console/data/liberta.sqlite`.

**The code.** The port defaults to 4177 at `console/server.js:68` and is bound
at `console/server.js:1522`. The database file path is fixed relative to the
checkout at `console/db.js:39`. Boot order is schema, seed, sync loop, listen
(`console/server.js:1515` through `console/server.js:1522`).

**The losing interleavings.**

*Port.* The second console gets EADDRINUSE from `listen` at
`console/server.js:1522`. Because `main()` awaits schema creation and seeding
*before* listening, the second process has already opened the sqlite file and
run `ensureSchema`/`seedSkillsFromDisk` by the time it discovers the port is
taken, so a "failed" second console can still have mutated the shared database.
The failure then surfaces through the catch at `console/server.js:1527`.

*Schema creation.* `ensureSchema` at `console/db.js:57` is a sequence of
`hasTable` checks followed by `createTable` (for example
`console/db.js:99`). Two consoles booting together can both see "absent" and
both issue `CREATE TABLE`; the loser gets a "table already exists" error and
the process exits non-zero. The same shape applies to the additive
`hasColumn`/`alterTable` migration at `console/db.js:74`.

*Skill seeding.* `seedSkillsFromDisk` counts rows at `console/db.js:185`,
returns early if non-zero, and otherwise inserts at `console/db.js:227`. Two
consoles both read zero, both insert, and the second violates the unique
constraint on `skills.name` (`console/db.js:150`), so the second console dies
at boot with a constraint error rather than a clear message.

*Event duplication.* The ingest offset map at `console/sync.js:36` is
per-process and in memory. Two consoles sharing one sqlite file both start at
offset 0 and both insert the same events into the shared `events` table, which
has no unique constraint (`console/db.js:99` onward defines it with only an
autoincrement id). The dashboard then shows every event twice, permanently,
because nothing ever de-duplicates.

*Reaping and the active flag.* Both sync loops (started at
`console/server.js:1517`, running every three seconds by default at
`console/sync.js:356`) run `reapRuns` (`console/sync.js:344`) and
`markActiveRun` (`console/sync.js:350`) against the same rows. `markActiveRun`
clears `active` on every row (`console/sync.js:89`) then sets one
(`console/sync.js:91`); with two loops interleaving, a reader between the two
statements sees zero active runs, and the flag flaps.

*Sqlite writer contention.* sqlite3 allows one writer at a time. Two sync loops
writing every three seconds against `console/db.js:39` will produce
SQLITE_BUSY. The knex sqlite3 setup here sets no `busyTimeout` and no WAL
pragma, so contention surfaces as thrown errors, which the sync loop swallows
into a stderr warning (`console/sync.js:363`) and silently skips a pass.

**Blast radius.** A second console either refuses to start (best case, noisy)
or starts and permanently doubles the event history in the shared mirror. The
mirror is a cache, so nothing in the run store is lost, but the operator's view
of what happened becomes untrustworthy.

**Fix.**

* Bind before mutating: move `app.listen` ahead of `ensureSchema`/
  `seedSkillsFromDisk`/`startSyncLoop`, or take an exclusive lock on the data
  directory first, so a second console fails fast and touches nothing.
* Handle EADDRINUSE explicitly with a message naming the port and the likely
  cause, instead of a generic FATAL stack.
* Make the sqlite path a function of the port (or of an explicit
  `LIBERTA_CONSOLE_DB` env var) so a deliberately second console on another
  port gets its own mirror rather than fighting over one file.
* Give the events table a natural unique key (`run_id` plus byte offset, or a
  content hash) and insert with `onConflict().ignore()`, so re-ingest is
  idempotent and a second reader cannot duplicate history.
* Make `ensureSchema` and `seedSkillsFromDisk` tolerant: catch "already exists"
  and unique-violation errors and continue, rather than exiting.
* Set `busyTimeout` and enable WAL on the sqlite connection at
  `console/db.js:40` so brief writer overlap waits instead of throwing.
* Replace `markActiveRun`'s clear-then-set with a single statement derived from
  each run's own status, per point 2.

## 7. install.sh starting a second console

**Shared resource.** The console process, the port, and the shared install
targets under `~/.claude`.

**The code.** `install.sh:129` resolves the port (`PORT`, default 4177),
`install.sh:136` starts a detached `node server.js` with `nohup`, and
`install.sh:140` polls `GET /login` for up to five seconds.

**The losing interleaving.** The health check at `install.sh:140` only asks
whether *something* answers 200 on that URL. It does not check that the process
just started is the one answering:

1. Console A is already running on 4177.
2. The operator runs `./install.sh --start`.
3. Line 136 starts console B, which dies almost immediately with EADDRINUSE
   (after having already touched the shared sqlite file, see point 6).
4. Line 140 gets a 200 from console A and reports `console running` and prints
   the password banner.

The installer reports success for a console it did not start, and the operator
believes the freshly installed code is serving when it is not. The failure path
at `install.sh:156` already names "the port is already in use" as the likely
cause, but it is only reached when *nothing* answers, which is precisely the
case where this confusion does not arise.

**A second, independent collision.** `backup_if_exists` at `install.sh:31`
computes a backup suffix from `date +%Y%m%d%H%M%S` (`install.sh:35`) and then
`mv`s (`install.sh:37`). Two installers running within the same second produce
the same suffix, so the second `mv` overwrites the first's backup of
`~/.claude/skills/liberta` (`install.sh:81`) and of each agent file. Combined
with the unconditional `cp -r` that follows, two concurrent installs from
different checkouts can leave a half-A, half-B agent roster in `~/.claude`, with
only one recoverable backup.

**Blast radius.** An operator running against a stale console and not knowing
it, and a mixed-version skill/agent install that then drives every subsequent
run.

**Fix.**

* Before starting, probe the port and, if something already answers, either
  refuse with a clear message naming the existing process, or accept an explicit
  `--force`/`--port` to move out of the way.
* Prove ownership of the console that answers: have the started child print its
  pid, or expose a `/healthz` carrying pid and version, and match it against the
  child. The existing stdout contract at `console/server.js:1523` is already
  used this way by the screenshot helper and is the natural place to extend.
* Take an install lock (a directory created with `mkdir` under `~/.claude`) for
  the duration of the copy steps, so two installers cannot interleave.
* Add a per-run random suffix to the backup name at `install.sh:35`, or use
  `mktemp -d`, so backups can never overwrite each other.

## Design decisions this run adopts

The fix tasks that follow implement exactly these decisions. They are listed
per point so each can be verified independently.

1. **index.json.** Adopt a dependency-free advisory lock (an atomically created
   lock file carrying pid and timestamp, with a stale-lock timeout) held across
   read, mutate and write in `scripts/_log-event.mjs`. Re-read inside the lock.
   Keep tmp-plus-rename for the write. Failure to lock degrades to
   events.jsonl-only logging plus a non-zero exit, never to a blocked loop.
2. **active_session_id.** Demote it to a "last touched" selection hint.
   Liveness becomes plural and derived, from each `state.json`'s status plus a
   new heartbeat. `_status.mjs` with no id refuses to guess when more than one
   run is live. `markActiveRun` stops being a one-of-N flag. Resume requires an
   explicit `--resume`.
3. **state.json and events.jsonl.** One lock per session directory, covering
   every read-modify-write of `state.json` and `plan.json`. `_log-event.mjs`
   updates only `status`, re-read under the lock. events.jsonl stays exactly as
   it is: append-only, one `appendFileSync` per event, and that is now a
   documented invariant rather than an accident.
4. **Inbox.** Claim by `rename` before reading, so exactly one replier wins.
   ENOENT on the post-archive unlink becomes success. Message creation uses an
   exclusive create with a wider random suffix, so a name collision errors and
   retries instead of overwriting.
5. **Git.** Branch and worktree naming is kept unchanged; it is already
   session-scoped and collision free. SETUP stops checking out in the shared
   main worktree and uses `git branch` plus a session-owned worktree.
   `base_branch` must be explicit; the shared-HEAD fallback is removed. The
   merge worktree moves under the session's run-store directory and is never
   force-removed while it holds a conflict. `git worktree add` gets a bounded
   retry. No bare prune is ever added.
6. **Console.** Listen first, mutate second, with a clear EADDRINUSE message.
   The sqlite path becomes configurable and port-derived by default. The events
   table gains a natural unique key and idempotent insert. `ensureSchema` and
   the skill seed tolerate concurrent creation. sqlite gets WAL and a busy
   timeout.
7. **Installer.** Probe the port and prove the started child is the one
   answering before declaring success. Hold an install lock across the copy
   steps. Make backup suffixes unique.

The through-line: the run store stays file-based and human-readable, and the
fix is never "add a database". It is to make every existing read-modify-write
a real critical section, to stop pretending a one-slot global can describe two
runs, and to stop mutating shared git and process-level state (main-worktree
HEAD, a fixed port, a shared temp path) that was never scoped to a session in
the first place.
