#!/bin/zsh -l
# Double-click this file in Finder to launch a ready-to-edit authoring session.
# The local server runs in the background; an existing browser sign-in is reused.

set -u
unsetopt BG_NICE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTHOR_URL="http://127.0.0.1:4173/author.html"
HEALTH_URL="http://127.0.0.1:4173/healthz"
RUNTIME_DIR="$SCRIPT_DIR/.codex-tmp"
LOG_FILE="$RUNTIME_DIR/quiz-authoring.log"

cd "$SCRIPT_DIR" || exit 1

if curl --fail --silent --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
  open "$AUTHOR_URL"
  exit 0
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is required to run the quiz authoring tool."
  echo "Install it from https://nodejs.org/, then double-click this file again."
  read "?Press Return to close this window. "
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing the local app dependencies (this only happens once)..."
  npm install || {
    echo ""
    echo "Could not install dependencies. Check your internet connection and try again."
    read "?Press Return to close this window. "
    exit 1
  }
fi

mkdir -p "$RUNTIME_DIR"

echo "Starting Quiz Authoring in the background..."
nohup npm run dev >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

for attempt in {1..30}; do
  if curl --fail --silent --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
    open "$AUTHOR_URL"
    echo ""
    echo "The authoring tool is open and ready to edit."
    echo "This window can close; the local server will keep running in the background."
    echo "Your authorized browser sign-in is reused. If this is the first launch, sign in once to enable publishing."
    exit 0
  fi
  sleep 1
done

echo ""
echo "The local server did not start. See the messages above for details."
kill "$SERVER_PID" 2>/dev/null || true
echo ""
tail -n 20 "$LOG_FILE" 2>/dev/null || true
read "?Press Return to close this window. "
exit 1
