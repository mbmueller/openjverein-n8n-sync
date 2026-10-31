# OpenJVerein → n8n → Google Drive (Bildnutzungs-Einwilligungen)

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

Synchronisiert die Zusatzfelder **`insta`**, **`website`**, **`flyer`** (Ja/Nein) aus OpenJVerein nach Google Drive über einen n8n-Webhook.

**Lizenz:** [PolyForm Noncommercial 1.0.0](LICENSE) — frei nutzbar, änderbar und weitergebbar **nichtkommerziell**; **kein Verkauf** der Software. Details und Mitwirken: [CONTRIBUTING.md](CONTRIBUTING.md).

**Trigger:** Jameicas eingebautes **Scripting** (Start- und Shutdown-Hook). Jameica wird **normal** gestartet — **kein** Wrapper um die Binary nötig. Kein Cron, kein Task Scheduler. Fehlgeschlagene Uploads landen in `outbox/` und werden beim **nächsten** Start/Exit erneut versucht.

**Start hängt nicht:** Der Start-Hook plant höchstens einen **detachten** Outbox-Retry auf einem Daemon-Thread (kein `waitFor`, kein Full-Export, kein H2 beim Start). Full-Export nur beim **Beenden**.

## Architektur (kurz)

1. In Jameica registriertes Script (`scripts/jameica-openjverein-sync.js`) läuft nach dem Start und lauscht auf Beenden.
2. **Start:** optional Outbox → n8n, **asynchron** (H2 bleibt unberührt). Abschaltbar: `ENABLE_START_OUTBOX_FLUSH = false` in der `.js`.
3. **Sauberes Beenden:** detachter Exit-Export wartet **außerhalb** von Jameica auf Prozessende, liest H2 **readonly** (kein `AUTO_SERVER`).
4. Filter: nur **aktive** Mitglieder (`austritt` leer) mit **mindestens einer** Einwilligung.
5. Schreibt `einwilligungen.json` + `.csv`, POSTet an n8n (`X-Webhook-Secret`).
6. n8n legt Dateien unter Drive `aktuell/` und datiertem `archiv/` ab (optional `meta/last-sync.json`).

Kill/Absturz/Stromausfall: Exit-Hook kann ausbleiben → Drive behält den **letzten erfolgreichen Sync**. Das ist **OK**.

## Jameica hängt beim Start? — Dateisystem-Recovery (ohne UI)

Jameica wertet registrierte Scripts **synchron** nach `SYSTEM_STARTED` aus (`ScriptingService.eval`). Bei einer alten Hook-Version kann der Start vor den Einstellungen einfrieren. Die UI ist dann unerreichbar — **Script über Dateisystem deaktivieren**:

### 1. Jameica und Sync-Kinder beenden

Task-Manager / `kill`: Jameica, ggf. hängende `export-trigger`, `python`/`python3`, `cmd` aus diesem Repo.

### 2. Workdir finden

| OS | Standard-Workdir |
|----|------------------|
| **Windows** | `%USERPROFILE%\.jameica\` → z. B. `C:\Users\<Name>\.jameica\` |
| **Linux** | `~/.jameica/` |
| **macOS** | `~/Library/jameica/` (neu); falls vorhanden weiter `~/.jameica/` |

Abweichendes Workdir: Startparameter `-f <pfad>` oder Hinweis im Jameica-Log.

### 3. Scripting-Config (empfohlen)

Datei (UTF-8 / Properties):

```text
<workdir>/cfg/de.willuhn.jameica.services.ScriptingService.properties
```

Beispiel Windows: `C:\Users\<Name>\.jameica\cfg\de.willuhn.jameica.services.ScriptingService.properties`

Darin Zeilen wie:

```properties
scripts.0=C\:\\Users\\…\\openjverein-n8n-sync\\scripts\\jameica-openjverein-sync.js
```

**Deaktivieren:** die `scripts.N=`-Zeile(n) mit `jameica-openjverein-sync` löschen oder die ganze Datei kurz in `….properties.bak` umbenennen (entfernt alle registrierten Scripts). Speichern → Jameica neu starten.

Optional prüfen: `cfg/de.willuhn.jameica.scripting.Plugin.properties` (ältere Installationen).

### 4. Schnellvariante: `.js` umbenennen

Die registrierte Datei umbenennen, z. B. `jameica-openjverein-sync.js` → `jameica-openjverein-sync.js.bak`. Fehlt/unlesbar → ScriptingService überspringt sie (Boot-Warnung möglich), Jameica startet. Config-Zeile danach in den Einstellungen oder wie unter (3) aufräumen.

### 5. Danach

Aktuelles Repo/PR ziehen, erneut registrieren. Bei Bedarf in der `.js` `ENABLE_START_OUTBOX_FLUSH = false` setzen (nur Exit-Export).

## Voraussetzungen

- Jameica / OpenJVerein lokal (mit JavaScript-Engine: Nashorn/Rhino — bei aktuellen Jameica-Builds üblich)
- Python 3.10+ und Java (für H2-JDBC via JayDeBeApi)
- Erreichbare n8n-Instanz (Webhook + Google-Drive-Credential **in n8n**)
- H2-JDBC-JAR (oft bei Jameica/OpenJVerein mitgeliefert)

## Setup

```bash
git clone https://github.com/mbmueller/openjverein-n8n-sync.git
cd openjverein-n8n-sync
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r exporter/requirements.txt
cp .env.example .env
# .env ausfüllen: N8N_*, H2_DB_PATH, H2_JDBC_JAR
chmod +x scripts/export-trigger.sh
```

### Wichtige `.env`-Platzhalter

| Variable | Bedeutung |
|----------|-----------|
| `N8N_WEBHOOK_URL` | z. B. `https://<dein-n8n>/webhook/einwilligung-bildnutzung` |
| `N8N_WEBHOOK_SECRET` | gemeinsames Secret; Header `X-Webhook-Secret` |
| `H2_DB_PATH` | H2-Datei **ohne** `.mv.db`-Suffix |
| `H2_JDBC_JAR` | Pfad zur `h2-*.jar` |
| `OPENJVEREIN_N8N_SYNC_ROOT` | optional: absoluter Repo-Pfad (sonst `SYNC_ROOT` in der `.js`) |
| `EXIT_H2_SETTLE_SECONDS` | Pause nach Exit vor H2-Öffnen (Default `2`) |

Keine echten Secrets ins Git committen.

## Jameica-Script installieren (Primärweg)

Jameica bringt unter **Datei → Einstellungen → Scripting** eine Liste registrierter Script-Dateien mit. Beim Start werden sie ausgeführt; darin kann man auf System-Events (u. a. Beenden) reagieren.

### Einmalig einrichten

1. Repo wie oben klonen, `.env` ausfüllen, `scripts/export-trigger.sh` ausführbar machen (Linux/macOS).
2. Datei `scripts/jameica-openjverein-sync.js` öffnen und **`SYNC_ROOT`** auf den **absoluten** Pfad dieses Repos setzen  
   *oder* die Umgebungsvariable `OPENJVEREIN_N8N_SYNC_ROOT` setzen (z. B. in der Shell, aus der Jameica startet, bzw. systemweit).
3. Jameica **normal** starten (`jameica.sh` / `jameica-win64.exe` / App — **nicht** den alten Wrapper).
4. Menü **Datei → Einstellungen** öffnen, Reiter **Scripting**.
5. **Script hinzufügen…** → `…/openjverein-n8n-sync/scripts/jameica-openjverein-sync.js` wählen.
6. Einstellungen speichern. Beim nächsten Start (oder nach Reload der Scripts) ist der Hook aktiv.
7. Zum Testen: Jameica **über Datei → Beenden** sauber schließen und prüfen, ob `output/einwilligungen.*` entsteht und der n8n-Webhook ankommt.

### Was wann läuft

| Zeitpunkt | Aktion |
|-----------|--------|
| Nach Jameica-Start (Script-Load) | Nur Registrierung + **geplanter** detached Outbox-Flush (Daemon-Thread, Default ~5 s Verzögerung). Kein Warten, kein H2. |
| Bei `SYSTEM_SHUTDOWN` (sauberes Beenden) | Detachter Exit-Export: wartet **außerhalb** von Jameica auf PID-Ende, dann Full-Export |

In `scripts/jameica-openjverein-sync.js`: `ENABLE_START_OUTBOX_FLUSH = false` schaltet den Start-Retry ab (Export nur noch beim Beenden).

**Hinweis macOS:** Beenden über den roten Fensterknopf oder **Datei → Beenden**, damit Shutdown-Hooks laufen (nicht Cmd+Q).

### Manueller Test ohne Jameica

```bash
./scripts/export-trigger.sh start          # nur Outbox
./scripts/export-trigger.sh exit           # Full-Export (Jameica sollte zu sein)
python exporter/export.py --trigger jameica_exit
```

Windows:

```cmd
scripts\export-trigger.cmd start
scripts\export-trigger.cmd exit
```

## Optional: Wrapper (deprecated)

Nur falls Scripting nicht nutzbar ist. Startet Jameica blockierend und ruft danach denselben `export-trigger` auf — **nicht** empfohlen, weil man die Jameica-Binary wrappen müsste. Details: [`wrapper/README.md`](wrapper/README.md).

## n8n-Workflow importieren

1. In n8n: **Workflow importieren** → `n8n/einwilligung-bildnutzung.json`
2. Google-Drive-OAuth-Credential **in der n8n-UI** anlegen und an die Drive-Nodes hängen (Dummy-IDs im JSON ersetzen).
3. Ordner-IDs setzen für:
   - `aktuell/` → `DRIVE_FOLDER_ID_AKTUELL_PLACEHOLDER`
   - `archiv/YYYY-MM-DD/` → `DRIVE_FOLDER_ID_ARCHIV_PLACEHOLDER` (datierter Unterordner)
   - `meta/` → `DRIVE_FOLDER_ID_META_PLACEHOLDER`
4. Webhook-Pfad: `einwilligung-bildnutzung` (POST).
5. Secret: Header `X-Webhook-Secret` muss zu `N8N_WEBHOOK_SECRET` passen (in n8n-Env oder IF-Node).
6. Workflow aktivieren; Production-Webhook-URL in lokale `.env` übernehmen.

### Drive-Layout (Pfadname noch offen)

```text
…/<DRIVE-ORDNER-NOCH-OFFEN>/
  aktuell/
    einwilligungen.json
    einwilligungen.csv
  archiv/
    YYYY-MM-DD/
      …
  meta/
    last-sync.json
```

Arbeitsdatei für Medien: **`aktuell/einwilligungen.csv`**.

## Secrets

| Secret | Wo |
|--------|-----|
| Webhook-URL / Secret | lokal `.env` + n8n — in Git nur Platzhalter |
| Google Drive OAuth | **nur** in n8n |
| H2-Zugang | lokal am Exporter |

Dieses Repo ist **publishbar**: keine echten Hosts, Tokens oder DB-Pfade.

## Hinweise

- Primärpfad ist **nach Exit** (H2 freigegeben). Parallel-JDBC bei laufendem Jameica wird vermieden.
- Start-Hook ist **non-blocking** (Hang-Fix): kein synchrones Warten auf Shell, PID, H2 oder n8n im Scripting-Thread.
- Filter „≥1 Einwilligung“ sitzt im Exporter; n8n wiederholt ihn als Sicherheitsnetz.
- Kein täglicher Zeitplan: Sync und Outbox-Retry nur über Jameica-Scripts bei Start/Exit.
- Hintergrund: Jameica `ScriptingService` — Scripts unter Einstellungen → Scripting; Auswertung nach `SYSTEM_STARTED` (**synchrones** `eval` — deshalb darf unser Hook dort nicht blockieren); Shutdown über Message `SYSTEM_SHUTDOWN`.
