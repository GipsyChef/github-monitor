#!/usr/bin/env bash
# GitHub Monitor — startup script
# Verifies prerequisites, then launches the server and opens the dashboard.

set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-4177}"
URL="http://localhost:${PORT}"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }

bold "GitHub Operations Bureau"
dim  "Port ${PORT} · ${URL}"
echo

# 1. node >= 22
if ! command -v node >/dev/null 2>&1; then
  red "✗ node is not installed. Install Node.js 22+ (e.g. \`brew install node\`)."
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "${NODE_MAJOR}" -lt 22 ]; then
  red "✗ node ${NODE_MAJOR} found — this project needs node 22 or newer."
  exit 1
fi
green "✓ node $(node -v)"

# 2. gh CLI (used by server.js for the GitHub token)
if ! command -v gh >/dev/null 2>&1; then
  red "✗ gh CLI not found. Install it: \`brew install gh\` then \`gh auth login\`."
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  red "✗ gh is not authenticated. Run: gh auth login"
  exit 1
fi
green "✓ gh authenticated"

# 3. Port in use?
if lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  red "✗ Port ${PORT} is already in use."
  dim  "  Set a different port:  PORT=4188 ./start.sh"
  exit 1
fi

echo
bold "Starting server…"
dim  "(Ctrl-C to stop)"

# 4. Open browser shortly after the server boots
(
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.4
    if curl -fsS -o /dev/null "${URL}" 2>/dev/null; then
      if command -v open >/dev/null 2>&1; then
        open "${URL}"
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "${URL}" >/dev/null 2>&1 || true
      fi
      break
    fi
  done
) &

PORT="${PORT}" exec node server.js
