#!/usr/bin/env bash
# Rigorous test suite — run before every major change.
#
# Starts the API server (:3001) and a static file server (:8001),
# runs all test files, then tears them down.
#
# Usage:
#   tests/run-all.sh           # run everything
#   tests/run-all.sh api       # API + data integrity only (fast)
#   tests/run-all.sh ui        # UI flows only
#
set -u
MODE="${1:-all}"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LOG_DIR="${ROOT}/test-results"
mkdir -p "$LOG_DIR"

# ── Bring up servers if not already running ──
API_STARTED=0 STATIC_STARTED=0

if ! curl -s -o /dev/null http://localhost:3001/api/genres; then
  echo "==> Starting API server (:3001)"
  node server/local-server.js >"$LOG_DIR/api.log" 2>&1 &
  API_PID=$!
  API_STARTED=1
  # Wait up to 30s for it to come up
  for i in $(seq 1 30); do
    if curl -s -o /dev/null http://localhost:3001/api/genres; then break; fi
    sleep 1
  done
  if ! curl -s -o /dev/null http://localhost:3001/api/genres; then
    echo "API failed to start — see $LOG_DIR/api.log" >&2
    [ "$API_STARTED" -eq 1 ] && kill "$API_PID" 2>/dev/null
    exit 2
  fi
else
  echo "==> API already running on :3001"
fi

if [ "$MODE" != "api" ]; then
  if ! curl -s -o /dev/null http://localhost:8001/index.html; then
    echo "==> Starting static server (:8001)"
    (cd "$ROOT" && python3 -m http.server 8001 --bind 127.0.0.1) >"$LOG_DIR/static.log" 2>&1 &
    STATIC_PID=$!
    STATIC_STARTED=1
    for i in $(seq 1 10); do
      if curl -s -o /dev/null http://localhost:8001/index.html; then break; fi
      sleep 1
    done
  else
    echo "==> Static server already running on :8001"
  fi
fi

cleanup() {
  [ "$API_STARTED" -eq 1 ]    && kill "$API_PID"    2>/dev/null
  [ "$STATIC_STARTED" -eq 1 ] && kill "$STATIC_PID" 2>/dev/null
}
trap cleanup EXIT

# ── Run ──
FAIL=0

if [ "$MODE" = "all" ] || [ "$MODE" = "api" ]; then
  echo
  echo "================ data-integrity.test.cjs ================"
  node tests/data-integrity.test.cjs || FAIL=1
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "ui" ]; then
  echo
  echo "================ ui-flows.test.cjs ================"
  node tests/ui-flows.test.cjs || FAIL=1

  echo
  echo "================ playback.test.cjs ================"
  node tests/playback.test.cjs || FAIL=1

  echo
  echo "================ filters.test.cjs ================"
  node tests/filters.test.cjs || FAIL=1
fi

# Note: tests/safari-coldstart.test.cjs (real Safari via safaridriver) is opt-in
# — it needs macOS + Safari "Allow Remote Automation" and opens a real browser,
# so it is NOT run here. Run it directly: node tests/safari-coldstart.test.cjs

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "✗ one or more suites failed"
  exit 1
fi
echo
echo "✓ all suites passed"
