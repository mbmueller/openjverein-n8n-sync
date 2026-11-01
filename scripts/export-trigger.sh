#!/usr/bin/env bash
# Called by launcher/ after Jameica exits (or manually). No Cron. No Scripting.
# Usage:
#   export-trigger.sh start              # Outbox flush only
#   export-trigger.sh exit [JAMEICA_PID] # optional wait for PID, then Full-Export
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env}"
PYTHON="${PYTHON:-python3}"
EXPORTER="${REPO_ROOT}/exporter/export.py"
MODE="${1:-}"
WAIT_PID="${2:-}"

die() { echo "Fehler: $*" >&2; exit 1; }

[[ -n "${MODE}" ]] || die "Modus fehlt (start|exit)"
[[ -f "${EXPORTER}" ]] || die "Exporter fehlt: ${EXPORTER}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

log() { echo "[export-trigger] $*"; }

run_exporter() {
  local trigger="$1"
  shift
  log "Exporter (${trigger})…"
  "${PYTHON}" "${EXPORTER}" --env-file "${ENV_FILE}" --trigger "${trigger}" "$@" || {
    log "Exporter Exit-Code $? (Outbox greift beim nächsten Exit oder manuell)" >&2
  }
}

case "${MODE}" in
  start)
    # Nur Outbox — kurzer HTTP-Timeout; niemals H2/Full-Export beim Start
    export N8N_HTTP_TIMEOUT_SECONDS="${N8N_HTTP_TIMEOUT_SECONDS:-8}"
    run_exporter outbox_flush --flush-only || true
    ;;
  exit)
    if [[ -n "${WAIT_PID}" ]]; then
      log "Warte auf Jameica-PID ${WAIT_PID}…"
      waited=0
      max_wait="${EXIT_PID_WAIT_SECONDS:-600}"
      while kill -0 "${WAIT_PID}" 2>/dev/null; do
        sleep 1
        waited=$((waited + 1))
        if [[ "${waited}" -ge "${max_wait}" ]]; then
          log "Timeout (${max_wait}s) beim Warten auf PID ${WAIT_PID} — Export trotzdem versuchen" >&2
          break
        fi
      done
      sleep "${EXIT_H2_SETTLE_SECONDS:-2}"
    fi
    run_exporter jameica_exit
    ;;
  *)
    die "Unbekannter Modus: ${MODE} (erwartet: start|exit)"
    ;;
esac
