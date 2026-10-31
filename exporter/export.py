#!/usr/bin/env python3
"""
OpenJVerein Bildnutzungs-Einwilligungen → JSON/CSV → n8n Webhook.

Primärpfad: Jameica Scripting (scripts/) ruft nach Exit diesen Exporter auf;
H2 readonly lesen (kein AUTO_SERVER). Bei POST-Fehler: Outbox;
Retry beim nächsten Start/Exit-Lauf.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
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


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v


def as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    if isinstance(v, (int, float)):
        return bool(v)
    s = str(v).strip().lower()
    return s in {"1", "true", "t", "ja", "yes", "y", "j"}


def load_config(env_file: Path | None) -> dict[str, Any]:
    root = repo_root()
    if env_file and env_file.is_file():
        load_dotenv(env_file)
    else:
        load_dotenv(root / ".env")

    return {
        "webhook_url": env("N8N_WEBHOOK_URL"),
        "webhook_secret": env("N8N_WEBHOOK_SECRET", ""),
        "h2_db_path": env("H2_DB_PATH"),
        "h2_user": env("H2_USER", "sa") or "sa",
        "h2_password": env("H2_PASSWORD", "") or "",
        "h2_jdbc_jar": env("H2_JDBC_JAR"),
        "output_dir": Path(env("OUTPUT_DIR", str(root / "output")) or (root / "output")),
        "outbox_dir": Path(env("OUTBOX_DIR", str(root / "outbox")) or (root / "outbox")),
    }


def connect_h2(cfg: dict[str, Any]):
    try:
        import jaydebeapi  # type: ignore
    except ImportError as e:
        raise SystemExit(
            "jaydebeapi fehlt. Installieren: pip install -r exporter/requirements.txt"
        ) from e

    jar = cfg["h2_jdbc_jar"]
    db = cfg["h2_db_path"]
    if not jar or not Path(jar).is_file():
        raise SystemExit(
            f"H2_JDBC_JAR nicht gefunden: {jar!r}. "
            "Pfad zur h2-*.jar setzen (oft bei Jameica/OpenJVerein)."
        )
    if not db:
        raise SystemExit("H2_DB_PATH fehlt in .env")

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
    if not url or "N8N_HOST_PLACEHOLDER" in url:
        raise RuntimeError(
            "N8N_WEBHOOK_URL ist nicht gesetzt bzw. noch Platzhalter. "
            "Lokale .env anpassen."
        )
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "X-Webhook-Secret": cfg["webhook_secret"] or "",
    }
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
            # stop chain — keep order; later files wait for next start/exit
            break
    # count any not attempted after break
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
    cfg = load_config(env_file)
    cfg["output_dir"].mkdir(parents=True, exist_ok=True)
    cfg["outbox_dir"].mkdir(parents=True, exist_ok=True)

    if not skip_flush:
        left = flush_outbox(cfg)
        if left:
            print(f"Outbox: {left} Datei(en) warten auf nächsten Start/Exit.")

    if flush_only:
        return 0

    try:
        payload = export_from_h2(cfg, trigger)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"H2-Export fehlgeschlagen: {e}", file=sys.stderr)
        traceback.print_exc()
        return 2

    json_path = cfg["output_dir"] / "einwilligungen.json"
    csv_path = cfg["output_dir"] / "einwilligungen.csv"
    write_json(json_path, payload)
    write_csv(csv_path, payload["members"])
    print(f"Export: {len(payload['members'])} Mitglieder → {json_path} , {csv_path}")

    try:
        post_webhook(cfg, payload)
        print("Webhook OK")
        return 0
    except (HTTPError, URLError, RuntimeError, TimeoutError, OSError) as e:
        path = save_outbox(cfg["outbox_dir"], payload, str(e))
        print(f"Webhook fehlgeschlagen ({e}) → Outbox {path}", file=sys.stderr)
        return 1


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
    return run(
        trigger,
        flush_only=args.flush_only,
        skip_flush=args.skip_flush,
        env_file=args.env_file,
    )


if __name__ == "__main__":
    sys.exit(main())
