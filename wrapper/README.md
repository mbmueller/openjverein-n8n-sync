# Wrapper (optional / deprecated)

**Primärer Trigger ist Jameica Scripting** (`scripts/jameica-openjverein-sync.js`).  
Jameica wird **normal** gestartet — die Binary muss **nicht** gewrappt werden.

Die Dateien in diesem Ordner bleiben nur als **optionaler Fallback** (z. B. wenn die JavaScript-Engine fehlt oder Scripting deaktiviert ist). Sie starten Jameica blockierend und führen danach den Exporter aus.

```bash
# nur falls nötig — nicht der empfohlene Weg
./wrapper/jameica-wrapper.sh
```

Siehe Haupt-[README](../README.md) Abschnitt „Jameica-Script installieren“.
