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
 *   - Beim Start (Script wird nach SYSTEM_STARTED geladen): Outbox flushen.
 *   - Beim sauberen Beenden (SYSTEM_SHUTDOWN): detachter Exit-Export
 *     (wartet auf Prozessende, dann H2 readonly → JSON/CSV → n8n).
 *
 * Kill/Absturz: Exit-Hook bleibt aus → Drive behält letzten erfolgreichen Sync (OK).
 * Kein Cron / kein Task Scheduler.
 */

/* global Java, Packages, events */

var SYNC_ROOT = ""; // z. B. "/home/verein/openjverein-n8n-sync"  — oder leer lassen und ENV nutzen

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

/**
 * Startet export-trigger detached (überlebt Jameica-Exit).
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

  var cmd;
  var pidArg = "";
  if (mode === "exit") {
    var cur = _currentPid();
    if (cur) {
      pidArg = String(cur);
    }
  }

  if (win) {
    // start /B: Kindprozess überlebt das Beenden von Jameica
    var line = "start \"ojv-n8n-sync\" /B \"\" \"" + trigger.getAbsolutePath() + "\" " + mode;
    if (pidArg) {
      line += " " + pidArg;
    }
    cmd = ["cmd.exe", "/c", line];
  } else {
    // nohup + Hintergrund: Prozess überlebt JVM-Exit
    var shellCmd = "nohup '" + trigger.getAbsolutePath() + "' " + mode;
    if (pidArg) {
      shellCmd += " " + pidArg;
    }
    shellCmd += " >/dev/null 2>&1 &";
    cmd = ["/bin/bash", "-c", shellCmd];
  }

  var pb = new ProcessBuilder(cmd);
  pb.directory(new File(root));
  pb.redirectErrorStream(true);
  try {
    var Redirect = _javaType("java.lang.ProcessBuilder$Redirect");
    pb.redirectOutput(Redirect.DISCARD);
  } catch (e) {
    // ältere Java: Output nicht umleiten
  }
  pb.start();
  _log("gestartet: mode=" + mode + (pidArg ? (" waitPid=" + pidArg) : ""));
}

function onJameicaStart() {
  try {
    spawnExport("start");
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

// --- Bootstrap (wird beim Laden des Scripts nach Jameica-Start ausgeführt) ---
try {
  _resolveRoot(); // früh failen mit klarer Meldung
  onJameicaStart();
  registerShutdownConsumer();
  // optional: falls Plugins Events feuern — reserviert für Erweiterungen
  if (typeof events !== "undefined" && events && events.add) {
    events.add("openjverein.n8n.sync.start", "onJameicaStart");
    events.add("openjverein.n8n.sync.exit", "onJameicaShutdown");
  }
  _log("Hook aktiv (Jameica Scripting)");
} catch (bootErr) {
  _log("Bootstrap fehlgeschlagen: " + bootErr);
}
