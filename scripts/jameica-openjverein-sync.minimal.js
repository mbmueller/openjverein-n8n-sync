/**
 * Diagnose-Skript: hängt Jameica schon bei einem nahezu leeren Custom-Script?
 *
 * Test:
 *   1. Recovery (README): alte Sync-.js aus ScriptingService.properties entfernen /
 *      umbenennen, damit Jameica wieder startet.
 *   2. Diese Datei unter Datei → Einstellungen → Scripting registrieren.
 *   3. Jameica neu starten.
 *
 * Ergebnis:
 *   - Start OK → ScriptingService.eval an sich funktioniert; Problem liegt in der
 *     Sync-.js (Java-Interop / MessageConsumer beim Laden).
 *   - Start hängt weiter → bereits *irgendein* registriertes Custom-Script bzw.
 *     die Engine ist problematisch → Sync nicht über Scripting, sondern per
 *     export-trigger / Shortcut nach Exit (siehe README).
 *
 * Absichtlich: kein Packages, kein Java.type, kein events.add, kein I/O.
 */

function openjvereinMinimalNoop() {
  /* no-op — nur vorhanden, damit die Datei eine gültige JS-Funktion hat */
}
