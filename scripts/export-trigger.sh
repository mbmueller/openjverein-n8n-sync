#!/usr/bin/env bash
# Called by Jameica Scripting shutdown hook (detached) or manually.
# Launcher/ is cancelled — not the primary path. No Cron.
# Usage:
#   export-trigger.sh start              # Outbox flush only
#   export-trigger.sh exit [JAMEICA_PID] # optional wait for PID, then Full-Export
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env}"
# PYTHON: optional Override (ENV/.env). Sonst .venv, sonst PATH — siehe resolve_python
EXPORTER="${REPO_ROOT}/exporter/export.py"
MODE="${1:-}"
WAIT_PID="${2:-}"
LOG_DIR="${REPO_ROOT}/logs"
mkdir -p "${LOG_DIR}"

die() { echo "Fehler: $*" >&2; exit 1; }

log() { echo "[export-trigger] $*"; }

# Sichtbare Marker: TMPDIR/%TEMP% und Repo logs/ (kein PII in Git)
diag_marker() {
  local name="$1"
  local text="$2"
  local stamp
  stamp="$(date -Iseconds 2>/dev/null || date)"
  local body="${text}"$'\n'"${stamp}"$'\n'
  local tmp="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}"
  mkdir -p "${tmp}" "${LOG_DIR}" 2>/dev/null || true
  printf '%s' "${body}" > "${tmp}/${name}" 2>/dev/null || true
  printf '%s' "${body}" > "${LOG_DIR}/${name}" 2>/dev/null || true
  log "diag ${name}: ${text}"
}

write_fail() {
  local reason="$1"
  local detail="$2"
  local rc="${3:-unknown}"
  diag_marker "ojv-n8n-sync-exporter-fail.txt" \
    "reason=${reason} detail=${detail} rc=${rc} mode=${MODE} python=${PYTHON}"
}

# Prefer SYNC_ROOT/.venv (Jameica-Spawn aktiviert die venv nicht → oft System-Python ohne jaydebeapi).
# Absoluter PYTHON=-Pfad (executable) überschreibt; bloßer Name "python3" verliert gegen .venv.
resolve_python() {
  if [[ -n "${PYTHON:-}" && -x "${PYTHON}" ]]; then
    return 0
  fi
  if [[ -x "${REPO_ROOT}/.venv/bin/python" ]]; then
    PYTHON="${REPO_ROOT}/.venv/bin/python"
    return 0
  fi
  if [[ -n "${PYTHON:-}" ]] && command -v "${PYTHON}" >/dev/null 2>&1; then
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    PYTHON=python3
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    PYTHON=python
    return 0
  fi
  return 1
}

[[ -n "${MODE}" ]] || {
  write_fail missing_mode "start_or_exit_required" 1
  die "Modus fehlt (start|exit)"
}
[[ -f "${EXPORTER}" ]] || {
  write_fail exporter_missing "${EXPORTER}" 1
  die "Exporter fehlt: ${EXPORTER}"
}

if [[ ! -f "${ENV_FILE}" ]]; then
  write_fail missing_env_file "copy_.env.example_to_.env_and_set_N8N_WEBHOOK_URL" 2
  die ".env fehlt: ${ENV_FILE}"
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if ! resolve_python; then
  write_fail python_not_found "no_.venv_and_python_not_on_PATH_create_.venv_or_set_PYTHON" 127
  die "python nicht gefunden (weder ${REPO_ROOT}/.venv/bin/python noch PATH)"
fi

diag_marker "ojv-n8n-sync-trigger-spawned.txt" \
  "export-trigger mode=${MODE} waitPid=${WAIT_PID:--} root=${REPO_ROOT} envFile=${ENV_FILE} python=${PYTHON}"

# Unbuffered Python so logs/export-*.log shows progress during H2/HTTP hangs
export PYTHONUNBUFFERED=1
export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"

run_exporter() {
  local trigger="$1"
  shift
  local export_log="${LOG_DIR}/export-${trigger}.log"
  log "Exporter (${trigger})… log=${export_log}"
  {
    echo "[$(date -Iseconds 2>/dev/null || date)] spawn python=${PYTHON} mode=${MODE} trigger=${trigger}"
  } >"${export_log}"
  set +e
  "${PYTHON}" -u "${EXPORTER}" --env-file "${ENV_FILE}" --trigger "${trigger}" "$@" \
    >>"${export_log}" 2>&1
  local rc=$?
  set -e
  echo "[$(date -Iseconds 2>/dev/null || date)] python_exit rc=${rc}" >>"${export_log}"
  if [[ "${rc}" -ne 0 ]]; then
    # Keep Python's reason=* marker; only write fallback if missing/empty rc
    local fail_tmp="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}/ojv-n8n-sync-exporter-fail.txt"
    if ! grep -q 'reason=' "${fail_tmp}" 2>/dev/null \
      && ! grep -q 'reason=' "${LOG_DIR}/ojv-n8n-sync-exporter-fail.txt" 2>/dev/null; then
      write_fail exporter_exit "see_logs_export-${trigger}.log" "${rc:-unknown}"
    fi
    log "Exporter Exit-Code ${rc:-unknown} (siehe ${export_log})" >&2
    return "${rc}"
  fi
  return 0
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
    write_fail unknown_mode "${MODE}" 1
    die "Unbekannter Modus: ${MODE} (erwartet: start|exit)"
    ;;
esac
