# OpenJVerein → n8n → Google Drive (Bildnutzungs-Einwilligungen)

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

Synchronisiert die Zusatzfelder **`insta`**, **`website`**, **`flyer`** (Ja/Nein) aus OpenJVerein nach Google Drive über einen n8n-Webhook.

**Lizenz:** [PolyForm Noncommercial 1.0.0](LICENSE) — frei nutzbar, änderbar und weitergebbar **nichtkommerziell**; **kein Verkauf** der Software. Details und Mitwirken: [CONTRIBUTING.md](CONTRIBUTING.md).

**Trigger:** nur beim **Start und/oder Exit** von Jameica (Wrapper). Kein Cron, kein Task Scheduler. Fehlgeschlagene Uploads landen in `outbox/` und werden beim **nächsten** Start/Exit erneut versucht.

## Architektur (kurz)

1. Wrapper startet Jameica (optional: Outbox flushen).
2. Nach sauberem Exit: Exporter liest H2 **readonly** (Datei entsperrt, kein `AUTO_SERVER`).
3. Filter: nur **aktive** Mitglieder (`austritt` leer) mit **mindestens einer** Einwilligung.
4. Schreibt `einwilligungen.json` + `.csv`, POSTet an n8n (`X-Webhook-Secret`).
5. n8n legt Dateien unter Drive `aktuell/` und datiertem `archiv/` ab (optional `meta/last-sync.json`).

Kill/Absturz/Stromausfall: Exit-Hook kann ausbleiben → Drive behält den **letzten erfolgreichen Sync**. Das ist **OK**.

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
# .env ausfüllen: N8N_*, JAMEICA_BIN, H2_DB_PATH, H2_JDBC_JAR
chmod +x wrapper/jameica-wrapper.sh
```

### Wichtige `.env`-Platzhalter

| Variable | Bedeutung |
|----------|-----------|
| `N8N_WEBHOOK_URL` | z. B. `https://<dein-n8n>/webhook/einwilligung-bildnutzung` |
| `N8N_WEBHOOK_SECRET` | gemeinsames Secret; Header `X-Webhook-Secret` |
| `JAMEICA_BIN` | Pfad zu `jameica.sh` / `.exe` |
| `H2_DB_PATH` | H2-Datei **ohne** `.mv.db`-Suffix |
| `H2_JDBC_JAR` | Pfad zur `h2-*.jar` |
| `FLUSH_OUTBOX_ON_START` | `1` = vor Start nur Outbox flushen |

Keine echten Secrets ins Git committen.

## Wrapper lokal nutzen

**Linux/macOS** — statt Jameica direkt den Wrapper starten:

```bash
./wrapper/jameica-wrapper.sh
# optional Argumente an Jameica durchreichen:
./wrapper/jameica-wrapper.sh --irgendwas
```

**Windows:**

```cmd
wrapper\jameica-wrapper.cmd
```

oder:

```powershell
.\wrapper\jameica-wrapper.ps1
```

Ablauf:

| Zeitpunkt | Aktion |
|-----------|--------|
| Vor Start (`FLUSH_OUTBOX_ON_START=1`) | Nur Outbox → n8n (H2 oft noch gesperrt) |
| Nach Exit | Full-Export aus H2 + Outbox-Retry + POST |

Exporter manuell (z. B. Test nach Exit, wenn Jameica bereits zu ist):

```bash
python exporter/export.py --trigger jameica_exit
python exporter/export.py --flush-only   # nur Outbox
```

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
- Filter „≥1 Einwilligung“ sitzt im Exporter; n8n wiederholt ihn als Sicherheitsnetz.
- Kein täglicher Zeitplan: Sync und Outbox-Retry nur über den Wrapper bei Start/Exit.
