# Wrapper (zuverlässiger Fallback ohne Scripting-Eval)

**Empfohlen**, wenn Jameica-Scripting beim Start hängt oder Custom-Scripts unzuverlässig sind (siehe Haupt-README: Recovery + Test mit `minimal.js`).

Der Wrapper startet Jameica **blockierend** und ruft danach `scripts/export-trigger` mit `exit` auf — gleicher Export-Pfad wie ein Shortcut nach dem Beenden, nur in einem Launcher.

```bash
# Pfad zur Jameica-Binary in der Datei / Umgebung setzen
./wrapper/jameica-wrapper.sh
```

Windows: `wrapper\jameica-wrapper.cmd` / `.ps1`.

Optional bleibt die Sync-`.js` unter Einstellungen → Scripting **unregistriert**; Sync läuft trotzdem nach Exit über diesen Wrapper bzw. einen Desktop-Shortcut auf `export-trigger.cmd exit`.

Haupt-[README](../README.md): Abschnitte „Zuverlässiger Exit-Trigger“ und „Jameica hängt beim Start?“.
