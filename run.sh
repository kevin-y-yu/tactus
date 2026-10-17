#!/usr/bin/env bash
# Run Tactus. Usage: ./run.sh [start|test|backup]   (default: start)
# Env: PORT (default 3200), HOST, DB_PATH, AUTH_TOKEN (see README).
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "node not found. Install Node >= 22.13." >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || { echo "Node $(node -v) is too old. Need >= 22.13." >&2; exit 1; }

[ -d node_modules ] || npm ci

backup() {
  local db="${DB_PATH:-data/tactus.db}"
  [ -f "$db" ] || return 0
  mkdir -p data/backups
  local dest="data/backups/tactus-$(date +%Y%m%d-%H%M%S).db"
  cp "$db" "$dest" && echo "Backed up $db -> $dest"
}

case "${1:-start}" in
  start)  backup; echo "Open http://localhost:${PORT:-3200}"; exec npm start ;;
  test)   exec npm test ;;
  backup) backup ;;
  *)      echo "Usage: $0 [start|test|backup]" >&2; exit 2 ;;
esac
