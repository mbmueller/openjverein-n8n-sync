#!/usr/bin/env bash
# Primary launcher: start Jameica, wait for exit, then export-trigger.
# Pin/use this instead of raw jameica.sh — UI unchanged; sync runs after Beenden.
# No Cron. No Jameica Scripting.
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
FLUSH_OUTBOX_ON_START="${FLUSH_OUTBOX_ON_START:-0}"
TRIGGER="${REPO_ROOT}/scripts/export-trigger.sh"

die() { echo "Fehler: $*" >&2; exit 1; }

[[ -n "${JAMEICA_BIN}" ]] || die "JAMEICA_BIN nicht gesetzt (.env)"
[[ -x "${JAMEICA_BIN}" || -f "${JAMEICA_BIN}" ]] || die "JAMEICA_BIN nicht gefunden: ${JAMEICA_BIN}"
[[ -f "${TRIGGER}" ]] || die "export-trigger fehlt: ${TRIGGER}"
chmod +x "${TRIGGER}" 2>/dev/null || true

if [[ "${FLUSH_OUTBOX_ON_START}" == "1" ]]; then
  "${TRIGGER}" start || true
fi

echo "[launcher] Starte Jameica: ${JAMEICA_BIN}"
set +e
"${JAMEICA_BIN}" "$@"
JAMEICA_RC=$?
set -e
echo "[launcher] Jameica beendet (rc=${JAMEICA_RC}) — starte Export…"

"${TRIGGER}" exit

exit "${JAMEICA_RC}"
