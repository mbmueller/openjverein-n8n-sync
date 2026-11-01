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
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

# Detached Jameica spawn redirects stdout/stderr to logs/export-*.log — force flush.
os.environ.setdefault("PYTHONUNBUFFERED", "1")
try:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
    sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001
    pass

try:
    from dotenv import load_dotenv as _load_dotenv_lib
except ImportError:  # pragma: no cover
    def _load_dotenv_lib(*_a, **_k):  # type: ignore[misc]
        return False


def _strip_wrapping_quotes(value: str) -> str:
    v = value.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def load_dotenv_raw(env_file: Path, *, override: bool = False) -> bool:
    """Load KEY=VALUE from .env without escape decoding (Windows-path safe).

    python-dotenv interprets sequences like ``\\t`` inside double-quoted values,
    which breaks Windows paths such as ``E:\\path\\to\\h2-2.3.232.jar``
    (``\\t`` → TAB, ``\\2``-style damage). Prefer unquoted forward slashes in
    `.env`; this loader still strips residual wrapping quotes and keeps
    backslashes literal. Existing process env wins unless override=True.
    """
    try:
        text = env_file.read_text(encoding="utf-8")
    except OSError:
        return False
    loaded = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        if not key or any(c.isspace() for c in key):
            continue
        val = _strip_wrapping_quotes(val.strip())
        if not override and key in os.environ:
            continue
        os.environ[key] = val
        loaded = True
    return loaded


def load_dotenv(env_file: Path | str | None = None, **kwargs: Any) -> bool:
    """Prefer raw path-safe loader; fall back to python-dotenv if needed."""
    if env_file is None:
        return bool(_load_dotenv_lib(**kwargs))
    path = Path(env_file)
    if path.is_file():
        override = bool(kwargs.get("override", False))
        return load_dotenv_raw(path, override=override)
    return bool(_load_dotenv_lib(env_file, **kwargs))

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
            with path.open("w", encoding="utf-8", newline="\n") as f:
                f.write(body)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
        except OSError:
            pass


def append_export_log(trigger: str, text: str) -> None:
    """Append diagnostic lines to logs/export-<trigger>.log (always flushed)."""
    try:
        log_dir = repo_root() / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        path = log_dir / f"export-{trigger}.log"
        with path.open("a", encoding="utf-8", newline="\n") as f:
            f.write(f"[{_stamp()}] {text}\n")
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
    except OSError:
        pass


def progress(trigger: str, stage: str, detail: str = "") -> None:
    """Overwrite progress marker so hang location is visible (TEMP + logs/)."""
    detail_one = " ".join(str(detail).split())
    if len(detail_one) > 400:
        detail_one = detail_one[:397] + "..."
    line = f"stage={stage}"
    if detail_one:
        line += f" detail={detail_one}"
    line += f" trigger={trigger}"
    write_diag(f"{DIAG_PREFIX}exporter-progress.txt", line)
    append_export_log(trigger, f"progress {line}")
    print(f"[exporter] {line}", flush=True)


def env_float(name: str, default: float) -> float:
    raw = env(name)
    if raw is None:
        return default
    try:
        return max(1.0, float(raw))
    except ValueError:
        return default


def env_int_ms(name: str, default_ms: int) -> int:
    """Seconds env → milliseconds for H2 LOCK_TIMEOUT (min 1000 ms)."""
    secs = env_float(name, default_ms / 1000.0)
    return max(1000, int(secs * 1000))


def webhook_host(url: str | None) -> str:
    """Host only — never userinfo/query/secrets."""
    if not url:
        return "-"
    try:
        p = urlparse(str(url))
        host = p.hostname or "-"
        if p.port:
            return f"{host}:{p.port}"
        return host
    except Exception:  # noqa: BLE001
        return "-"


def run_with_timeout(label: str, seconds: float, fn: Callable[[], Any]) -> Any:
    """Run fn in a daemon thread; raise TimeoutError if it exceeds seconds."""
    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            box["result"] = fn()
        except BaseException as e:  # noqa: BLE001
            box["exc"] = e

    t = threading.Thread(target=worker, name=f"ojv-{label}", daemon=True)
    t.start()
    t.join(seconds)
    if t.is_alive():
        raise TimeoutError(
            f"{label} exceeded {seconds:.0f}s "
            f"(likely H2 lock, missing JVM for jaydebeapi, or hung native call)"
        )
    if "exc" in box:
        raise box["exc"]
    return box.get("result")


_WATCHDOG_FIRED = threading.Event()


def arm_watchdog(trigger: str, seconds: float) -> None:
    """Hard-exit if the whole exporter run hangs without writing fail/success."""
    _WATCHDOG_FIRED.clear()

    def killer() -> None:
        if _WATCHDOG_FIRED.wait(seconds):
            return
        line = (
            f"reason=watchdog detail=exporter_exceeded_{int(seconds)}s "
            f"rc=3 trigger={trigger}"
        )
        try:
            write_diag(f"{DIAG_PREFIX}exporter-fail.txt", line)
            append_export_log(trigger, f"FAIL {line}")
            progress(trigger, "watchdog", f"exceeded_{int(seconds)}s")
        except Exception:  # noqa: BLE001
            pass
        # Native hang (JDBC/JVM) may leave non-daemon threads — force exit.
        os._exit(3)

    threading.Thread(target=killer, name="ojv-watchdog", daemon=True).start()


def disarm_watchdog() -> None:
    _WATCHDOG_FIRED.set()


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    # cmd.exe for /f and quoted .env lines may leave wrapping quotes on paths
    return _strip_wrapping_quotes(v)


def as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return True if v else False
    if v is None:
        return False
    if isinstance(v, (int, float)):
        return bool(v)
    s = str(v).strip().lower()
    return s in {"1", "true", "t", "ja", "yes", "y", "j"}


def _unique_paths(paths: list[Path]) -> list[Path]:
    seen: set[str] = set()
    out: list[Path] = []
    for p in paths:
        try:
            key = str(p.expanduser())
        except (OSError, RuntimeError):
            key = str(p)
        if key in seen:
            continue
        seen.add(key)
        out.append(Path(key))
    return out


def jameica_home_candidates(h2_db_path: str | None = None) -> list[Path]:
    """Install/data roots that commonly contain h2-*.jar (no personal defaults committed)."""
    homes: list[Path] = []
    for key in ("JAMEICA_HOME", "JAMEICA_DIR"):
        raw = env(key)
        if raw:
            homes.append(Path(raw))

    jbin = env("JAMEICA_BIN")
    if jbin:
        p = Path(jbin)
        homes.append(p.parent if p.suffix else p)

    # User Jameica workdir (plugins often live here on Windows)
    home = Path.home()
    homes.append(home / ".jameica")
    # macOS alternate
    homes.append(home / "Library" / "jameica")

    if os.name == "nt":
        for env_key in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "ProgramW6432"):
            base = os.environ.get(env_key)
            if not base:
                continue
            base_p = Path(base)
            homes.append(base_p / "jameica")
            homes.append(base_p / "Jameica")
            try:
                for child in sorted(base_p.glob("jameica*")):
                    if child.is_dir():
                        homes.append(child)
            except OSError:
                pass
        # German Windows "Programme" junction / legacy docs
        for prog in (Path(r"C:\Programme"), Path(r"C:\Program Files"), Path(r"C:\Program Files (x86)")):
            homes.append(prog / "jameica")
            homes.append(prog / "Jameica")
            try:
                for child in sorted(prog.glob("jameica*")):
                    if child.is_dir():
                        homes.append(child)
            except OSError:
                pass

    # Derive from H2_DB_PATH parents (…/.jameica/openjverein/h2db/name → …/.jameica)
    if h2_db_path:
        db = Path(h2_db_path)
        for parent in list(db.parents)[:6]:
            homes.append(parent)
            if parent.name.lower() in {".jameica", "jameica"}:
                break

    return _unique_paths(homes)


def _is_h2_jdbc_jar(path: Path) -> bool:
    name = path.name.lower()
    if not name.endswith(".jar"):
        return False
    # h2.jar, h2-2.3.232.jar, h2-1.4.199-fork.jar — skip unrelated *h2* names
    return name == "h2.jar" or name.startswith("h2-")


def _h2_jar_version_nums(name: str) -> tuple[int, ...]:
    """Parse leading version ints from h2-*.jar names (e.g. h2-1.4.199-fork.jar)."""
    ver_part = name[3:-4] if name.startswith("h2-") and name.endswith(".jar") else name
    nums: list[int] = []
    for chunk in ver_part.replace("-", ".").split("."):
        if chunk.isdigit():
            nums.append(int(chunk))
        else:
            break
    return tuple(nums)


def _jar_sort_key(path: Path) -> tuple[int, tuple[int, ...], str]:
    """
    Prefer h2-1.4.*.jar over H2 2.x.

    Typical OpenJVerein / JVerein DBs are MVStore format 1 (H2 1.4.x). A newer
    Jameica lib/h2 2.x jar opens format 3 only and fails with H2 error 90048
    (Unsupported database file version / read format 1 < supported format 3).
    Plain h2.jar ranks last among peers.
    """
    name = path.name.lower()
    if name == "h2.jar":
        return (0, (0,), name)
    nums = _h2_jar_version_nums(name)
    major = nums[0] if nums else 0
    minor = nums[1] if len(nums) > 1 else 0
    # Higher tier wins with reverse=True: 1.4.x > other 1.x > 2.x+ > unknown
    if major == 1 and minor == 4:
        tier = 3
    elif major == 1:
        tier = 2
    elif major >= 2:
        tier = 1
    else:
        tier = 0
    return (tier, nums, name)


def discover_h2_jars(roots: list[Path]) -> list[Path]:
    """Search common relative locations under Jameica homes / plugin trees."""
    found: list[Path] = []
    rel_globs = (
        "lib/h2/h2.jar",
        "lib/h2/h2-*.jar",
        "lib/h2/*.jar",
        "lib/h2/migration-h2/disabled/h2*.jar",
        "lib/h2/migration-h2/enabled/h2*.jar",
        "lib/h2.jar",
        "lib/h2-*.jar",
        "plugins/*/lib/h2.jar",
        "plugins/*/lib/h2-*.jar",
        "plugins/*/lib/**/h2*.jar",
        "plugins/*/h2*.jar",
    )
    for root in roots:
        if not root.is_dir():
            continue
        for pattern in rel_globs:
            try:
                for hit in root.glob(pattern):
                    if hit.is_file() and _is_h2_jdbc_jar(hit):
                        found.append(hit.resolve())
            except OSError:
                continue
        # Shallow fallback: any h2-*.jar under plugins (depth-limited via rglob on plugins only)
        plugins = root / "plugins"
        if plugins.is_dir():
            try:
                for hit in plugins.rglob("h2*.jar"):
                    if hit.is_file() and _is_h2_jdbc_jar(hit):
                        found.append(hit.resolve())
            except OSError:
                pass

    return sorted(_unique_paths(found), key=_jar_sort_key, reverse=True)


def resolve_h2_jdbc_jar(configured: str | None, h2_db_path: str | None = None) -> Path | None:
    """
    Use H2_JDBC_JAR if the file exists; otherwise discover under JAMEICA_HOME /
    Program Files / %USERPROFILE%\\.jameica plugin+lib trees.

    Auto-pick prefers h2-1.4.*.jar (format-1 OpenJVerein DBs) over H2 2.x, and
    non-migration-enabled paths over migration-h2/enabled forks.
    """
    if configured:
        p = Path(configured).expanduser()
        if p.is_file():
            return p.resolve()
        # Placeholder or stale path — fall through to discovery

    jars = discover_h2_jars(jameica_home_candidates(h2_db_path))
    if not jars:
        return None
    # Prefer lib/h2/*.jar (and disabled migration) over enabled migration forks when possible
    preferred: list[Path] = []
    secondary: list[Path] = []
    for j in jars:
        parts = {x.lower() for x in j.parts}
        if "enabled" in parts and "migration-h2" in parts:
            secondary.append(j)
        else:
            preferred.append(j)
    pick = preferred or secondary
    return pick[0] if pick else None


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

    h2_db = env("H2_DB_PATH")
    h2_jar_env = env("H2_JDBC_JAR")
    resolved_jar = resolve_h2_jdbc_jar(h2_jar_env, h2_db)

    cfg = {
        "webhook_url": env("N8N_WEBHOOK_URL"),
        "webhook_secret": env("N8N_WEBHOOK_SECRET", ""),
        "h2_db_path": h2_db,
        "h2_user": env("H2_USER", "sa") or "sa",
        "h2_password": env("H2_PASSWORD", "") or "",
        "h2_jdbc_jar": str(resolved_jar) if resolved_jar else h2_jar_env,
        "h2_jdbc_jar_resolved": resolved_jar is not None,
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
    if isinstance(exc, TimeoutError) or "exceeded" in msg and "timeout" in msg.lower():
        return "h2_connect_timeout"
    if "timeout" in msg or "timed out" in msg:
        return "h2_connect_timeout"
    if "locked" in msg or "already in use" in msg or "database may be already" in msg:
        return "jdbc_lock"
    if "h2_jdbc_jar" in msg or ("jar" in msg and ("fehlt" in msg or "not found" in msg or "nicht gefunden" in msg)):
        return "h2_jar_missing"
    # H2 90048: driver MVStore format newer than on-disk DB (e.g. 2.x jar vs format-1 file)
    if (
        "90048" in msg
        or "unsupported database file version" in msg
        or "datei version wird nicht unterstützt" in msg
        or "ungültiger dateikopf" in msg
        or "invalid file header" in msg
        or "read format" in msg
        or "supported format" in msg
    ):
        return "h2_format_mismatch"
    if "classnotfound" in msg or "org.h2.driver" in msg:
        return "h2_driver"
    if "no jvm" in msg or "java home" in msg or "jpype" in msg or "jvm not found" in msg:
        return "jvm_missing"
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
    disarm_watchdog()
    detail_one = " ".join(str(detail).split())
    if len(detail_one) > 500:
        detail_one = detail_one[:497] + "..."
    line = f"reason={reason} detail={detail_one} rc={rc} trigger={trigger}"
    write_diag(f"{DIAG_PREFIX}exporter-fail.txt", line)
    progress(trigger, f"fail:{reason}", f"rc={rc}")
    append_export_log(trigger, f"FAIL {line}")
    print(f"Exporter FAIL: {line}", file=sys.stderr, flush=True)
    if exc is not None:
        tb = traceback.format_exc()
        append_export_log(trigger, tb)
        traceback.print_exc()
        try:
            sys.stderr.flush()
        except Exception:  # noqa: BLE001
            pass
    return rc


def h2_connect_timeout_seconds() -> float:
    return env_float("H2_CONNECT_TIMEOUT_SECONDS", 30.0)


def h2_query_timeout_seconds() -> float:
    return env_float("H2_QUERY_TIMEOUT_SECONDS", 60.0)


def connect_h2(cfg: dict[str, Any], trigger: str = "manual"):
    progress(trigger, "import_jaydebeapi")
    try:
        import jaydebeapi  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "jaydebeapi fehlt. Im Repo-Root: "
            "python -m venv .venv && "
            ".venv/bin/pip install -r exporter/requirements.txt "
            "(Windows: .venv\\Scripts\\pip …). "
            "export-trigger nutzt .venv automatisch; sonst: pip install -r exporter/requirements.txt"
        ) from e

    jar = cfg.get("h2_jdbc_jar")
    db = cfg["h2_db_path"]
    jar_path = Path(str(jar)).expanduser() if jar else None
    if jar_path is None or not jar_path.is_file():
        progress(trigger, "resolve_h2_jar")
        # Second chance if load_config ran before install appeared
        found = resolve_h2_jdbc_jar(env("H2_JDBC_JAR"), db)
        if found is not None:
            jar_path = found
            cfg["h2_jdbc_jar"] = str(found)
            cfg["h2_jdbc_jar_resolved"] = True
    if jar_path is None or not jar_path.is_file():
        raise RuntimeError(
            "H2_JDBC_JAR nicht gefunden (Datei fehlt): set path to h2-*.jar "
            "(Windows: unter Jameica-Install lib\\h2\\ oder "
            "%USERPROFILE%\\.jameica\\plugins\\**\\h2-*.jar suchen; "
            "optional JAMEICA_HOME setzen — siehe README)"
        )
    if not db:
        raise RuntimeError(
            "H2_DB_PATH fehlt in .env "
            "(typisch: %USERPROFILE%\\.jameica\\openjverein\\h2db\\openjverein "
            "ohne .mv.db/.h2.db — siehe README)"
        )
    # Do not embed absolute personal paths in raised messages beyond env key names
    # ACCESS_MODE_DATA=r: readonly, kein AUTO_SERVER
    # LOCK_TIMEOUT (ms): avoid infinite wait when Jameica still holds the file lock
    lock_ms = env_int_ms("H2_CONNECT_TIMEOUT_SECONDS", 30_000)
    url = (
        f"jdbc:h2:file:{db};ACCESS_MODE_DATA=r;IFEXISTS=TRUE;"
        f"LOCK_TIMEOUT={lock_ms};DB_CLOSE_DELAY=0"
    )
    connect_secs = h2_connect_timeout_seconds()
    progress(
        trigger,
        "h2_connect",
        f"timeout_s={connect_secs:.0f} lock_timeout_ms={lock_ms} "
        f"jar={jar_path.name} path={jar_path}",
    )
    append_export_log(trigger, f"h2_connect using jar={jar_path}")

    def _do_connect():
        return jaydebeapi.connect(
            "org.h2.Driver",
            url,
            [cfg["h2_user"], cfg["h2_password"]],
            str(jar_path),
        )

    try:
        return run_with_timeout("h2_connect", connect_secs, _do_connect)
    except TimeoutError:
        raise
    except Exception as e:  # noqa: BLE001
        # JVM / JPype often surfaces here before a real JDBC error
        msg = f"{type(e).__name__}: {e}".lower()
        if "jpype" in msg or "jvm" in msg or "java" in msg and "not found" in msg:
            raise RuntimeError(
                f"JVM/jaydebeapi start failed jar={jar_path}: "
                f"{type(e).__name__}: {e}. "
                "Install a JRE and ensure JAVA_HOME (or java on PATH) for the "
                "same user that runs the Jameica detached export-trigger."
            ) from e
        # Keep original exception type for classify_h2_error; jar path is in progress/fail.
        raise


def fetch_members(conn, trigger: str = "manual") -> list[dict[str, Any]]:
    query_secs = h2_query_timeout_seconds()
    progress(trigger, "h2_query", f"timeout_s={query_secs:.0f}")

    def _do_query() -> tuple[list[Any], list[str]]:
        cur = conn.cursor()
        try:
            cur.execute(SQL_EXPORT)
            rows = cur.fetchall()
            cols = [d[0].lower() for d in (cur.description or [])]
            return rows, cols
        finally:
            cur.close()

    rows, cols = run_with_timeout("h2_query", query_secs, _do_query)

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
    progress(trigger, "h2_query_done", f"members={len(members)}")
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
    return env_float("N8N_HTTP_TIMEOUT_SECONDS", 60.0)


def exporter_watchdog_seconds() -> float:
    """Whole-run ceiling so a hung JDBC/JVM still leaves exporter-fail."""
    return env_float("EXPORTER_WATCHDOG_SECONDS", 180.0)


def post_webhook(cfg: dict[str, Any], payload: dict[str, Any], trigger: str = "manual") -> None:
    url = cfg["webhook_url"]
    if webhook_missing(cfg):
        raise RuntimeError(
            "N8N_WEBHOOK_URL ist nicht gesetzt bzw. noch Platzhalter. "
            "Lokale .env anpassen."
        )
    host = webhook_host(url)
    timeout_s = http_timeout_seconds()
    progress(trigger, "http_post", f"host={host} timeout_s={timeout_s:.0f}")
    write_diag(
        f"{DIAG_PREFIX}exporter-http.txt",
        f"webhook POST start trigger={trigger} host={host} timeout_s={timeout_s:.0f}",
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
    try:
        with urlopen(req, timeout=timeout_s) as resp:
            code = getattr(resp, "status", None) or resp.getcode()
            if code is None or int(code) >= 400:
                raise RuntimeError(f"Webhook HTTP {code}")
    except TimeoutError as e:
        raise TimeoutError(f"webhook host={host} timeout_s={timeout_s:.0f}") from e
    except URLError as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, TimeoutError) or "timed out" in str(reason).lower():
            raise TimeoutError(f"webhook host={host} timeout_s={timeout_s:.0f}") from e
        raise


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


def flush_outbox(cfg: dict[str, Any], trigger: str = "manual") -> int:
    """Retry pending outbox payloads (oldest first). Returns remaining count."""
    outbox = cfg["outbox_dir"]
    if not outbox.is_dir():
        return 0
    files = sorted(outbox.glob("einwilligungen-*.json"))
    if not files:
        progress(trigger, "outbox_empty")
        return 0
    progress(trigger, "outbox_flush", f"files={len(files)}")
    remaining = 0
    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            payload = data.get("payload") if isinstance(data, dict) else None
            if not isinstance(payload, dict):
                payload = data
            post_webhook(cfg, payload, trigger=trigger)
            path.unlink(missing_ok=True)
            print(f"Outbox OK: {path.name}", flush=True)
        except Exception as e:  # noqa: BLE001
            remaining += 1
            print(f"Outbox Retry fehlgeschlagen ({path.name}): {e}", file=sys.stderr, flush=True)
            break
    leftover = sorted(outbox.glob("einwilligungen-*.json"))
    return len(leftover) if leftover else remaining


def export_from_h2(cfg: dict[str, Any], trigger: str) -> dict[str, Any]:
    conn = None
    try:
        conn = connect_h2(cfg, trigger=trigger)
        progress(trigger, "h2_connected")
        members = fetch_members(conn, trigger=trigger)
    finally:
        if conn is not None:
            try:
                progress(trigger, "h2_close")
                conn.close()
            except Exception as e:  # noqa: BLE001
                append_export_log(trigger, f"h2_close error: {type(e).__name__}: {e}")
    return build_payload(members, trigger)


def run(
    trigger: str,
    *,
    flush_only: bool = False,
    skip_flush: bool = False,
    env_file: Path | None = None,
) -> int:
    watchdog_s = exporter_watchdog_seconds()
    write_diag(
        f"{DIAG_PREFIX}exporter-start.txt",
        f"exporter start trigger={trigger} flush_only={flush_only} "
        f"watchdog_s={watchdog_s:.0f}",
    )
    append_export_log(
        trigger,
        f"start flush_only={flush_only} env_file={env_file} watchdog_s={watchdog_s:.0f}",
    )
    progress(trigger, "started", f"flush_only={flush_only}")
    arm_watchdog(trigger, watchdog_s)
    rc = 2
    try:
        progress(trigger, "load_config")
        cfg, resolved_env = load_config(env_file)
        jar_cfg = str(cfg["h2_jdbc_jar"]) if cfg.get("h2_jdbc_jar") else ""
        jar_name = Path(jar_cfg).name if jar_cfg else "-"
        jar_env = env("H2_JDBC_JAR") or ""
        progress(
            trigger,
            "config_loaded",
            f"env={'1' if resolved_env else '0'} "
            f"jar_resolved={'1' if cfg.get('h2_jdbc_jar_resolved') else '0'} "
            f"jar={jar_name} path={jar_cfg or '-'} "
            f"webhook_host={webhook_host(cfg.get('webhook_url'))}",
        )
        write_diag(
            f"{DIAG_PREFIX}exporter-jar.txt",
            f"H2_JDBC_JAR env={jar_env or '-'} "
            f"resolved={'1' if cfg.get('h2_jdbc_jar_resolved') else '0'} "
            f"path={jar_cfg or '-'} name={jar_name} trigger={trigger}",
        )
        cfg["output_dir"].mkdir(parents=True, exist_ok=True)
        cfg["outbox_dir"].mkdir(parents=True, exist_ok=True)
        if cfg.get("h2_jdbc_jar_resolved") and cfg.get("h2_jdbc_jar"):
            append_export_log(
                trigger,
                f"H2_JDBC_JAR ok path={cfg['h2_jdbc_jar']} "
                "(explicit .env or auto-discovered; prefers h2-1.4.* over 2.x)",
            )
        else:
            append_export_log(
                trigger,
                f"H2_JDBC_JAR unresolved env={jar_env or '-'} "
                f"cfg={jar_cfg or '-'} (set H2_JDBC_JAR to h2-1.4.199.jar for format-1 DBs)",
            )

        if resolved_env is None:
            rc = fail(
                trigger,
                "missing_env_file",
                "no .env found — copy .env.example to .env and set N8N_WEBHOOK_URL + H2_*",
                rc=2,
            )
            return rc

        # Fail loud before H2 / HTTP when webhook is missing or still placeholder
        if webhook_missing(cfg):
            rc = fail(
                trigger,
                "missing_webhook",
                "N8N_WEBHOOK_URL unset or still N8N_HOST_PLACEHOLDER — set real URL in .env (N8N_WEBHOOK_SECRET optional if n8n has no auth)",
                rc=2,
            )
            return rc

        if not skip_flush:
            left = flush_outbox(cfg, trigger=trigger)
            if left:
                print(
                    f"Outbox: {left} Datei(en) warten auf nächsten Exit oder manuellen Flush.",
                    flush=True,
                )

        if flush_only:
            write_diag(
                f"{DIAG_PREFIX}exporter-http.txt",
                f"flush_only done trigger={trigger} host={webhook_host(cfg.get('webhook_url'))}",
            )
            progress(trigger, "flush_only_done")
            append_export_log(trigger, "flush_only done")
            rc = 0
            return rc

        try:
            payload = export_from_h2(cfg, trigger)
        except Exception as e:  # noqa: BLE001
            reason = classify_h2_error(e)
            jar_for_fail = cfg.get("h2_jdbc_jar") or env("H2_JDBC_JAR") or "-"
            # jar= first — fail() truncates detail at 500 chars
            rc = fail(
                trigger,
                reason,
                f"jar={jar_for_fail} {type(e).__name__}: {e}",
                rc=2,
                exc=e,
            )
            return rc

        progress(trigger, "write_output")
        json_path = cfg["output_dir"] / "einwilligungen.json"
        csv_path = cfg["output_dir"] / "einwilligungen.csv"
        write_json(json_path, payload)
        write_csv(csv_path, payload["members"])
        member_count = len(payload["members"])
        print(f"Export: {member_count} Mitglieder → {json_path} , {csv_path}", flush=True)
        append_export_log(trigger, f"exported members={member_count}")

        host = webhook_host(cfg.get("webhook_url"))
        try:
            post_webhook(cfg, payload, trigger=trigger)
            write_diag(
                f"{DIAG_PREFIX}exporter-http.txt",
                f"webhook OK trigger={trigger} host={host} members={member_count}",
            )
            progress(trigger, "http_ok", f"host={host} members={member_count}")
            append_export_log(trigger, f"webhook OK host={host}")
            print("Webhook OK", flush=True)
            write_diag(
                f"{DIAG_PREFIX}exporter-success.txt",
                f"ok trigger={trigger} host={host} members={member_count} rc=0",
            )
            rc = 0
            return rc
        except (HTTPError, URLError, RuntimeError, TimeoutError, OSError) as e:
            path = save_outbox(cfg["outbox_dir"], payload, str(e))
            err_kind = type(e).__name__
            http_code = getattr(e, "code", None)
            write_diag(
                f"{DIAG_PREFIX}exporter-http.txt",
                f"webhook FAIL trigger={trigger} host={host} err={err_kind} "
                f"http={http_code} outbox=1",
            )
            progress(trigger, "http_fail", f"host={host} err={err_kind}")
            print(
                f"Webhook fehlgeschlagen ({e}) → Outbox {path}",
                file=sys.stderr,
                flush=True,
            )
            reason = (
                "webhook_timeout"
                if isinstance(e, TimeoutError) or "timeout" in str(e).lower()
                else "webhook_http"
            )
            rc = fail(
                trigger,
                reason,
                f"{err_kind} host={host} http={http_code} outbox=1",
                rc=1,
                exc=e,
            )
            return rc
    finally:
        disarm_watchdog()
        try:
            append_export_log(trigger, f"run_end rc={rc}")
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:  # noqa: BLE001
            pass


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
    try:
        raise SystemExit(main())
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:  # noqa: BLE001
            pass
