/**
 * Hello-World / Hang-Diagnose für Jameica Scripting (OpenJVerein-n8n-Sync).
 *
 * Ziel: beweisen, dass ein Script lädt OHNE Start-Hänger, und optional
 * Shutdown erkennt — OHNE MessageConsumer / Java.extend / JavaAdapter.
 *
 * Installation (Marlon):
 *   1. Alte Sync-.js aus Scripting entfernen (Recovery in README), sonst
 *      kann ein alter Hook den Start weiter blockieren.
 *   2. Jameica normal starten (kein Launcher).
 *   3. Datei → Einstellungen → Scripting → „Script hinzufügen…“
 *      → diese Datei wählen → Speichern.
 *   4. Jameica neu starten.
 *
 * Erwartet bei erfolgreichem Load:
 *   - Jameica-UI kommt hoch (kein Freeze).
 *   - Log-Zeile: [ojv-hello] loaded …
 *   - Marker: %TEMP%/ojv-hello-world-loaded.txt  (bzw. $TMPDIR/…)
 *
 * Erwartet bei sauberem Beenden (Datei → Beenden), wenn STAGE_SHUTDOWN_HOOK:
 *   - Log: [ojv-hello] shutdown hook …
 *   - Marker: %TEMP%/ojv-hello-world-shutdown.txt
 *
 * Stufen abschalten bei Diagnose (unten auf false):
 *   STAGE_EVENTS / STAGE_LOGGER / STAGE_MARKER_FILE / STAGE_SHUTDOWN_HOOK
 *
 * Kein Export, kein Cron, kein Launcher, keine personenbezogenen Pfade.
 */

/* global Java, Packages, events */

/** Community-Pattern: events.add — Hibiscus-Scripts machen das seit Jahren. */
var STAGE_EVENTS = true;

/** Logger via Packages — ebenfalls Community-Standard. */
var STAGE_LOGGER = true;

/** Marker-Datei unter java.io.tmpdir schreiben. */
var STAGE_MARKER_FILE = true;

/**
 * Runtime.addShutdownHook (NICHT MessageConsumer).
 * Wenn der Start trotzdem hängt: auf false setzen und neu testen.
 */
var STAGE_SHUTDOWN_HOOK = true;

/**
 * Hook erst nach Delay registrieren, damit ScriptingService.eval sofort
 * zurückkehrt (SYSTEM_STARTED-Handler nicht blockieren).
 * 0 = sofort im Eval-Pfad registrieren (nur wenn Delay-Variante ok war).
 */
var SHUTDOWN_HOOK_DEFERRED_MS = 1500;

var HELLO_PROP = "ojv.hello.world.hook.registered";

function _javaType(name) {
  try {
    if (typeof Java !== "undefined" && Java.type) {
      return Java.type(name);
    }
  } catch (e) { /* Rhino / älter */ }
  var parts = name.split(".");
  var obj = Packages;
  for (var i = 0; i < parts.length; i++) {
    obj = obj[parts[i]];
  }
  return obj;
}

function _log(msg) {
  if (!STAGE_LOGGER) {
    return;
  }
  try {
    var Logger = _javaType("de.willuhn.logging.Logger");
    Logger.info("[ojv-hello] " + msg);
  } catch (e) {
    // ignore — Marker-Datei reicht als Beweis
  }
}

function _writeMarker(basename, text) {
  if (!STAGE_MARKER_FILE) {
    return;
  }
  try {
    var System = _javaType("java.lang.System");
    var File = _javaType("java.io.File");
    var FileWriter = _javaType("java.io.FileWriter");
    var tmp = System.getProperty("java.io.tmpdir");
    var f = new File(tmp, basename);
    var w = new FileWriter(f);
    try {
      w.write(String(text));
    } finally {
      w.close();
    }
    _log("marker written: " + f.getAbsolutePath());
  } catch (e) {
    _log("marker failed: " + e);
  }
}

function ojvHelloWorld() {
  return "ojv-hello-ok";
}

function _onJvmShutdown() {
  var when = String(new Date());
  _log("shutdown hook fired at " + when);
  _writeMarker(
    "ojv-hello-world-shutdown.txt",
    "ojv-hello shutdown ok\n" + when + "\n"
  );
}

function _registerShutdownHookNow() {
  var System = _javaType("java.lang.System");
  if (String(System.getProperty(HELLO_PROP) || "") === "1") {
    _log("shutdown hook already registered — skip");
    return;
  }
  var Runtime = _javaType("java.lang.Runtime");
  var Thread = _javaType("java.lang.Thread");
  // JS-Funktion als Runnable (Rhino + Nashorn SAM) — kein MessageConsumer.
  var hook = new Thread(function () {
    try {
      _onJvmShutdown();
    } catch (e) {
      // Shutdown: Fehler schlucken
    }
  });
  hook.setName("ojv-hello-shutdown");
  Runtime.getRuntime().addShutdownHook(hook);
  System.setProperty(HELLO_PROP, "1");
  _log("Runtime.addShutdownHook registered");
}

function _scheduleShutdownHook() {
  if (!STAGE_SHUTDOWN_HOOK) {
    _log("STAGE_SHUTDOWN_HOOK=false — nur Load-Test");
    return;
  }
  var delay = SHUTDOWN_HOOK_DEFERRED_MS;
  if (!(delay > 0)) {
    _registerShutdownHookNow();
    return;
  }
  var Thread = _javaType("java.lang.Thread");
  var runner = new Thread(function () {
    try {
      Thread.sleep(delay);
      _registerShutdownHookNow();
    } catch (e) {
      _log("deferred hook register failed: " + e);
    }
  });
  runner.setName("ojv-hello-register");
  runner.setDaemon(true);
  runner.start();
  _log("shutdown hook scheduled in " + delay + "ms (non-blocking)");
}

// --- Bootstrap: bewusst leicht; kein ProcessBuilder, kein MessageConsumer ---
try {
  if (STAGE_EVENTS && typeof events !== "undefined" && events && events.add) {
    events.add("openjverein.n8n.sync.hello", "ojvHelloWorld");
  }
  _log("loaded (hello-world proof)");
  _writeMarker(
    "ojv-hello-world-loaded.txt",
    "ojv-hello loaded ok\n" + String(new Date()) + "\n"
  );
  _scheduleShutdownHook();
} catch (bootErr) {
  try {
    _log("bootstrap failed: " + bootErr);
  } catch (e2) { /* ignore */ }
}
