# OpenJVerein → n8n → Google Drive (Bildnutzungs-Einwilligungen)

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

Synchronisiert die Zusatzfelder **`insta`**, **`website`**, **`flyer`** (Ja/Nein) aus OpenJVerein nach Google Drive über einen n8n-Webhook.

**Lizenz:** [PolyForm Noncommercial 1.0.0](LICENSE) — frei nutzbar, änderbar und weitergebbar **nichtkommerziell**; **kein Verkauf** der Software. Details und Mitwirken: [CONTRIBUTING.md](CONTRIBUTING.md).

**Trigger:** Jameica über den **Launcher** starten; nach Prozessende läuft der Export automatisch. Kein Cron, kein manuelles Export-Klicken im Alltag, kein Jameica-Scripting-Hook.

## Architektur (kurz)

1. **Launcher** startet Jameica (UI unverändert).
2. Nach **Beenden**: Launcher ruft `export-trigger exit` → H2 **readonly** → JSON/CSV → n8n.
3. Filter: nur **aktive** Mitglieder (`austritt` leer) mit **mindestens einer** Einwilligung.
4. n8n schreibt Drive `aktuell/` + datiertes `archiv/` (optional `meta/last-sync.json`).

Kill/Absturz/Stromausfall: kein Exit-Lauf → Drive behält den **letzten erfolgreichen Sync**. Das ist **OK**.

```text
Launcher → Jameica … Beenden → export-trigger exit → Exporter → n8n → Drive
```

## Setup

```bash
git clone https://github.com/mbmueller/openjverein-n8n-sync.git
cd openjverein-n8n-sync
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r exporter/requirements.txt
cp .env.example .env
# .env: JAMEICA_BIN, N8N_*, H2_DB_PATH, H2_JDBC_JAR
chmod +x launcher/jameica-launcher.sh scripts/export-trigger.sh
```

### Wichtige `.env`-Platzhalter

| Variable | Bedeutung |
|----------|-----------|
| `JAMEICA_BIN` | Pfad zu `jameica.exe` / `jameica.sh` |
| `N8N_WEBHOOK_URL` | z. B. `https://<dein-n8n>/webhook/einwilligung-bildnutzung` |
| `N8N_WEBHOOK_SECRET` | gemeinsames Secret; Header `X-Webhook-Secret` |
| `H2_DB_PATH` | H2-Datei **ohne** `.mv.db`-Suffix |
| `H2_JDBC_JAR` | Pfad zur `h2-*.jar` |
| `FLUSH_OUTBOX_ON_START` | optional `1` = vor Start nur Outbox flushen (Default `0`) |
| `EXIT_H2_SETTLE_SECONDS` | Pause nach Exit vor H2-Öffnen (Default `2`) |

Keine echten Secrets ins Git committen.

## Launcher — einmal Shortcut, danach automatisch

Primärweg: **nicht** `jameica.exe` / `jameica.sh` direkt starten, sondern den Launcher. Nach **Datei → Beenden** folgt der Sync von allein.

### Windows (einmalig)

1. `.env` mit `JAMEICA_BIN=…\jameica.exe` (und H2/n8n) füllen.
2. Desktop-Verknüpfung erzeugen:

```powershell
.\launcher\create-desktop-shortcut.ps1
```

3. Die neue Verknüpfung (**„Jameica (OpenJVerein Sync)“**) ins Startmenü / Taskleiste **pinnen**.
4. Ab jetzt nur noch diese Verknüpfung nutzen — nicht die nackte `jameica.exe`.

Manuell: Verknüpfung auf `launcher\jameica-launcher.cmd`, Arbeitsverzeichnis = Repo-Root.

### Linux

```bash
./launcher/jameica-launcher.sh
# optional Argumente an Jameica:
./launcher/jameica-launcher.sh --irgendwas
```

Einmalig: Desktop-Entry / Menüeintrag / Alias auf dieses Skript legen und statt Roh-`jameica.sh` nutzen.

Details: [`launcher/README.md`](launcher/README.md).

### Ablauf

| Zeitpunkt | Aktion |
|-----------|--------|
| Start über Launcher | Jameica wie gewohnt |
| Nach Exit | `export-trigger exit` → Full-Export + Outbox-Retry → n8n |

### Fallback (manuell)

Nur wenn der Launcher nicht genutzt wurde:

```bash
./scripts/export-trigger.sh exit
# Windows: scripts\export-trigger.cmd exit
python exporter/export.py --trigger jameica_exit
```

Ordner-Watcher: bewusst **nicht** im MVP.

## Jameica-Scripting: nicht für Sync

Scripting mit Java-Interop hängt beim Load (`ScriptingService.eval`) — bestätigt: leere `.js` startet, Hook-Code nicht. Deshalb:

- Sync **nur** über Launcher / `export-trigger`, **nicht** über registrierte Scripts.
- `scripts/jameica-openjverein-sync.js` ist Kommentar-only und **soll nicht** unter Einstellungen → Scripting stehen.
- `minimal.js` nur zur Hang-Diagnose nach Recovery.

### Falls Jameica noch wegen alter Sync-`.js` hängt

1. Jameica / hängende Kinder beenden.
2. Workdir: Windows `%USERPROFILE%\.jameica\`, Linux `~/.jameica/`, macOS oft `~/Library/jameica/`.
3. In `cfg/de.willuhn.jameica.services.ScriptingService.properties` Zeilen `scripts.N=…jameica-openjverein-sync…` entfernen **oder** die `.js` umbenennen (`.bak`).
4. Jameica neu starten; Sync weiter nur über Launcher.

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

- Primärpfad: **Launcher** → Exit → Export. Kein Cron, kein Scripting-Hook.
- Filter „≥1 Einwilligung“ im Exporter; n8n als Sicherheitsnetz.
- Voraussetzungen: Jameica/OpenJVerein, Python 3.10+, Java (JayDeBeApi/H2-JAR), erreichbares n8n.
