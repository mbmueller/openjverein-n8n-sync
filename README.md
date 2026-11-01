# OpenJVerein → n8n → Google Drive (Bildnutzungs-Einwilligungen)

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

Synchronisiert die Zusatzfelder **`insta`**, **`website`**, **`flyer`** (Ja/Nein) aus OpenJVerein nach Google Drive über einen n8n-Webhook.

**Lizenz:** [PolyForm Noncommercial 1.0.0](LICENSE) — frei nutzbar, änderbar und weitergebbar **nichtkommerziell**; **kein Verkauf** der Software. Details und Mitwirken: [CONTRIBUTING.md](CONTRIBUTING.md).

**Trigger:** Jameica **normal starten** (kein Launcher/Wrapper). Automation über **Jameica Scripting**. Kein Cron.

## Architektur (kurz)

1. Jameica wie gewohnt starten; Sync-Script unter **Einstellungen → Scripting** registrieren.
2. Beim Laden: Script meldet sich an (deferred); **kein** `MessageConsumer` (das hing früher beim Start).
3. Beim sauberen Beenden (**Datei → Beenden**): `Application.shutDown()` → `System.exit` → `Runtime.addShutdownHook` startet `export-trigger exit` **detached** → H2 readonly → JSON/CSV → n8n.
4. Filter: nur **aktive** Mitglieder mit **mindestens einer** Einwilligung.

**Kein Webhook beim Start** (Standard): `ENABLE_START_OUTBOX_FLUSH = false` — Full-Export nur beim Beenden. Start-Outbox ist optional.

Kill/Absturz: kein Exit-Lauf → Drive behält den **letzten erfolgreichen Sync**. Das ist **OK**.

```text
Jameica (Scripting) … Datei→Beenden → Runtime-Hook → export-trigger exit → Exporter → n8n → Drive
```

## Setup

```bash
git clone https://github.com/mbmueller/openjverein-n8n-sync.git
cd openjverein-n8n-sync
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r exporter/requirements.txt
cp .env.example .env
# .env: N8N_*, H2_DB_PATH, H2_JDBC_JAR
chmod +x scripts/export-trigger.sh
```

### Wichtige `.env`-Platzhalter

| Variable | Bedeutung |
|----------|-----------|
| `N8N_WEBHOOK_URL` | z. B. `https://<dein-n8n>/webhook/einwilligung-bildnutzung` |
| `N8N_WEBHOOK_SECRET` | gemeinsames Secret; Header `X-Webhook-Secret` |
| `H2_DB_PATH` | H2-Datei **ohne** `.mv.db`-Suffix |
| `H2_JDBC_JAR` | Pfad zur `h2-*.jar` |
| `EXIT_H2_SETTLE_SECONDS` | Pause nach Exit vor H2-Öffnen (Default `2`) |
| `OPENJVEREIN_N8N_SYNC_ROOT` | optional statt `SYNC_ROOT` in der `.js` |

Keine echten Secrets ins Git committen.

---

## Schritt 1 — Hello-World (Hang-Beweis, zuerst)

Alte Hook-Versionen mit `MessageConsumer` / `Java.extend` **hängen den Start**. Zuerst beweisen, dass Scripting ohne Hang läuft:

1. Falls Jameica noch hängt: **Recovery** (unten) — Sync-`.js` aus der Config entfernen.
2. Jameica **normal** starten (nicht über `launcher/`).
3. **Datei → Einstellungen → Scripting → Script hinzufügen…** → `scripts/hello-world.js` → Speichern.
4. Jameica **neu starten**.

### Was du sehen solltest

| Check | Erwartung |
|-------|-----------|
| UI | Jameica kommt hoch, kein Freeze |
| Log | Zeile `[ojv-hello] loaded …` |
| Marker Load | `%TEMP%\ojv-hello-world-loaded.txt` bzw. `$TMPDIR/ojv-hello-world-loaded.txt` |
| Nach **Datei → Beenden** | Marker `…/ojv-hello-world-shutdown.txt` + Log `shutdown hook fired` |

Wenn der Start mit Hello-World hängt: in der Datei `STAGE_SHUTDOWN_HOOK = false` setzen und erneut testen. Wenn dann OK → Hook-Registrierung problematisch; Issue öffnen. Wenn schon ohne Hook hängt → `STAGE_LOGGER` / `STAGE_MARKER_FILE` abschalten bzw. `minimal.js` testen.

---

## Schritt 2 — Sync-Script registrieren

Nur wenn Hello-World **Start + Shutdown-Marker** ok waren:

1. Hello-World aus Scripting entfernen (oder deaktiviert lassen).
2. **SYNC_ROOT-Checkliste** (ohne das kein Export):
   - In `scripts/jameica-openjverein-sync.js` `SYNC_ROOT = "…"` auf den **absoluten Repo-Pfad** setzen **oder**
   - `OPENJVEREIN_N8N_SYNC_ROOT` in der Umgebung von Jameica setzen (nicht nur in einer fremden Shell).
   - Pfad muss existieren und `scripts/export-trigger.(sh|cmd)` sowie `.env` enthalten.
3. Scripting → `scripts/jameica-openjverein-sync.js` hinzufügen → Speichern → Jameica neu starten.
4. Sauber beenden (**Datei → Beenden**, kein Kill) → Marker + `output/einwilligungen.*` + n8n prüfen.

### Manueller Fallback / Test

```bash
./scripts/export-trigger.sh exit
# Windows: scripts\export-trigger.cmd exit
python exporter/export.py --trigger jameica_exit
```

---

## Diagnose: Warum kein Webhook? Wohin schauen?

Typische Ursachen (oft kombiniert):

| Ursache | Wirkung |
|---------|---------|
| `SYNC_ROOT` / `OPENJVEREIN_N8N_SYNC_ROOT` leer oder falsch | Hook wird trotzdem registriert, aber Spawn schreibt `…-root-fail.txt` / `…-spawn-fail.txt` — **kein** Exporter |
| `ENABLE_START_OUTBOX_FLUSH = false` (Default) | **Kein** Start-Webhook — Absicht; Export nur nach Beenden |
| Nur Fenster schließen / Kill statt **Datei → Beenden** | JVM-Hook kann ausbleiben |
| `.env` Platzhalter / H2-Pfad falsch | Trigger läuft, Webhook/H2 scheitert → Marker `…-exporter-http.txt` / `…-exporter-fail.txt`, ggf. Outbox |
| Alter Hang-Hook noch registriert | Start freeze — Recovery unten |
| Truthiness/`var e = events` auf globalem `events` | `eval-fail.txt`: `Invalid JavaScript value of type …ScriptingService$Events` — Sync-Script nutzt `events` **nicht** |

`SYSTEM_SHUTDOWN` geht **nicht** an `events.*`. MessageConsumer/`Java.extend` hängt beim Eval — deshalb **Runtime-Shutdown-Hook**. Bei **Datei → Beenden** ruft Jameica `System.exit` auf → Hooks laufen. Der Jameica-Logger ist zu dem Zeitpunkt oft schon geschlossen; deshalb zählen die **Marker-Dateien**.

### Marker-Ort (nach Start und nach Beenden prüfen)

Windows: `%TEMP%\ojv-n8n-sync-*.txt`  
Linux/macOS: `$TMPDIR/ojv-n8n-sync-*.txt` (sonst `/tmp/…`)  
Zusätzlich, wenn `SYNC_ROOT` ok: `<Repo>/logs/ojv-n8n-sync-*.txt` und `logs/export-trigger-spawn.log`

| Datei | Bedeutung |
|-------|-----------|
| `ojv-n8n-sync-eval.txt` | Script wurde evaluiert (Load ok) |
| `ojv-n8n-sync-eval-fail.txt` | Bootstrap abgebrochen (früher: Events-Truthiness) |
| `ojv-n8n-sync-root-ok.txt` / `root-fail.txt` | Repo-Pfad gesetzt bzw. fehlt |
| `ojv-n8n-sync-hook-registered.txt` | Shutdown-Hook hängt an der JVM |
| `ojv-n8n-sync-start-skipped.txt` | Start-Outbox absichtlich aus |
| `ojv-n8n-sync-shutdown-hook-fired.txt` | **Datei → Beenden** hat den Hook ausgelöst |
| `ojv-n8n-sync-spawn-exit.txt` | `export-trigger exit` detached gestartet |
| `ojv-n8n-sync-trigger-spawned.txt` | Trigger-Prozess läuft |
| `ojv-n8n-sync-exporter-start.txt` | Python-Exporter gestartet |
| `ojv-n8n-sync-exporter-http.txt` | Webhook OK oder FAIL (ohne personenbezogene Daten) |
| `ojv-n8n-sync-spawn-fail.txt` / `exporter-fail.txt` | Pfad/Spawn/H2-Fehler |

**Nach dem nächsten sauberen Beenden** mindestens erwarten: `eval` → `hook-registered` → `shutdown-hook-fired` → `spawn-exit` → `trigger-spawned` → `exporter-start` → `exporter-http`. Fehlt `shutdown-hook-fired`, hat der Quit-Pfad den Hook nicht erreicht. Fehlt schon `root-ok`, zuerst SYNC_ROOT setzen.

Optional in Jameica-Log (solange Logger noch offen): Zeilen mit `[openjverein-n8n-sync]`.

---

## Hang-Ursache (kurz)

`ScriptingService` evaluiert registrierte `.js` **synchron** nach `SYSTEM_STARTED`.  
Unser früherer Hook registrierte einen **`MessageConsumer` via `Java.extend` / `JavaAdapter`** im Eval-Pfad → Start freeze. Leere `.js` startete; Hook-Code nicht.

Zusätzlich: globales `events` (`ScriptingService$Events`) darf in Rhino **nicht** als JS-Wert behandelt werden (`if (events)`, `var e = events`, Wrap/Return) — das wirft `InternalError: Invalid JavaScript value of type …Events`. Hibiscus ruft nur `events.add(…)` direkt auf; der Sync-Pfad verzichtet ganz auf `events` und nutzt nur den JVM-Hook.

**Arbeitendes Muster:** Eval nur Marker + deferred Daemon-Thread; Shutdown über **`Runtime.addShutdownHook`**; Export nur **`ProcessBuilder.start()` ohne waitFor**.  
`SYSTEM_SHUTDOWN` wird von Jameica **nicht** auf `events.*` gemappt — deshalb Hook statt Event-API.

Optional später: winziges Java-Plugin, das bei `SYSTEM_SHUTDOWN` `QueryMessage("function.…")` an Queue `jameica.scripting` schickt (InvokeScriptMessageConsumer) — JS bleibt ohne Consumer.

### Recovery (alte hängende Registrierung)

1. Jameica / hängende Kinder beenden.
2. Workdir: Windows `%USERPROFILE%\.jameica\`, Linux `~/.jameica/`, macOS oft `~/Library/jameica/`.
3. In `cfg/de.willuhn.jameica.services.ScriptingService.properties` Zeilen `scripts.N=…` mit altem Sync-/Hook-Pfad entfernen **oder** die `.js` umbenennen (`.bak`).
4. Neu starten → zuerst `hello-world.js`.

---

## n8n-Workflow importieren

1. In n8n: **Workflow importieren** → `n8n/einwilligung-bildnutzung.json`
2. Google-Drive-OAuth-Credential **in der n8n-UI** anlegen und an die Drive-Nodes hängen (Dummy-IDs im JSON ersetzen).
3. Ordner-IDs setzen für:
   - `aktuell/` → `DRIVE_FOLDER_ID_AKTUELL_PLACEHOLDER`
   - `archiv/` → `DRIVE_FOLDER_ID_ARCHIV_PLACEHOLDER`
4. Webhook-URL/Secret an lokale `.env` anbinden.

## Drive-Layout

```text
…/<DRIVE-ORDNER>/
  aktuell/einwilligungen.{json,csv}
  archiv/YYYY-MM-DD/…
  meta/last-sync.json   # optional
```

## Was nicht (MVP)

| Thema | Status |
|-------|--------|
| Cron / Task Scheduler | **nein** |
| Launcher/Wrapper als Primärstart | **cancelled** — Jameica normal starten |
| Ordner-Watcher | nein |
| `MessageConsumer` in JS | **nicht** — hängt beim Eval |
| Kommentar-only `.js` als Endzustand | **nein** — Hello-World + Sync-Hook |

`launcher/` bleibt nur als Notfall-Experiment im Tree; **nicht** der unterstützte Pfad.
