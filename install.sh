#!/usr/bin/env bash
#
# Pigeonhole installer — macOS, Linux, WSL, anything with bash.
#
# There is nothing to build and nothing to install system-wide. This fetches
# the code, checks that Node is new enough, and starts the server.
#
#   ./install.sh                        install to ~/pigeonhole and run
#   ./install.sh --dir /opt/pigeonhole  install somewhere else
#   ./install.sh --root /srv/files      serve an existing directory
#   ./install.sh --no-start             install only
#
set -euo pipefail

REPO_URL="https://github.com/cventour/pigeonhole.git"
TARBALL_URL="https://github.com/cventour/pigeonhole/archive/refs/heads/main.tar.gz"
NODE_MIN=20

DIR="${PIGEONHOLE_DIR:-$HOME/pigeonhole}"
START=1

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '3,12p' "$0" | sed 's|^# \{0,1\}||'
  exit 0
}

# Every option that takes a value gets the same check, so a forgotten value
# reads as a sentence rather than as a shell error.
val() { [ -n "${2:-}" ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)      val "$@"; DIR="$2";                   shift 2 ;;
    --root)     val "$@"; export REPO_ROOT="$2";      shift 2 ;;
    --port)     val "$@"; export PORT="$2";           shift 2 ;;
    --host)     val "$@"; export HOST="$2";           shift 2 ;;
    --title)    val "$@"; export REPO_TITLE="$2";     shift 2 ;;
    --no-start) START=0;                              shift   ;;
    -h|--help)  usage ;;
    *)          die "unknown option: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- node check

step "Checking Node"
command -v node >/dev/null 2>&1 \
  || die "Node is not installed. Get it from https://nodejs.org (version $NODE_MIN or newer)."

major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$major" -ge "$NODE_MIN" ] \
  || die "Node $(node --version) is too old. Pigeonhole needs $NODE_MIN or newer."
say "Node $(node --version)"

# ----------------------------------------------------------------- get code

step "Fetching Pigeonhole into $DIR"

if [ -e "$DIR/server.js" ]; then
  if [ -d "$DIR/.git" ] && command -v git >/dev/null 2>&1; then
    git -C "$DIR" pull --ff-only --quiet && say "Updated the existing copy."
  else
    say "Already there — leaving it alone."
  fi
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and is not empty. Pick another path with --dir."
elif command -v git >/dev/null 2>&1; then
  git clone --depth 1 --quiet "$REPO_URL" "$DIR"
  say "Cloned."
else
  # No git. A tarball needs only curl and tar, which every box has.
  command -v curl >/dev/null 2>&1 || die "Needs either git or curl. Install one."
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$TARBALL_URL" | tar -xz -C "$tmp"
  mkdir -p "$DIR"
  cp -R "$tmp"/pigeonhole-*/. "$DIR"/
  say "Downloaded."
fi

[ -f "$DIR/server.js" ] || die "server.js is missing from $DIR. The download did not complete."

# --------------------------------------------------------------------- run

cd "$DIR"

if [ "$START" -eq 0 ]; then
  step "Installed"
  say "Start it whenever you like:"
  say ""
  say "  cd $DIR && node server.js"
  exit 0
fi

step "Starting"
say "Files:   ${REPO_ROOT:-$DIR/files}"
say "Address: http://${HOST:-127.0.0.1}:${PORT:-3001}"
say "Stop it with Ctrl-C. To start it again later:"
say ""
say "  cd $DIR && node server.js"
say ""

exec node server.js
