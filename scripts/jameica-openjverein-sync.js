/**
 * OpenJVerein → n8n Sync — bewusst leer beim Scripting-Load.
 *
 * Befund: Eine leere/minimale .js startet Jameica. Jede Top-Level-Arbeit mit
 * Packages / Java.type / JavaAdapter / MessageConsumer (SYSTEM_SHUTDOWN)
 * hängt ScriptingService.eval nach SYSTEM_STARTED — auch ohne Start-Sync.
 *
 * Deshalb: diese Datei registriert bewusst KEINEN Shutdown-Consumer und führt
 * kein Java-Interop aus. Sync nur extern nach Jameica-Ende:
 *
 *   scripts/export-trigger.sh exit
 *   scripts\export-trigger.cmd exit
 *   oder wrapper/ / Desktop-Shortcut (siehe README)
 *
 * Diagnose: scripts/jameica-openjverein-sync.minimal.js
 * Recovery (hängende alte Version): README „Jameica hängt beim Start?“
 *
 * Diese Datei darf in Scripting stehen (No-Op) oder weggelassen werden —
 * der Exit-Export braucht sie nicht.
 */
