/**
 * NICHT für Sync verwendet.
 *
 * Jameica Scripting mit Java-Interop (Packages / Java.type / MessageConsumer)
 * hängt beim ScriptingService.eval — bestätigt: leere .js startet, unser Hook nicht.
 * SYSTEM_SHUTDOWN lässt sich so nicht sicher registrieren.
 *
 * Sync-Pfad: launcher/ (startet Jameica, nach Exit → export-trigger).
 * Diese Datei nicht unter Einstellungen → Scripting registrieren.
 * Falls noch registriert: No-Op (nur Kommentar) — Sync läuft trotzdem nur über den Launcher.
 *
 * Diagnose alter Hänger: jameica-openjverein-sync.minimal.js + README Recovery.
 */
