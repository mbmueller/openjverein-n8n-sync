/**
 * Nur Diagnose (nicht Sync): hängt Jameica schon bei einem nahezu leeren Custom-Script?
 *
 * Sync läuft über launcher/ — Scripting nicht nutzen.
 *
 * Test nach Recovery (README):
 *   1. Alte Sync-.js aus ScriptingService.properties entfernen / umbenennen.
 *   2. Optional nur diese Datei registrieren.
 *   3. Start OK → Eval an sich ok; Hang kam vom früheren Java-Interop.
 *   4. Script wieder entfernen; weiter mit launcher/.
 *
 * Absichtlich: kein Packages, kein Java.type, kein events.add, kein I/O.
 */

function openjvereinMinimalNoop() {
  /* no-op */
}
