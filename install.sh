#!/usr/bin/env bash
# Liberta installer, macOS and Linux.
#
# Installs the harness (controller skill + agent roster) into ~/.claude, and
# optionally sets up the console (npm install, run-store dir, a generated
# console login password). Safe to re-run: existing installed files are
# overwritten in place (staged and atomically swapped in), leaving no
# timestamped backup copy behind.
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
# install_dir_in_place: replace the directory at $2 with a copy of $1,
# exactly (no leftover files from a previous version), overwriting in place
# with no timestamped backup. Uses stage-then-swap so a copy that fails
# partway (disk full, permissions, interrupted) leaves the previous working
# install intact rather than nothing at all: the new tree is copied to a
# sibling staging path first and only moved into place once that copy is
# known-good, and the old tree is removed only after the swap succeeds.
install_dir_in_place() {
  local src="$1"
  local dst="$2"
  local dst_parent
  dst_parent="$(dirname "$dst")"
  mkdir -p "$dst_parent"
  local staging="${dst_parent}/.$(basename "$dst").incoming.$$"
  local old_aside="${dst_parent}/.$(basename "$dst").previous.$$"
  rm -rf "$staging" "$old_aside"

  # Stage the new copy first. If cp fails partway (disk full, permissions,
  # interrupted), the EXIT trap removes the incomplete staging dir and the
  # script aborts (set -e) with the original $dst left completely untouched.
  trap 'rm -rf "$staging"' EXIT
  cp -r "$src" "$staging"
  trap - EXIT

  # Staged copy is known-good. Swap it in: move the old tree aside, move the
  # staged tree into place, then remove the old one. There is no window in
  # which $dst is missing or partial -- it always points at either the
  # complete old tree or the complete new one.
  if [ -e "$dst" ]; then
    mv "$dst" "$old_aside"
  fi
  mv "$staging" "$dst"
  rm -rf "$old_aside"
}

# install_file_in_place: replace the regular file at $2 with a copy of $1,
# overwriting in place with no timestamped backup. Writes the new content to
# a temp file in the same directory (so the following rename is atomic) and
# renames it over the target, so a partial write never leaves the target
# missing or truncated.
install_file_in_place() {
  local src="$1"
  local dst="$2"
  local dst_dir
  dst_dir="$(dirname "$dst")"
  mkdir -p "$dst_dir"
  local tmp="${dst_dir}/.$(basename "$dst").incoming.$$"
  rm -f "$tmp"
  trap 'rm -f "$tmp"' EXIT
  cp "$src" "$tmp"
  trap - EXIT
  mv "$tmp" "$dst"
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
install_dir_in_place "$SCRIPT_DIR/skills/liberta" "$CLAUDE_DIR/skills/liberta"
echo "  installed -> $CLAUDE_DIR/skills/liberta"

# ---- 2. install the agent roster ----
echo "==> Installing agent roster"
mkdir -p "$CLAUDE_DIR/agents"
for f in "$SCRIPT_DIR"/agents/*.md; do
  name="$(basename "$f")"
  install_file_in_place "$f" "$CLAUDE_DIR/agents/$name"
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
CONSOLE_URL="http://localhost:${CONSOLE_PORT}"

if [ "$INSTALL_CONSOLE" -eq 1 ] && command -v node >/dev/null 2>&1; then
  if [ "$START_CONSOLE" -eq 1 ]; then
    LOG_FILE="/tmp/liberta-console-${CONSOLE_PORT}-$$.log"
    echo "==> Starting console (requested port ${CONSOLE_PORT})"
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
          if [ -n "${LIBERTA_CONSOLE_HOST:-}" ]; then
            # The operator explicitly restricted the bind to one address
            # family via LIBERTA_CONSOLE_HOST. Show the literal address we
            # just verified reachable (PROBE_HOST_URL, bracketed if IPv6)
            # instead of substituting the bare hostname "localhost": on a
            # machine whose resolver prefers the OTHER address family than
            # the one the operator restricted the bind to, a hardcoded
            # "localhost" URL would not actually reach this console even
            # though it is genuinely healthy. Leave the unset/default case
            # (server.js binds the wildcard 0.0.0.0, reachable via either
            # family) showing "localhost" as before.
            CONSOLE_URL="http://${PROBE_HOST_URL}:${BOUND_PORT}"
          else
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
      # running is the intended outcome: stand the reaper down.
      CONSOLE_HANDED_OFF=1
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
