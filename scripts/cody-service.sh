#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="${CODY_RUNTIME_DIR:-$PROJECT_DIR/.cody-runtime}"
ENV_FILE="$RUNTIME_DIR/service.env"
mkdir -p "$RUNTIME_DIR"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
PID_FILE="$RUNTIME_DIR/server.pid"
LOG_FILE="${CODY_LOG_FILE:-$RUNTIME_DIR/server.log}"
HOST="${CODY_HOST:-127.0.0.1}"
PORT="${CODY_PORT:-3000}"
PASSWORD="${CODY_PASSWORD:-}"

# Non-interactive SSH/deployment shells commonly skip the user's login shell
# startup files. That can silently drop the proxy environment required by the
# Codex app-server even though interactive `codex` and `curl` calls work. Import
# only proxy-related variables from the configured login shell, preserving any
# values explicitly supplied to this service command.
load_login_proxy_env() {
  [[ "${CODY_IMPORT_LOGIN_PROXY_ENV:-1}" != "0" ]] || return 0
  local login_shell="${SHELL:-}"
  [[ -n "$login_shell" && -x "$login_shell" ]] || return 0
  local line name value
  while IFS= read -r line; do
    [[ "$line" == *=* ]] || continue
    name="${line%%=*}"
    value="${line#*=}"
    case "$name" in
      HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)
        [[ -n "${!name:-}" ]] || { printf -v "$name" '%s' "$value"; export "$name"; }
        ;;
    esac
  done < <("$login_shell" -lic 'env' 2>/dev/null)
}

read_pid() { [[ -f "$PID_FILE" ]] || return 1; local pid; pid="$(tr -dc '0-9' < "$PID_FILE")"; [[ -n "$pid" ]] || return 1; printf '%s' "$pid"; }
process_cwd() {
  local pid="$1" cwd=""
  if [[ -L "/proc/$pid/cwd" ]]; then
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  fi
  printf '%s' "$cwd"
}
is_our_process() {
  local command cwd
  kill -0 "$1" 2>/dev/null || return 1
  command="$(ps -p "$1" -o command= 2>/dev/null || true)"
  [[ "$command" == *"node"* && "$command" == *"dist-cli/index.js"* ]] || return 1
  [[ "$command" == *"$PROJECT_DIR/dist-cli/index.js"* ]] && return 0
  cwd="$(process_cwd "$1")"
  [[ "$cwd" == "$PROJECT_DIR" ]]
}
find_our_pids() {
  local pid known=""
  if pid="$(read_pid 2>/dev/null)" && is_our_process "$pid"; then known="$pid"; printf '%s\n' "$pid"; fi
  # Some launches use a relative `dist-cli/index.js` path. Verify both the
  # executable command and the process working directory instead of assuming
  # an absolute command line; otherwise a stale server can keep the port and
  # make a deployment health check hit the wrong build.
  ps -axo pid=,command= | awk '$0 ~ /node/ && $0 ~ /dist-cli\/index\.js/ { print $1 }' | while read -r pid; do
    [[ -n "$pid" && "$pid" != "$known" ]] && is_our_process "$pid" && printf '%s\n' "$pid"
  done || true
  return 0
}

stop_service() {
  local pid pids
  pids="$(find_our_pids)"
  if [[ -z "$pids" ]]; then echo "CodyWeb is not running."; rm -f "$PID_FILE"; return 0; fi
  for pid in $pids; do echo "Stopping CodyWeb (PID $pid)..."; kill -TERM "$pid" 2>/dev/null || true; done
  for _ in {1..50}; do
    local remaining=false
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && remaining=true; done
    [[ "$remaining" == false ]] && break
    sleep 0.1
  done
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then echo "Process $pid did not stop gracefully; sending SIGKILL."; kill -KILL "$pid"; fi
  done
  rm -f "$PID_FILE"
}

start_service() {
  local pid pids args
  pids="$(find_our_pids)"
  if [[ -n "$pids" ]]; then echo "CodyWeb is already running (PID(s) ${pids//$'\n'/,})."; return 0; fi
  load_login_proxy_env
  rm -f "$PID_FILE"; args=("$PROJECT_DIR/dist-cli/index.js" --host "$HOST" --port "$PORT")
  if [[ -n "$PASSWORD" ]]; then args+=(--password "$PASSWORD")
  elif [[ "$HOST" == "127.0.0.1" || "$HOST" == "localhost" || "$HOST" == "::1" ]]; then args+=(--no-password)
  else echo "CODY_PASSWORD is required when CODY_HOST is not loopback." >&2; return 1; fi
  echo "Starting CodyWeb on $HOST:$PORT..."; nohup setsid node "${args[@]}" >> "$LOG_FILE" 2>&1 < /dev/null & pid=$!; printf '%s\n' "$pid" > "$PID_FILE"
  for _ in {1..50}; do
    if ! kill -0 "$pid" 2>/dev/null; then echo "CodyWeb exited during startup. See $LOG_FILE" >&2; tail -n 30 "$LOG_FILE" >&2 || true; rm -f "$PID_FILE"; return 1; fi
    if node -e "fetch('http://$HOST:$PORT/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"; then echo "CodyWeb is running (PID $pid). Log: $LOG_FILE"; return 0; fi
    sleep 0.2
  done
  echo "Process is running but the HTTP readiness check timed out. See $LOG_FILE" >&2; return 1
}

status_service() { local pids; pids="$(find_our_pids)"; if [[ -n "$pids" ]]; then echo "running pid=${pids//$'\n'/,} url=http://$HOST:$PORT log=$LOG_FILE"; return 0; fi; echo "stopped"; return 1; }

case "${1:-status}" in
  start) start_service ;; stop) stop_service ;; restart) stop_service; start_service ;;
  status) status_service ;; logs) touch "$LOG_FILE"; tail -n "${CODY_LOG_LINES:-100}" -f "$LOG_FILE" ;;
  *) echo "Usage: $0 {start|stop|restart|status|logs}" >&2; exit 2 ;;
esac
