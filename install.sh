#!/usr/bin/env bash
# Liberta installer, macOS and Linux.
#
# Installs the harness (controller skill + agent roster) into ~/.claude, and
# optionally sets up the console (npm install, run-store dir, a generated
# console login password). Safe to re-run: existing installed files are
# backed up with a .bak-<timestamp> suffix before being overwritten.
set -euo pipefail

# ---- locate ourselves regardless of cwd ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
RUN_STORE_DIR="$HOME/.claude/liberta-runs"

os="$(uname -s)"
case "$os" in
  Darwin) platform="macOS" ;;
  Linux)  platform="Linux" ;;
  *)
    echo "error: unsupported platform '$os' (this installer supports macOS and Linux only)" >&2
    exit 1
    ;;
esac

echo "Liberta installer ($platform)"
echo "  source:      $SCRIPT_DIR"
echo "  claude dir:  $CLAUDE_DIR"
echo

# ---- helpers ----
backup_if_exists() {
  local target="$1"
  if [ -e "$target" ]; then
    local ts
    ts="$(date +%Y%m%d%H%M%S)"
    echo "  existing $target found -> backing up to ${target}.bak-${ts}"
    mv "$target" "${target}.bak-${ts}"
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command '$1' not found on PATH" >&2
    exit 1
  fi
}

# ---- flags ----
INSTALL_CONSOLE=1
START_CONSOLE=0
for arg in "$@"; do
  case "$arg" in
    --no-console) INSTALL_CONSOLE=0 ;;
    --start)      START_CONSOLE=1 ;;
    --help|-h)
      cat <<EOF
Usage: ./install.sh [--no-console] [--start]

  --no-console   Only install the harness (skill + agents) into ~/.claude;
                 skip setting up the console app.
  --start        After installing, also start the console (node server.js),
                 waiting for it to answer before reporting success.

Env overrides:
  CLAUDE_DIR              Where to install the skill/agents (default: ~/.claude)
  PORT                    Console port (default: 4177)
  LIBERTA_CONSOLE_PASSWORD  Console login password (default: insecure built-in default)
EOF
      exit 0
      ;;
    *)
      echo "warning: unrecognized argument '$arg' (ignored)" >&2
      ;;
  esac
done

# ---- 1. install the controller skill ----
echo "==> Installing controller skill"
require_cmd cp
mkdir -p "$CLAUDE_DIR/skills"
backup_if_exists "$CLAUDE_DIR/skills/liberta"
cp -r "$SCRIPT_DIR/skills/liberta" "$CLAUDE_DIR/skills/liberta"
echo "  installed -> $CLAUDE_DIR/skills/liberta"

# ---- 2. install the agent roster ----
echo "==> Installing agent roster"
mkdir -p "$CLAUDE_DIR/agents"
for f in "$SCRIPT_DIR"/agents/*.md; do
  name="$(basename "$f")"
  backup_if_exists "$CLAUDE_DIR/agents/$name"
  cp "$f" "$CLAUDE_DIR/agents/$name"
done
echo "  installed $(ls "$SCRIPT_DIR"/agents/*.md | wc -l | tr -d ' ') agent(s) -> $CLAUDE_DIR/agents/"

# ---- 3. session-store scripts + run-store dir ----
echo "==> Preparing session store"
mkdir -p "$RUN_STORE_DIR"
chmod +x "$SCRIPT_DIR"/scripts/*.mjs "$SCRIPT_DIR"/scripts/*.js 2>/dev/null || true
echo "  run store -> $RUN_STORE_DIR"
echo "  helper scripts remain in place at $SCRIPT_DIR/scripts (referenced by the installed skill)"

# ---- 4. console (optional) ----
if [ "$INSTALL_CONSOLE" -eq 1 ]; then
  echo "==> Setting up console"
  if ! command -v node >/dev/null 2>&1; then
    echo "  node not found on PATH, skipping console setup."
    echo "  Install Node.js (18+) and re-run with no flags, or run this script with --no-console"
    echo "  next time to silence this message."
  else
    node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
    if [ "$node_major" -lt 18 ]; then
      echo "  warning: Node $node_major found, Liberta's console expects Node 18+ (for global fetch)." >&2
    fi
    require_cmd npm
    ( cd "$SCRIPT_DIR/console" && npm install --no-fund --no-audit )
    echo "  console dependencies installed"
  fi
else
  echo "==> Skipping console setup (--no-console)"
fi

echo
echo "Done."
echo
echo "Use the harness from any Claude Code session:"
echo "  /liberta \"<goal>\" --project <path-to-a-project>"
echo

CONSOLE_PORT="${PORT:-4177}"
if [ -n "${LIBERTA_CONSOLE_HOST:-}" ]; then
  # The operator explicitly restricted the bind address via
  # LIBERTA_CONSOLE_HOST. It carries into the "npm start" command these
  # manual instructions themselves tell the operator to run next, in the
  # same shell, so the console really will bind only to that address
  # family. Echo the operator's own chosen host back instead of a
  # hardcoded "localhost", which is only reachable by coincidence of the
  # resolver's address-family preference (the same class of bug T36 fixed
  # for the --start success message). Bracket it if it is an IPv6 literal,
  # same detection as PROBE_HOST_URL below: a colon present and not
  # already bracketed.
  case "$LIBERTA_CONSOLE_HOST" in
    *:*)
      case "$LIBERTA_CONSOLE_HOST" in
        \[*\]) CONSOLE_HOST_URL="$LIBERTA_CONSOLE_HOST" ;;
        *) CONSOLE_HOST_URL="[${LIBERTA_CONSOLE_HOST}]" ;;
      esac
      ;;
    *)
      CONSOLE_HOST_URL="$LIBERTA_CONSOLE_HOST"
      ;;
  esac
  CONSOLE_URL="http://${CONSOLE_HOST_URL}:${CONSOLE_PORT}"
else
  CONSOLE_URL="http://localhost:${CONSOLE_PORT}"
fi

if [ "$INSTALL_CONSOLE" -eq 1 ] && command -v node >/dev/null 2>&1; then
  if [ "$START_CONSOLE" -eq 1 ]; then
    LOG_FILE="/tmp/liberta-console-${CONSOLE_PORT}-$$.log"
    echo "==> Starting console (requested port ${CONSOLE_PORT})"

    # ---- takeover ----
    # `--start` unconditionally takes over the requested port: if a liberta
    # console (and ONLY a liberta console) already owns it, kill that process
    # by exact pid and start ours in its place, rather than refusing. Any
    # other occupant (a process that is not `node`, or a node process whose
    # argv does not end in "console/server.js") is never touched -- report it
    # and exit non-zero exactly as before this change.
    #
    # PORT=0 means "let the OS pick a free port" (server.js explicitly
    # supports this for test harnesses): there is nothing meaningful to take
    # over, since the requested "port" is not a real, occupiable port number.
    if [ "$CONSOLE_PORT" != "0" ] && command -v lsof >/dev/null 2>&1; then
      # Enumerate every pid holding a LISTEN socket on this port number,
      # across BOTH address families -- `lsof -iTCP:<port>` (no host in the
      # spec) is not scoped to 127.0.0.1/0.0.0.0/::, so it will not miss a
      # wildcard bind the way a host-scoped query would, and it will not
      # silently ignore an IPv6-only listener either. Each candidate is then
      # identity-checked individually below before anything is killed; this
      # enumeration step never itself decides who to kill.
      TAKEOVER_CANDIDATES="$(lsof -nP -iTCP:"$CONSOLE_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
      if [ -n "$TAKEOVER_CANDIDATES" ]; then
        TAKEOVER_PIDS=""
        for cand_pid in $TAKEOVER_CANDIDATES; do
          cand_args="$(ps -o args= -p "$cand_pid" 2>/dev/null || true)"
          if [ -z "$cand_args" ]; then
            # Already gone by the time we asked; nothing to identify or kill.
            continue
          fi
          cand_exe="${cand_args%% *}"
          cand_last="${cand_args##* }"
          cand_is_console=0
          if [ "$(basename "$cand_exe")" = "node" ]; then
            case "$cand_last" in
              */console/server.js) cand_is_console=1 ;;
            esac
          fi
          if [ "$cand_is_console" -ne 1 ]; then
            echo "error: port ${CONSOLE_PORT} is already in use by a process that is not a liberta console (pid ${cand_pid}: ${cand_args})" >&2
            echo "  refusing to kill it. Free the port yourself, or run with a different PORT." >&2
            exit 1
          fi
          TAKEOVER_PIDS="$TAKEOVER_PIDS $cand_pid"
        done
        if [ -n "$TAKEOVER_PIDS" ]; then
          echo "==> Port ${CONSOLE_PORT} is held by an existing liberta console; taking it over"
          for tpid in $TAKEOVER_PIDS; do
            echo "  stopping pid ${tpid}"
            kill "$tpid" 2>/dev/null || true
          done
          for tpid in $TAKEOVER_PIDS; do
            for _ in 1 2 3 4 5 6 7 8 9 10; do
              kill -0 "$tpid" 2>/dev/null || break
              sleep 0.3
            done
            if kill -0 "$tpid" 2>/dev/null; then
              kill -9 "$tpid" 2>/dev/null || true
              for _ in 1 2 3 4 5; do
                kill -0 "$tpid" 2>/dev/null || break
                sleep 0.2
              done
            fi
          done
        fi
      fi
    fi

    # Invoke node with a path that contains "console/server.js" (rather than
    # cd-ing into console/ and running the bare filename "server.js") so the
    # resulting process argv is discoverable via `pgrep -f console/server.js`.
    # That is the pattern the rest of this harness relies on for safe,
    # exact-pid cleanup instead of broader/riskier kill patterns.
    #
    # Use `exec` inside the backgrounded subshell so the shell process that
    # bash's $! refers to is replaced in-place by (eventually) node itself,
    # rather than node being forked as a *grandchild* of an intermediate
    # wrapper shell. Without `exec` here, $! captures the wrapper's pid, not
    # node's pid, and the liveness checks below would be comparing against
    # the wrong process.
    # Kill the process we spawned (if it's still alive) and wait briefly for
    # it to actually exit. Called on every failure/timeout path below so we
    # never leave an orphaned console process behind, even when the port we
    # were told to use (e.g. PORT=0) is not the one we ended up health
    # checking correctly.
    kill_spawned_console() {
      if [ -z "${SPAWNED_PID:-}" ]; then
        return
      fi
      if ! kill -0 "$SPAWNED_PID" 2>/dev/null; then
        return
      fi
      kill "$SPAWNED_PID" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$SPAWNED_PID" 2>/dev/null || return
        sleep 0.3
      done
      kill -9 "$SPAWNED_PID" 2>/dev/null || true
    }

    # Reap whatever we are about to spawn on ANY exit path that is not a
    # confirmed, reported success: the health-check timeout, a port owned by
    # a different process, an unexpected `set -e` abort between here and the
    # report, and SIGINT/SIGTERM/SIGHUP while we are still waiting. Without
    # this, a console that comes up healthy on an address our localhost
    # health check cannot reach (say LIBERTA_CONSOLE_HOST=127.0.0.2) would
    # survive install.sh's non-zero exit, reparent to init and run forever.
    # CONSOLE_HANDED_OFF flips to 1 only after we have printed "console
    # running", i.e. only when leaving the process alive is the documented,
    # intended outcome and its pid has been handed to the operator.
    CONSOLE_HANDED_OFF=0
    reap_console_unless_handed_off() {
      if [ "${CONSOLE_HANDED_OFF:-0}" -eq 1 ]; then
        return 0
      fi
      kill_spawned_console || true
      return 0
    }

    ( cd "$SCRIPT_DIR/console" && exec env PORT="$CONSOLE_PORT" nohup node "$SCRIPT_DIR/console/server.js" ) > "$LOG_FILE" 2>&1 &
    SPAWNED_PID=$!
    disown
    trap 'reap_console_unless_handed_off' EXIT
    trap 'reap_console_unless_handed_off; trap - INT; kill -INT $$' INT
    trap 'reap_console_unless_handed_off; exit 143' TERM
    trap 'reap_console_unless_handed_off; exit 129' HUP

    # The traps above cannot cover every exit path. Two gaps remain, and
    # neither can be closed by adding more `trap ... SIGNAL` lines:
    #
    # 1. When install.sh itself is launched as a backgrounded command of a
    #    non-interactive shell (`./install.sh --start &`, the exact pattern
    #    used by CI jobs, supervisors, and this chunk's own verify scripts),
    #    POSIX/bash force SIGINT (and SIGQUIT) to SIG_IGN for that
    #    asynchronous list element. A signal that is ignored on entry to a
    #    shell "cannot be trapped or reset" (bash(1)), so the `trap ... INT`
    #    above is silently a no-op there: Ctrl-C-style interruption does
    #    nothing, and install.sh (and the console it spawned) keep running.
    # 2. SIGKILL can never be trapped, at all -- including by the natural
    #    next step a supervisor takes when a SIGINT it sent for (1) appears
    #    to have no effect and it escalates to a forceful kill.
    #
    # Both cases end the same way: this process disappears without running
    # a single line of its own shell code, so no `trap` body can reap the
    # console it spawned. The only mechanism the kernel itself guarantees
    # here is file descriptor teardown on process death, so use that: hold
    # a read-write handle on a FIFO open for as long as this process is
    # alive (fd 9). A watchdog subprocess, forked now and independent of
    # this one from that point on, blocks reading that FIFO. However this
    # process ends -- clean exit, SIGTERM, SIGKILL, anything -- the kernel
    # closes fd 9 as part of process teardown, the FIFO's last writer goes
    # away, and the watchdog's read returns. If nothing was written first
    # (i.e. we never reached the "console running" hand-off below), the
    # watchdog reaps the console itself; if we did hand off, we write a
    # marker byte first and the watchdog leaves the console alone.
    #
    # This whole watchdog is best-effort, not a hard requirement for
    # console startup: on some platforms `mktemp -u` still probes
    # creatability via mkstemp() under the hood, so it fails (and, under
    # `set -e`, would otherwise abort the entire script) when TMPDIR is
    # unwritable, read-only, or quota-exhausted -- a plausible condition in
    # exactly the hardened CI/supervisor environments this chunk targets.
    # Guard it explicitly so that failure just skips the watchdog instead
    # of taking down the console launch with it.
    WATCHDOG_FIFO=""
    WATCHDOG_ACTIVE=0
    WATCHDOG_FIFO="$(mktemp -u "${TMPDIR:-/tmp}/liberta-console-watchdog-XXXXXX" 2>/dev/null)" || WATCHDOG_FIFO=""
    if [ -n "$WATCHDOG_FIFO" ] && mkfifo "$WATCHDOG_FIFO" 2>/dev/null; then
      exec 9<>"$WATCHDOG_FIFO"
      WATCHDOG_ACTIVE=1
      (
        # Drop this subshell's own inherited copy of the write end first:
        # otherwise this process (not just the parent) would hold fd 9
        # open, and the read below would block forever since a writer
        # would always still be around.
        exec 9<&- 2>/dev/null || true
        HANDOFF_MSG=""
        IFS= read -r HANDOFF_MSG < "$WATCHDOG_FIFO" 2>/dev/null || true
        rm -f "$WATCHDOG_FIFO" 2>/dev/null || true
        if [ "$HANDOFF_MSG" != "handed-off" ]; then
          kill -9 "$SPAWNED_PID" 2>/dev/null || true
        fi
      ) &
      disown
    fi

    # We cannot trust CONSOLE_PORT for the health check: PORT=0 (explicitly
    # supported by server.js for test harnesses) makes the OS assign a real
    # port, so a literal `http://localhost:0` health check can never succeed.
    # Resolve the REAL bound port from the console's own startup log line
    # ("liberta-console listening on http://localhost:<port>"), falling back
    # to asking lsof what the spawned pid is listening on. Never health-check
    # port 0.
    #
    # The health probe must never use the bare hostname "localhost":
    # getaddrinfo("localhost") can resolve to ::1 before 127.0.0.1 (or vice
    # versa) depending on the machine's resolver config, independent of
    # which address family the console actually bound. If some unrelated
    # process happens to be listening on the SAME numeric port but the OTHER
    # address family, "localhost" can silently resolve to that other
    # listener, so curl reaches it instead of our console, gets a non-200
    # response, and this loop times out believing a genuinely healthy
    # console never started -- which then gets killed below. Probe the
    # literal address we told the console to bind to instead: whatever the
    # operator set via LIBERTA_CONSOLE_HOST, else 127.0.0.1 (server.js's own
    # default bind is the wildcard 0.0.0.0, which is always reachable via
    # 127.0.0.1). This does not change CONSOLE_URL, the address shown to the
    # operator on success.
    PROBE_HOST="${LIBERTA_CONSOLE_HOST:-127.0.0.1}"
    # A bare IPv6 literal (e.g. "::1") is not a valid host component of a
    # URL on its own -- it must be bracketed ("[::1]"), otherwise
    # "http://::1:PORT/login" is malformed and curl returns http_code 000 on
    # every poll, which would misreport a genuinely healthy IPv6-bound
    # console as failed to start and then kill it. Detect this by the
    # presence of a colon (an IPv4 literal or DNS hostname never contains
    # one) and by the absence of an already-present bracket.
    case "$PROBE_HOST" in
      *:*)
        case "$PROBE_HOST" in
          \[*\]) PROBE_HOST_URL="$PROBE_HOST" ;;
          *) PROBE_HOST_URL="[${PROBE_HOST}]" ;;
        esac
        ;;
      *)
        PROBE_HOST_URL="$PROBE_HOST"
        ;;
    esac
    # When the operator restricted the bind with LIBERTA_CONSOLE_HOST, the
    # friendly "localhost" URL is only worth advertising if "localhost" really
    # reaches THIS console and nothing else. Decide that from evidence rather
    # than from a guess in either direction: resolve every address localhost
    # maps to on this machine and try a TCP connect to each on the bound port.
    # Answer yes only when exactly one of them accepts a connection and it is
    # the address we just health-checked. That rules out both failure modes:
    # printing "localhost" when the resolver prefers an address family the
    # console never bound (operator is handed a URL that does not work), and
    # printing "localhost" when some unrelated process holds the same port on
    # the other address family (operator is silently pointed at someone else).
    # Any error, ambiguity or missing answer exits non-zero, so the caller
    # falls back to the literal verified address, which is always correct.
    localhost_reaches_only_our_console() {
      local addr="$1"
      local port="$2"
      node -e '
const dns = require("dns");
const net = require("net");
const want = process.argv[1];
const port = Number(process.argv[2]);
dns.lookup("localhost", { all: true }, (err, addrs) => {
  if (err || !addrs || addrs.length === 0) { process.exit(1); }
  let pending = addrs.length;
  const accepting = new Set();
  for (const a of addrs) {
    const sock = net.connect({ host: a.address, port: port, family: a.family });
    sock.setTimeout(1000);
    const settle = (ok) => {
      if (settle.done) { return; }
      settle.done = true;
      if (ok) { accepting.add(a.address); }
      sock.destroy();
      pending -= 1;
      if (pending === 0) {
        process.exit(accepting.size === 1 && accepting.has(want) ? 0 : 1);
      }
    };
    sock.once("connect", () => settle(true));
    sock.once("error", () => settle(false));
    sock.once("timeout", () => settle(false));
  }
});
' "$addr" "$port" >/dev/null 2>&1
    }

    up=0
    BOUND_PORT=""
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      if [ -n "$SPAWNED_PID" ] && ! kill -0 "$SPAWNED_PID" 2>/dev/null; then
        # The process we spawned has already exited (e.g. crashed with
        # EADDRINUSE). No amount of curl success from some other process
        # already bound to the port counts as our console starting.
        break
      fi
      if [ -z "$BOUND_PORT" ]; then
        BOUND_PORT="$(grep -oE 'listening on http://localhost:[0-9]+' "$LOG_FILE" 2>/dev/null | tail -n1 | grep -oE '[0-9]+$' || true)"
        if [ -z "$BOUND_PORT" ] && command -v lsof >/dev/null 2>&1; then
          BOUND_PORT="$(lsof -nP -p "$SPAWNED_PID" -a -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR==1 { n=split($9, a, ":"); print a[n] }' || true)"
        fi
      fi
      if [ -n "$BOUND_PORT" ]; then
        CANDIDATE_URL="http://${PROBE_HOST_URL}:${BOUND_PORT}"
        if curl -s -o /dev/null -w '%{http_code}' "$CANDIDATE_URL/login" 2>/dev/null | grep -q '^200$'; then
          up=1
          if [ -n "${LIBERTA_CONSOLE_HOST:-}" ] \
             && ! localhost_reaches_only_our_console "$PROBE_HOST" "$BOUND_PORT"; then
            # The operator explicitly restricted the bind to one address
            # family via LIBERTA_CONSOLE_HOST, and "localhost" on this machine
            # does not demonstrably land on that same address (it resolves
            # elsewhere first, or something else answers there too). Show the
            # literal address we just verified reachable (PROBE_HOST_URL,
            # bracketed if IPv6) rather than a "localhost" URL that would not
            # actually reach this console even though it is genuinely healthy.
            CONSOLE_URL="http://${PROBE_HOST_URL}:${BOUND_PORT}"
          else
            # Either the bind was left at server.js's wildcard default
            # (0.0.0.0, reachable via localhost by construction), or localhost
            # was just proven to reach this very console and nothing else. Show
            # the documented, friendlier localhost URL.
            CONSOLE_URL="http://localhost:${BOUND_PORT}"
          fi
          CONSOLE_PORT="$BOUND_PORT"
          break
        fi
      fi
      sleep 0.5
    done

    # Even if curl succeeded, confirm it was actually our spawned process
    # that ended up bound to the port (not a pre-existing/other process that
    # happens to answer /login with 200). Scope this check by PID, not by
    # address/port: server.js's default bind is the wildcard 0.0.0.0, which
    # lsof reports as "*:PORT", not "127.0.0.1:PORT" -- a host-scoped lsof
    # query would find nothing for that default and, if it then fell back to
    # an unscoped `lsof -tiTCP:PORT`, could match a *different* process
    # listening on the same port number on another address family (e.g. an
    # IPv6-only listener) and wrongly conclude our console never started,
    # killing a healthy process. Asking whether SPAWNED_PID itself holds a
    # LISTEN socket on this port is address-family agnostic and can never
    # match a process we did not spawn, so there is no unscoped fallback.
    if [ "$up" -eq 1 ] && [ -n "$SPAWNED_PID" ]; then
      if ! kill -0 "$SPAWNED_PID" 2>/dev/null; then
        up=0
      elif command -v lsof >/dev/null 2>&1; then
        LISTEN_PID="$(lsof -nP -p "$SPAWNED_PID" -a -iTCP:"$CONSOLE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true)"
        if [ -z "$LISTEN_PID" ]; then
          up=0
        fi
      fi
    fi

    if [ "$up" -eq 1 ]; then
      # The console answered and we confirmed we own the port, so leaving it
      # running is the intended outcome: stand the reaper down, and tell the
      # FIFO watchdog (see above) not to reap it either once we exit.
      CONSOLE_HANDED_OFF=1
      if [ "$WATCHDOG_ACTIVE" -eq 1 ]; then
        printf 'handed-off\n' >&9 2>/dev/null || true
      fi
      echo "  console running: $CONSOLE_URL"
      echo "  pid:             $SPAWNED_PID"
      if [ -n "${LIBERTA_CONSOLE_PASSWORD:-}" ]; then
        echo "  password:        (from LIBERTA_CONSOLE_PASSWORD, not shown here)"
      else
        echo "  password:        libert@123! (default, set LIBERTA_CONSOLE_PASSWORD yourself for anything durable)"
        echo "  WARNING: using the insecure default password. Set LIBERTA_CONSOLE_PASSWORD before starting for anything durable."
      fi
    else
      # Never leave the process we spawned running past a reported failure,
      # regardless of which check above failed (timeout, wrong owner, crash).
      # `|| true`: kill_spawned_console's own return status reflects whatever
      # its last internal check happened to be (e.g. non-zero when the
      # process had already exited on its own), and under `set -e` a bare
      # non-zero statement here would abort the script before it ever prints
      # the error message below.
      kill_spawned_console || true
      echo "error: console did not start (no response after several seconds, or the port is already owned by a different, pre-existing process)." >&2
      echo "  Likely cause: the port is already in use by another process, or the console process failed to start/crashed." >&2
      echo "  --- tail of $LOG_FILE ---" >&2
      tail -n 20 "$LOG_FILE" >&2 2>/dev/null || echo "  (log file not found)" >&2
      exit 1
    fi
  else
    echo "To run the console:"
    echo "  cd $SCRIPT_DIR/console"
    echo "  LIBERTA_CONSOLE_PASSWORD='pick something' npm start"
    echo "  # -> $CONSOLE_URL"
    if [ -n "${LIBERTA_CONSOLE_PASSWORD:-}" ]; then
      echo "  (LIBERTA_CONSOLE_PASSWORD is currently set in this shell, so that value will be used)"
    else
      echo "  (LIBERTA_CONSOLE_PASSWORD is not set: the console will fall back to the insecure default password libert@123!)"
      echo "  WARNING: set LIBERTA_CONSOLE_PASSWORD before starting for anything durable."
    fi
  fi
fi
