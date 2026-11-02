/**
 * Nur Diagnose (Stufe unter hello-world.js): hängt Jameica schon bei
 * einem nahezu leeren Custom-Script ohne Packages?
 *
 * Test nach Recovery (README):
 *   1. Alte Sync-/Hello-.js aus ScriptingService.properties entfernen.
 *   2. Nur diese Datei registrieren → Start OK?
 *   3. Dann scripts/hello-world.js (Packages + Shutdown-Hook).
 *   4. Dann jameica-openjverein-sync.js (Exit-Export).
 *
 * Absichtlich: kein Packages, kein Java.type, kein events.add, kein I/O.
 */

function openjvereinMinimalNoop() {
  /* no-op */
}
