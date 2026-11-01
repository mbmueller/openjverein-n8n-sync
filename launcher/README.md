# Launcher (Primärpfad)

Dünner Starter: **Jameica starten → auf Prozessende warten → `export-trigger exit`**.  
Jameica-UI unverändert; nur der Startweg wechselt. Kein Cron. Kein Scripting-Hook.

## Einmal einrichten

1. Repo klonen, `.env` aus `.env.example` — mindestens `JAMEICA_BIN`, `H2_*`, `N8N_*`.
2. **Windows:** Desktop-Verknüpfung erzeugen und **diese** pinnen / nutzen:

   ```powershell
   .\launcher\create-desktop-shortcut.ps1
   ```

   Oder manuell Verknüpfung auf `launcher\jameica-launcher.cmd` (Arbeitsverzeichnis = Repo-Root).

3. **Linux:** Alias, Desktop-Entry oder Startmenü-Eintrag auf:

   ```bash
   /path/to/openjverein-n8n-sync/launcher/jameica-launcher.sh
   ```

4. Ab jetzt **nicht** mehr `jameica.exe` / `jameica.sh` direkt starten — sonst kein Auto-Export.

## Ablauf

| Zeitpunkt | Aktion |
|-----------|--------|
| Start | Jameica wie gewohnt (optional Outbox-Flush wenn `FLUSH_OUTBOX_ON_START=1`) |
| Nach **Datei → Beenden** | Launcher ruft `scripts/export-trigger … exit` → H2-Export → n8n |

## Fallback

Wenn der Launcher nicht passt: nach manuellem Jameica-Ende `scripts/export-trigger.cmd exit` (bzw. `.sh`).  
Ordner-Watcher: bewusst nicht im MVP.  
Jameica-Scripting: **nicht** für Sync — siehe Haupt-README.
