/**
 * OpenJVerein → n8n Sync — Jameica Scripting-Hook
 *
 * Installation (einmalig):
 *   1. Dieses Repo lokal klonen und .env ausfüllen (siehe README).
 *   2. Unten SYNC_ROOT auf den absoluten Pfad zum Repo setzen
 *      (oder Umgebungsvariable OPENJVEREIN_N8N_SYNC_ROOT setzen).
 *   3. In Jameica: Datei → Einstellungen → Scripting → „Script hinzufügen…“
 *      → diese Datei auswählen → Speichern.
 *   4. Jameica wie gewohnt starten/beenden (kein Wrapper um die Binary nötig).
 *
 * Verhalten:
 *   - Beim Start: optional Outbox flushen — IMMER asynchron (Daemon-Thread +
 *     detached Prozess), nie auf dem Scripting-/UI-Thread warten.
 *   - Full-Export nur bei sauberem Beenden (SYSTEM_SHUTDOWN), detached
 *     (wartet außerhalb von Jameica auf PID-Ende → H2 readonly → n8n).
 *
 * Wenn Jameica beim Start hängt (alte Version dieses Scripts):
 *   Jameica beenden/killen, dann Dateisystem-Recovery laut README
 *   (ScriptingService.properties oder diese .js umbenennen).
 *
 * Kill/Absturz: Exit-Hook bleibt aus → Drive behält letzten erfolgreichen Sync (OK).
 * Kein Cron / kein Task Scheduler.
 */

/* global Java, Packages, events, JavaAdapter */

var SYNC_ROOT = ""; // z. B. "C:\\Users\\<username>\\openjverein-n8n-sync" oder "/home/verein/…"

/**
 * Start-Outbox: true = detached Retry nach Boot-Verzögerung; false = nur Exit-Export.
 * Full-Export läuft ohnehin nur beim Beenden — Start darf Jameica nie blockieren.
 */
var ENABLE_START_OUTBOX_FLUSH = true;

/** Millisekunden warten, bevor der Start-Outbox-Prozess gestartet wird (UI erst fertig booten). */
var START_OUTBOX_DELAY_MS = 5000;

function _javaType(name) {
  try {
    if (typeof Java !== "undefined" && Java.type) {
      return Java.type(name);
    }
  } catch (e) { /* fall through */ }
  var parts = name.split(".");
  var obj = Packages;
  for (var i = 0; i < parts.length; i++) {
    obj = obj[parts[i]];
  }
  return obj;
}

function _resolveRoot() {
  var System = _javaType("java.lang.System");
  var File = _javaType("java.io.File");
  var env = System.getenv("OPENJVEREIN_N8N_SYNC_ROOT");
  var root = (env && String(env).length > 0) ? String(env) : String(SYNC_ROOT || "");
  if (!root || root.length === 0) {
    throw new Error(
      "SYNC_ROOT / OPENJVEREIN_N8N_SYNC_ROOT nicht gesetzt. " +
      "Bitte in jameica-openjverein-sync.js oder als Umgebungsvariable den Repo-Pfad eintragen."
    );
  }
  var f = new File(root);
  if (!f.isDirectory()) {
    throw new Error("SYNC_ROOT ist kein Verzeichnis: " + root);
  }
  return f.getAbsolutePath();
}

function _isWindows() {
  var System = _javaType("java.lang.System");
  var os = String(System.getProperty("os.name") || "").toLowerCase();
  return os.indexOf("win") >= 0;
}

function _currentPid() {
  try {
    var ProcessHandle = _javaType("java.lang.ProcessHandle");
    return ProcessHandle.current().pid();
  } catch (e1) {
    try {
      var ManagementFactory = _javaType("java.lang.management.ManagementFactory");
      var name = String(ManagementFactory.getRuntimeMXBean().getName());
      var at = name.indexOf("@");
      return at > 0 ? name.substring(0, at) : name;
    } catch (e2) {
      return "";
    }
  }
}

function _log(msg) {
  try {
    var Logger = _javaType("de.willuhn.logging.Logger");
    Logger.info("[openjverein-n8n-sync] " + msg);
  } catch (e) {
    // ignore
  }
}

function _newStringList() {
  return new (_javaType("java.util.ArrayList"))();
}

/**
 * Startet export-trigger vollständig detached (kein waitFor, überlebt Jameica-Exit).
 * @param {string} mode "start" | "exit"
 */
function spawnExport(mode) {
  var File = _javaType("java.io.File");
  var ProcessBuilder = _javaType("java.lang.ProcessBuilder");
  var root = _resolveRoot();
  var win = _isWindows();
  var trigger = new File(root, win ? "scripts\\export-trigger.cmd" : "scripts/export-trigger.sh");
  if (!trigger.isFile()) {
    throw new Error("export-trigger nicht gefunden: " + trigger.getAbsolutePath());
  }

  var pidArg = "";
  if (mode === "exit") {
    var cur = _currentPid();
    if (cur) {
      pidArg = String(cur);
    }
  }

  var cmd = _newStringList();
  if (win) {
    // start "" /B: Fenster-Titel leer, sofort zurück — Kind überlebt Jameica-Ende.
    // Zweiter cmd /c: Argumente zuverlässig an die .cmd durchreichen.
    var inner = "\"" + trigger.getAbsolutePath() + "\" " + mode;
    if (pidArg) {
      inner += " " + pidArg;
    }
    cmd.add("cmd.exe");
    cmd.add("/c");
    cmd.add("start \"\" /B cmd.exe /c " + inner);
  } else {
    var shellCmd = "nohup \"" + trigger.getAbsolutePath() + "\" " + mode;
    if (pidArg) {
      shellCmd += " " + pidArg;
    }
    shellCmd += " >/dev/null 2>&1 &";
    cmd.add("/bin/bash");
    cmd.add("-c");
    cmd.add(shellCmd);
  }

  var pb = new ProcessBuilder(cmd);
  pb.directory(new File(root));
  pb.redirectErrorStream(true);
  try {
    var Redirect = _javaType("java.lang.ProcessBuilder$Redirect");
    pb.redirectOutput(Redirect.DISCARD);
    pb.redirectInput(Redirect.DISCARD);
  } catch (e) {
    // ältere Java: Output nicht umleiten
  }
  // Nur starten — niemals waitFor / inheritIO-Blockade
  var proc = pb.start();
  try {
    proc.getInputStream().close();
    proc.getErrorStream().close();
    proc.getOutputStream().close();
  } catch (closeErr) { /* ignore */ }
  _log("detached gestartet: mode=" + mode + (pidArg ? (" waitPid=" + pidArg) : ""));
}

/**
 * Plant Start-Outbox auf Daemon-Thread (ScriptingService.eval kehrt sofort zurück).
 */
function scheduleStartOutboxFlush() {
  if (!ENABLE_START_OUTBOX_FLUSH) {
    _log("Start-Outbox deaktiviert (ENABLE_START_OUTBOX_FLUSH=false) — Export nur bei Exit");
    return;
  }
  var Thread = _javaType("java.lang.Thread");
  var delay = START_OUTBOX_DELAY_MS;
  if (!(delay >= 0)) {
    delay = 5000;
  }
  var runner = new Thread(function () {
    try {
      if (delay > 0) {
        Thread.sleep(delay);
      }
      spawnExport("start");
    } catch (e) {
      _log("Start-Outbox fehlgeschlagen: " + e);
    }
  });
  runner.setName("ojv-n8n-sync-start");
  runner.setDaemon(true);
  runner.start();
  _log("Start-Outbox geplant in " + delay + "ms (non-blocking)");
}

function onJameicaStart() {
  try {
    scheduleStartOutboxFlush();
  } catch (e) {
    _log("Start-Sync fehlgeschlagen: " + e);
  }
}

function onJameicaShutdown(message) {
  try {
    var SystemMessage = _javaType("de.willuhn.jameica.messaging.SystemMessage");
    if (message && message.getStatusCode && message.getStatusCode() !== SystemMessage.SYSTEM_SHUTDOWN) {
      return;
    }
    // Detached ProcessBuilder — kein waitFor auf dem Shutdown-Thread
    spawnExport("exit");
  } catch (e) {
    _log("Exit-Sync fehlgeschlagen: " + e);
  }
}

function registerShutdownConsumer() {
  var Application = _javaType("de.willuhn.jameica.system.Application");
  var SystemMessage = _javaType("de.willuhn.jameica.messaging.SystemMessage");
  var MessageConsumer = _javaType("de.willuhn.jameica.messaging.MessageConsumer");

  function expectedTypes() {
    try {
      var Array = _javaType("java.lang.reflect.Array");
      var Class = _javaType("java.lang.Class");
      var arr = Array.newInstance(Class.class, 1);
      arr[0] = SystemMessage.class;
      return arr;
    } catch (e) {
      return [SystemMessage.class];
    }
  }

  var consumer;
  try {
    // Nashorn
    consumer = new (Java.extend(MessageConsumer, {
      autoRegister: function () { return false; },
      getExpectedMessageTypes: function () { return expectedTypes(); },
      handleMessage: function (message) {
        onJameicaShutdown(message);
      }
    }))();
  } catch (eNashorn) {
    // Rhino JavaAdapter
    consumer = new JavaAdapter(MessageConsumer, {
      autoRegister: function () { return false; },
      getExpectedMessageTypes: function () { return expectedTypes(); },
      handleMessage: function (message) {
        onJameicaShutdown(message);
      }
    });
  }

  Application.getMessagingFactory().registerMessageConsumer(consumer);
  _log("SYSTEM_SHUTDOWN-Consumer registriert");
}

// --- Bootstrap (ScriptingService.eval läuft synchron nach SYSTEM_STARTED) ---
// Wichtig: hier nichts blockieren — sonst hängt Jameica vor der UI.
try {
  _resolveRoot(); // früh failen mit klarer Meldung (schnell, kein I/O-Wait)
  registerShutdownConsumer(); // nur Registrierung, kein Export
  onJameicaStart();           // plant Daemon-Thread; kehrt sofort zurück
  if (typeof events !== "undefined" && events && events.add) {
    events.add("openjverein.n8n.sync.start", "onJameicaStart");
    events.add("openjverein.n8n.sync.exit", "onJameicaShutdown");
  }
  _log("Hook aktiv (non-blocking Start; Full-Export nur bei Exit)");
} catch (bootErr) {
  _log("Bootstrap fehlgeschlagen: " + bootErr);
}
