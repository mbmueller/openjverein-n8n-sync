#!/usr/bin/env python3
"""
OpenJVerein Bildnutzungs-Einwilligungen → JSON/CSV → n8n Webhook.

Primärpfad: Jameica Scripting → Runtime-Shutdown-Hook → export-trigger exit →
dieser Exporter; H2 readonly (kein AUTO_SERVER). Bei POST-Fehler: Outbox;
Retry beim nächsten Exit oder manuell (export-trigger start). Launcher cancelled.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import tempfile
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    def load_dotenv(*_a, **_k):  # type: ignore[misc]
        return False

SQL_EXPORT = """
SELECT m.id,
       m.externemitgliedsnummer,
       m.name,
       m.vorname,
       MAX(CASE WHEN fd.name = 'insta'   THEN z.feldjanein END) AS insta,
       MAX(CASE WHEN fd.name = 'website' THEN z.feldjanein END) AS website,
       MAX(CASE WHEN fd.name = 'flyer'   THEN z.feldjanein END) AS flyer
FROM mitglied m
LEFT JOIN zusatzfelder z ON z.mitglied = m.id
LEFT JOIN felddefinition fd ON fd.id = z.felddefinition
  AND fd.name IN ('insta', 'website', 'flyer')
WHERE m.austritt IS NULL
GROUP BY m.id, m.externemitgliedsnummer, m.name, m.vorname
HAVING COALESCE(MAX(CASE WHEN fd.name = 'insta'   THEN z.feldjanein END), FALSE)
    OR COALESCE(MAX(CASE WHEN fd.name = 'website' THEN z.feldjanein END), FALSE)
    OR COALESCE(MAX(CASE WHEN fd.name = 'flyer'   THEN z.feldjanein END), FALSE)
"""

FIELDS = ["insta", "website", "flyer"]
DIAG_PREFIX = "ojv-n8n-sync-"


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _stamp() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _temp_dirs() -> list[Path]:
    """Candidate temp dirs (Windows TEMP/TMP + TMPDIR + Python temp)."""
    seen: set[str] = set()
    out: list[Path] = []
    for key in ("TEMP", "TMP", "TMPDIR"):
        raw = os.environ.get(key)
        if not raw:
            continue
        p = str(Path(raw))
        if p in seen:
            continue
        seen.add(p)
        out.append(Path(raw))
    try:
        p = str(Path(tempfile.gettempdir()))
        if p not in seen:
            out.append(Path(p))
    except OSError:
        pass
    return out


def write_diag(basename: str, text: str) -> None:
    """Timestamped markers under TMPDIR/%TEMP% and <repo>/logs/ — no secrets."""
    body = f"{text}\n{_stamp()}\n"
    targets: list[Path] = []
    for d in _temp_dirs():
        targets.append(d / basename)
    try:
        log_dir = repo_root() / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        targets.append(log_dir / basename)
    except OSError:
        pass
    for path in targets:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
        except OSError:
            pass


def append_export_log(trigger: str, text: str) -> None:
    """Append diagnostic lines to logs/export-<trigger>.log (and ensure file exists)."""
    try:
        log_dir = repo_root() / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        path = log_dir / f"export-{trigger}.log"
        with path.open("a", encoding="utf-8") as f:
            f.write(f"[{_stamp()}] {text}\n")
    except OSError:
        pass


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v


def as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return True if v else False
    if v is None:
        return False
    if isinstance(v, (int, float)):
        return bool(v)
    s = str(v).strip().lower()
    return s in {"1", "true", "t", "ja", "yes", "y", "j"}


def load_config(env_file: Path | None) -> tuple[dict[str, Any], Path | None]:
    """Returns (cfg, resolved_env_path). resolved_env_path is None if no .env loaded."""
    root = repo_root()
    resolved: Path | None = None
    if env_file and env_file.is_file():
        load_dotenv(env_file)
        resolved = env_file
    else:
        default_env = root / ".env"
        if default_env.is_file():
            load_dotenv(default_env)
            resolved = default_env

    cfg = {
        "webhook_url": env("N8N_WEBHOOK_URL"),
        "webhook_secret": env("N8N_WEBHOOK_SECRET", ""),
        "h2_db_path": env("H2_DB_PATH"),
        "h2_user": env("H2_USER", "sa") or "sa",
        "h2_password": env("H2_PASSWORD", "") or "",
        "h2_jdbc_jar": env("H2_JDBC_JAR"),
        "output_dir": Path(env("OUTPUT_DIR", str(root / "output")) or (root / "output")),
        "outbox_dir": Path(env("OUTBOX_DIR", str(root / "outbox")) or (root / "outbox")),
    }
    return cfg, resolved


def webhook_missing(cfg: dict[str, Any]) -> bool:
    url = cfg.get("webhook_url")
    if not url:
        return True
    return "N8N_HOST_PLACEHOLDER" in str(url)


def classify_h2_error(exc: BaseException) -> str:
    """Map common H2/JDBC failures to stable reason codes (for markers)."""
    msg = f"{type(exc).__name__}: {exc}".lower()
    if "locked" in msg or "already in use" in msg or "database may be already" in msg:
        return "jdbc_lock"
    if "h2_jdbc_jar" in msg or ("jar" in msg and ("fehlt" in msg or "not found" in msg or "nicht gefunden" in msg)):
        return "h2_jar_missing"
    if "classnotfound" in msg or "org.h2.driver" in msg:
        return "h2_driver"
    if "access denied" in msg or "wrong user" in msg or "authentication" in msg:
        return "h2_auth"
    if "h2_db_path" in msg or "ifexists" in msg or "database not found" in msg or "nicht gefunden" in msg:
        return "h2_path"
    return "h2_connect"


def fail(
    trigger: str,
    reason: str,
    detail: str,
    *,
    rc: int = 2,
    exc: BaseException | None = None,
) -> int:
    """Loud exporter-fail marker; never empty rc=. Detail truncated, no secrets."""
    detail_one = " ".join(str(detail).split())
    if len(detail_one) > 500:
        detail_one = detail_one[:497] + "..."
    line = f"reason={reason} detail={detail_one} rc={rc} trigger={trigger}"
    write_diag(f"{DIAG_PREFIX}exporter-fail.txt", line)
    append_export_log(trigger, f"FAIL {line}")
    print(f"Exporter FAIL: {line}", file=sys.stderr)
    if exc is not None:
        tb = traceback.format_exc()
        append_export_log(trigger, tb)
        traceback.print_exc()
    return rc


def connect_h2(cfg: dict[str, Any]):
    try:
        import jaydebeapi  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "jaydebeapi fehlt. Installieren: pip install -r exporter/requirements.txt"
        ) from e

    jar = cfg["h2_jdbc_jar"]
    db = cfg["h2_db_path"]
    if not jar:
        raise RuntimeError("H2_JDBC_JAR fehlt in .env")
    if not Path(str(jar)).is_file():
        raise RuntimeError(f"H2_JDBC_JAR nicht gefunden (Datei fehlt): set path to h2-*.jar")
    if not db:
        raise RuntimeError("H2_DB_PATH fehlt in .env")
    # Do not embed absolute personal paths in raised messages beyond env key names
    # ACCESS_MODE_DATA=r: readonly, kein AUTO_SERVER
    url = f"jdbc:h2:file:{db};ACCESS_MODE_DATA=r;IFEXISTS=TRUE"
    return jaydebeapi.connect(
        "org.h2.Driver",
        url,
        [cfg["h2_user"], cfg["h2_password"]],
        jar,
    )


def fetch_members(conn) -> list[dict[str, Any]]:
    cur = conn.cursor()
    try:
        cur.execute(SQL_EXPORT)
        rows = cur.fetchall()
        cols = [d[0].lower() for d in (cur.description or [])]
    finally:
        cur.close()

    members: list[dict[str, Any]] = []
    for row in rows:
        data = dict(zip(cols, row))
        member = {
            "id": int(data.get("id") or 0),
            "mitgliedsnummer": str(data.get("externemitgliedsnummer") or ""),
            "name": str(data.get("name") or ""),
            "vorname": str(data.get("vorname") or ""),
            "insta": as_bool(data.get("insta")),
            "website": as_bool(data.get("website")),
            "flyer": as_bool(data.get("flyer")),
        }
        if member["insta"] or member["website"] or member["flyer"]:
            members.append(member)
    return members


def build_payload(members: list[dict[str, Any]], trigger: str) -> dict[str, Any]:
    return {
        "exported_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": "openjverein",
        "trigger": trigger,
        "fields": list(FIELDS),
        "members": members,
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_csv(path: Path, members: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["id", "mitgliedsnummer", "name", "vorname", "insta", "website", "flyer"]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for m in members:
            row = {k: m[k] for k in fieldnames}
            for k in FIELDS:
                row[k] = "Ja" if m[k] else "Nein"
            w.writerow(row)


def http_timeout_seconds() -> float:
    """Webhook timeout; start/outbox flush should stay short (env override)."""
    raw = env("N8N_HTTP_TIMEOUT_SECONDS", "60") or "60"
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 60.0


def post_webhook(cfg: dict[str, Any], payload: dict[str, Any]) -> None:
    url = cfg["webhook_url"]
    if webhook_missing(cfg):
        raise RuntimeError(
            "N8N_WEBHOOK_URL ist nicht gesetzt bzw. noch Platzhalter. "
            "Lokale .env anpassen."
        )
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
    }
    # Optional: only send header when a real secret is configured (n8n Auth=None → leave empty)
    secret = (cfg.get("webhook_secret") or "").strip()
    if secret and secret != "CHANGE_ME_WEBHOOK_SECRET":
        headers["X-Webhook-Secret"] = secret
    req = Request(url, data=body, headers=headers, method="POST")
    with urlopen(req, timeout=http_timeout_seconds()) as resp:
        code = getattr(resp, "status", None) or resp.getcode()
        if code is None or int(code) >= 400:
            raise RuntimeError(f"Webhook HTTP {code}")


def save_outbox(outbox_dir: Path, payload: dict[str, Any], err: str) -> Path:
    outbox_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = outbox_dir / f"einwilligungen-{ts}.json"
    envelope = {
        "failed_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "error": err,
        "payload": payload,
    }
    write_json(path, envelope)
    return path


def flush_outbox(cfg: dict[str, Any]) -> int:
    """Retry pending outbox payloads (oldest first). Returns remaining count."""
    outbox = cfg["outbox_dir"]
    if not outbox.is_dir():
        return 0
    files = sorted(outbox.glob("einwilligungen-*.json"))
    remaining = 0
    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            payload = data.get("payload") if isinstance(data, dict) else None
            if not isinstance(payload, dict):
                payload = data
            post_webhook(cfg, payload)
            path.unlink(missing_ok=True)
            print(f"Outbox OK: {path.name}")
        except Exception as e:  # noqa: BLE001
            remaining += 1
            print(f"Outbox Retry fehlgeschlagen ({path.name}): {e}", file=sys.stderr)
            break
    leftover = sorted(outbox.glob("einwilligungen-*.json"))
    return len(leftover) if leftover else remaining


def export_from_h2(cfg: dict[str, Any], trigger: str) -> dict[str, Any]:
    conn = connect_h2(cfg)
    try:
        members = fetch_members(conn)
    finally:
        conn.close()
    return build_payload(members, trigger)


def run(
    trigger: str,
    *,
    flush_only: bool = False,
    skip_flush: bool = False,
    env_file: Path | None = None,
) -> int:
    write_diag(
        f"{DIAG_PREFIX}exporter-start.txt",
        f"exporter start trigger={trigger} flush_only={flush_only}",
    )
    append_export_log(trigger, f"start flush_only={flush_only} env_file={env_file}")

    cfg, resolved_env = load_config(env_file)
    cfg["output_dir"].mkdir(parents=True, exist_ok=True)
    cfg["outbox_dir"].mkdir(parents=True, exist_ok=True)

    if resolved_env is None:
        return fail(
            trigger,
            "missing_env_file",
            "no .env found — copy .env.example to .env and set N8N_WEBHOOK_URL + H2_*",
            rc=2,
        )

    # Fail loud before H2 / HTTP when webhook is missing or still placeholder
    if webhook_missing(cfg):
        return fail(
            trigger,
            "missing_webhook",
            "N8N_WEBHOOK_URL unset or still N8N_HOST_PLACEHOLDER — set real URL in .env (N8N_WEBHOOK_SECRET optional if n8n has no auth)",
            rc=2,
        )

    if not skip_flush:
        left = flush_outbox(cfg)
        if left:
            print(f"Outbox: {left} Datei(en) warten auf nächsten Exit oder manuellen Flush.")

    if flush_only:
        write_diag(
            f"{DIAG_PREFIX}exporter-http.txt",
            f"flush_only done trigger={trigger}",
        )
        append_export_log(trigger, "flush_only done")
        return 0

    try:
        payload = export_from_h2(cfg, trigger)
    except Exception as e:  # noqa: BLE001
        reason = classify_h2_error(e)
        return fail(
            trigger,
            reason,
            f"{type(e).__name__}: {e}",
            rc=2,
            exc=e,
        )

    json_path = cfg["output_dir"] / "einwilligungen.json"
    csv_path = cfg["output_dir"] / "einwilligungen.csv"
    write_json(json_path, payload)
    write_csv(csv_path, payload["members"])
    member_count = len(payload["members"])
    print(f"Export: {member_count} Mitglieder → {json_path} , {csv_path}")
    append_export_log(trigger, f"exported members={member_count}")

    try:
        post_webhook(cfg, payload)
        write_diag(
            f"{DIAG_PREFIX}exporter-http.txt",
            f"webhook OK trigger={trigger} members={member_count}",
        )
        append_export_log(trigger, "webhook OK")
        print("Webhook OK")
        return 0
    except (HTTPError, URLError, RuntimeError, TimeoutError, OSError) as e:
        path = save_outbox(cfg["outbox_dir"], payload, str(e))
        err_kind = type(e).__name__
        http_code = getattr(e, "code", None)
        write_diag(
            f"{DIAG_PREFIX}exporter-http.txt",
            f"webhook FAIL trigger={trigger} err={err_kind} http={http_code} outbox=1",
        )
        print(f"Webhook fehlgeschlagen ({e}) → Outbox {path}", file=sys.stderr)
        # Also mark exporter-fail so TEMP always has a clear reason (rc never empty)
        return fail(
            trigger,
            "webhook_http",
            f"{err_kind} http={http_code} outbox=1",
            rc=1,
            exc=e,
        )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="OpenJVerein Einwilligungen → n8n")
    p.add_argument(
        "--trigger",
        default="manual",
        choices=["jameica_exit", "jameica_start", "manual", "outbox_flush"],
        help="Trigger-Kennzeichnung im JSON-Payload",
    )
    p.add_argument(
        "--flush-only",
        action="store_true",
        help="Nur Outbox an n8n nachsenden (z. B. nach Jameica-Start)",
    )
    p.add_argument(
        "--skip-flush",
        action="store_true",
        help="Outbox-Retry in diesem Lauf überspringen",
    )
    p.add_argument("--env-file", type=Path, default=None, help="Pfad zur .env")
    args = p.parse_args(argv)

    trigger = "outbox_flush" if args.flush_only else args.trigger
    try:
        return run(
            trigger,
            flush_only=args.flush_only,
            skip_flush=args.skip_flush,
            env_file=args.env_file,
        )
    except SystemExit as e:
        code = e.code
        rc = int(code) if isinstance(code, int) else 2
        detail = str(code) if not isinstance(code, int) else "SystemExit"
        return fail(trigger, "system_exit", detail, rc=rc if rc != 0 else 2, exc=e)
    except Exception as e:  # noqa: BLE001
        return fail(trigger, "uncaught", f"{type(e).__name__}: {e}", rc=2, exc=e)


if __name__ == "__main__":
    sys.exit(main())
