#!/usr/bin/env bash
# Wrapper: startet Jameica, nach Exit Exporter; optional vor Start Outbox flushen.
# Sync nur bei Start/Exit — kein Cron.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

JAMEICA_BIN="${JAMEICA_BIN:-}"
FLUSH_OUTBOX_ON_START="${FLUSH_OUTBOX_ON_START:-1}"
PYTHON="${PYTHON:-python3}"
EXPORTER="${REPO_ROOT}/exporter/export.py"

die() { echo "Fehler: $*" >&2; exit 1; }

[[ -n "${JAMEICA_BIN}" ]] || die "JAMEICA_BIN nicht gesetzt (.env)"
[[ -x "${JAMEICA_BIN}" || -f "${JAMEICA_BIN}" ]] || die "JAMEICA_BIN nicht gefunden: ${JAMEICA_BIN}"
[[ -f "${EXPORTER}" ]] || die "Exporter fehlt: ${EXPORTER}"

run_exporter() {
  local trigger="$1"
  shift
  echo "[wrapper] Exporter (${trigger})…"
  "${PYTHON}" "${EXPORTER}" --env-file "${ENV_FILE}" --trigger "${trigger}" "$@" || {
    echo "[wrapper] Exporter Exit-Code $? (Outbox greift beim nächsten Start/Exit)" >&2
  }
}

# Optional: vor Start nur Outbox flushen (H2 oft noch gesperrt → kein Full-Export)
if [[ "${FLUSH_OUTBOX_ON_START}" == "1" ]]; then
  run_exporter outbox_flush --flush-only || true
fi

echo "[wrapper] Starte Jameica: ${JAMEICA_BIN}"
set +e
"${JAMEICA_BIN}" "$@"
JAMEICA_RC=$?
set -e
echo "[wrapper] Jameica beendet (rc=${JAMEICA_RC})"

# Primärpfad: nach Exit H2 frei → Full-Export + Outbox-Retry
run_exporter jameica_exit

exit "${JAMEICA_RC}"
