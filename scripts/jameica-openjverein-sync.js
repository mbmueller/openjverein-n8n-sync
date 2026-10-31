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
 *   - Beim Start / SYSTEM_STARTED / Script-Eval: ABSOLUT NICHTS synchronisieren —
 *     kein Outbox-Flush, kein Process-Spawn, kein Extra-Thread, kein File-I/O.
 *     Nur Registrierung eines SYSTEM_SHUTDOWN-Consumers (schnell).
 *   - Full-Export ausschließlich bei sauberem Beenden (SYSTEM_SHUTDOWN),
 *     ProcessBuilder ohne waitFor (detached; wartet außerhalb von Jameica).
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
 * Nur für Exit gedacht. Kein Runtime.exec mit Warte-Schleife, kein sync HTTP.
 * @param {string} mode derzeit nur "exit"
 */
function spawnExportDetached(mode) {
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
  // Nur starten — niemals waitFor / inheritIO / busy-loop / Runtime.exec+wait
  var proc = pb.start();
  try {
    proc.getInputStream().close();
    proc.getErrorStream().close();
    proc.getOutputStream().close();
  } catch (closeErr) { /* ignore */ }
  _log("detached gestartet: mode=" + mode + (pidArg ? (" waitPid=" + pidArg) : ""));
}

/**
 * SYSTEM_SHUTDOWN: Export detached anstoßen und sofort zurückkehren
 * (Jameica-Shutdown-Pfad nicht blockieren).
 */
function onJameicaShutdown(message) {
  try {
    var SystemMessage = _javaType("de.willuhn.jameica.messaging.SystemMessage");
    if (message && message.getStatusCode && message.getStatusCode() !== SystemMessage.SYSTEM_SHUTDOWN) {
      return;
    }
    spawnExportDetached("exit");
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
  _log("SYSTEM_SHUTDOWN-Consumer registriert (kein Start-Sync)");
}

// --- Bootstrap (ScriptingService.eval läuft synchron nach SYSTEM_STARTED) ---
// Kritisch: hier KEIN Sync, KEIN Spawn, KEIN Thread, KEIN File-I/O.
// Nur MessageConsumer-Registrierung — sonst hängt Jameica vor der UI.
try {
  registerShutdownConsumer();
  if (typeof events !== "undefined" && events && events.add) {
    events.add("openjverein.n8n.sync.exit", "onJameicaShutdown");
  }
  _log("Hook aktiv — Sync nur bei Exit; Start = no-op");
} catch (bootErr) {
  _log("Bootstrap fehlgeschlagen: " + bootErr);
}
