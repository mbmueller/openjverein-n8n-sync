# OpenJVerein → n8n → Google Drive (Bildnutzungs-Einwilligungen)

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

Synchronisiert die Zusatzfelder **`insta`**, **`website`**, **`flyer`** (Ja/Nein) aus OpenJVerein nach Google Drive über einen n8n-Webhook.

**Lizenz:** [PolyForm Noncommercial 1.0.0](LICENSE) — frei nutzbar, änderbar und weitergebbar **nichtkommerziell**; **kein Verkauf** der Software. Details und Mitwirken: [CONTRIBUTING.md](CONTRIBUTING.md).

**Trigger:** nach sauberem Jameica-Ende `scripts/export-trigger` ausführen (Windows-Shortcut, Wrapper oder manuell). Kein Cron, kein Task Scheduler. Fehlgeschlagene Uploads landen in `outbox/` und werden beim **nächsten Exit-Lauf** erneut versucht.

**Kein Shutdown-Hook in Scripting:** Leere/minimale `.js` startet Jameica; schon `MessageConsumer`/`Packages`/`Java.type` beim Eval hängt den Start (bestätigt). `SYSTEM_SHUTDOWN` lässt sich so nicht sicher registrieren → **nur externer Post-Exit-Trigger**. Die Sync-`.js` im Repo ist bewusst leer (Kommentar); `minimal.js` nur zur Diagnose.

## Architektur (kurz)

1. Jameica normal nutzen (OpenJVerein / H2).
2. Nach **Beenden**: `export-trigger exit` wartet ggf. auf Prozessende, liest H2 **readonly**, flushed Outbox.
3. Filter: nur **aktive** Mitglieder (`austritt` leer) mit **mindestens einer** Einwilligung.
4. Schreibt `einwilligungen.json` + `.csv`, POSTet an n8n (`X-Webhook-Secret`).
5. n8n legt Dateien unter Drive `aktuell/` und datiertem `archiv/` ab (optional `meta/last-sync.json`).

Kill/Absturz/Stromausfall: kein Exit-Lauf → Drive behält den **letzten erfolgreichen Sync**. Das ist **OK**.

## Jameica hängt beim Start? — Dateisystem-Recovery (ohne UI)

Jameica wertet registrierte Scripts **synchron** nach `SYSTEM_STARTED` aus (`ScriptingService.eval`). Schon das **Laden/Auswerten** einer `.js` (nicht erst „Start-Sync“) kann vor der Settings-UI einfrieren — z. B. durch `Packages` / `Java.type` / `JavaAdapter` / `MessageConsumer` auf dem Top-Level. Die UI ist dann unerreichbar.

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

**Deaktivieren:** die `scripts.N=`-Zeile(n) mit `jameica-openjverein-sync` (oder `.minimal.js`) löschen oder die ganze Datei kurz in `….properties.bak` umbenennen (entfernt alle registrierten Scripts). Speichern → Jameica neu starten.

Optional prüfen: `cfg/de.willuhn.jameica.scripting.Plugin.properties` (ältere Installationen).

### 4. Schnellvariante: `.js` umbenennen

Die registrierte Datei umbenennen, z. B. `jameica-openjverein-sync.js` → `jameica-openjverein-sync.js.bak`. Fehlt/unlesbar → ScriptingService überspringt sie (Boot-Warnung möglich), Jameica startet. Config-Zeile danach in den Einstellungen oder wie unter (3) aufräumen.

### 5. Test mit `minimal.js` (nach Recovery)

1. Recovery wie oben, Jameica startet **ohne** Sync-Script.
2. Optional **nur** `scripts/jameica-openjverein-sync.minimal.js` registrieren (nahezu leer).
3. Start OK → leere Scripts sind fein; Hang kam vom früheren Sync-Inhalt (Java beim Eval).
4. Sync **nicht** wieder über Scripting-Consumer lösen — Exit nur über `export-trigger` (unten).

### 6. Danach

Aktuelles Repo ziehen. Alte Sync-`.js` aus der Scripting-Liste entfernen (oder durch die leere Repo-Version ersetzen). Sync-Weg: `export-trigger` nach Exit.

## Voraussetzungen

- Jameica / OpenJVerein lokal
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

## Zuverlässiger Exit-Trigger (empfohlen)

Jameica beenden, **danach** (H2 freigegeben) den Exporter starten. Kein Scripting-Eval nötig.

### Windows: Shortcut nach Exit

1. Jameica wie gewohnt beenden (**Datei → Beenden**).
2. Verknüpfung oder `.cmd` auf:

```cmd
C:\Pfad\zu\openjverein-n8n-sync\scripts\export-trigger.cmd exit
```

Arbeitsverzeichnis = Repo-Root (oder `OPENJVEREIN_N8N_SYNC_ROOT` / `.env` setzen). Optional Verknüpfung ins Startmenü / auf den Desktop.

### Windows / Linux: Wrapper (startet Jameica, danach Export)

Startet Jameica **blockierend** und ruft danach denselben `export-trigger exit` auf — sinnvoll, wenn man **einen** Launcher will und Scripting meidet:

```bash
./wrapper/jameica-wrapper.sh
```

Windows: `wrapper\jameica-wrapper.cmd` (Pfad zur Jameica-Binary in der Datei / Umgebung setzen). Details: [`wrapper/README.md`](wrapper/README.md).

### Mini-Watcher (Idee)

Externer Prozess beobachtet die Jameica-PID und startet nach Ende `export-trigger exit` — gleiches Ergebnis wie Shortcut, ohne die Binary zu wrappen. Kein Muss; Shortcut oder Wrapper reichen fürs MVP.

### Manuell

```bash
./scripts/export-trigger.sh exit           # Full-Export (Jameica sollte zu sein)
./scripts/export-trigger.sh start          # nur Outbox (manuell)
python exporter/export.py --trigger jameica_exit
```

Windows:

```cmd
scripts\export-trigger.cmd exit
scripts\export-trigger.cmd start
```

## Jameica-Scripting: bewusst kein Hook

`scripts/jameica-openjverein-sync.js` ist **leer** (nur Kommentar). Registrierung ist optional und ändert nichts am Sync. **`SYSTEM_SHUTDOWN`-Consumer in JS weglassen** — die Registrierung (Java-Interop beim Eval) hängt den Start.

| Zeitpunkt | Aktion |
|-----------|--------|
| Jameica-Start / Script-Load | nichts (leere `.js` oder kein Script) |
| Nach Jameica-Ende | `export-trigger exit` (Shortcut / Wrapper / manuell) |

Diagnose: `minimal.js` — siehe Recovery §5.

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

- Sync **nur** nach Exit über `export-trigger` (H2 freigegeben).
- Sync-`.js` absichtlich leer; `MessageConsumer`/`Packages` beim Eval hängen (leere Datei startet). `minimal.js` = Diagnose.
- Filter „≥1 Einwilligung“ im Exporter; n8n als Sicherheitsnetz.
- Kein Tagesplan: Sync nach Jameica-Ende (Outbox-Retry manuell oder nächster Exit-Lauf).
