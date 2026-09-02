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
CONSOLE_URL="http://localhost:${CONSOLE_PORT}"

if [ "$INSTALL_CONSOLE" -eq 1 ] && command -v node >/dev/null 2>&1; then
  if [ "$START_CONSOLE" -eq 1 ]; then
    LOG_FILE="/tmp/liberta-console.log"
    echo "==> Starting console on $CONSOLE_URL"
    ( cd "$SCRIPT_DIR/console" && PORT="$CONSOLE_PORT" nohup node server.js > "$LOG_FILE" 2>&1 & disown )

    up=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if curl -s -o /dev/null -w '%{http_code}' "$CONSOLE_URL/login" 2>/dev/null | grep -q '^200$'; then
        up=1
        break
      fi
      sleep 0.5
    done

    if [ "$up" -eq 1 ]; then
      echo "  console running: $CONSOLE_URL"
      if [ -n "${LIBERTA_CONSOLE_PASSWORD:-}" ]; then
        echo "  password:        (from LIBERTA_CONSOLE_PASSWORD, not shown here)"
      else
        echo "  password:        libert@123! (default, set LIBERTA_CONSOLE_PASSWORD yourself for anything durable)"
        echo "  WARNING: using the insecure default password. Set LIBERTA_CONSOLE_PASSWORD before starting for anything durable."
      fi
    else
      echo "error: console did not start (no response from $CONSOLE_URL after several seconds)." >&2
      echo "  Likely cause: the port is already in use, or the console process failed to start/crashed." >&2
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
