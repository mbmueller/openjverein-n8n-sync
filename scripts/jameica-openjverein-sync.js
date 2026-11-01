/**
 * OpenJVerein → n8n Sync — Jameica Scripting-Hook (ohne Launcher).
 *
 * Wichtig (Hang-Ursache): MessageConsumer via Java.extend / JavaAdapter beim
 * ScriptingService.eval blockiert den Start. Community-Scripts nutzen
 * Packages + events.add — das ist ok. Shutdown hier über
 * Runtime.addShutdownHook (deferred), Export nur detached (kein waitFor).
 *
 * Vor dem ersten Sync-Test: scripts/hello-world.js erfolgreich laden
 * (siehe README). Alte Hook-Versionen aus Scripting entfernen (Recovery).
 *
 * Installation:
 *   1. Repo klonen, .env füllen, SYNC_ROOT unten oder ENV setzen.
 *   2. Jameica normal starten (kein Launcher/Wrapper).
 *   3. Datei → Einstellungen → Scripting → diese Datei hinzufügen → Speichern.
 *   4. Neu starten; sauber beenden (Datei → Beenden) → Exit-Export.
 *
 * Kill/Absturz: Hook bleibt aus → Drive behält letzten erfolgreichen Sync (OK).
 * Kein Cron. Keine personenbezogenen Pfade im Repo.
 */

/* global Java, Packages, events */

/** Absoluter Pfad zum Repo — oder Umgebungsvariable OPENJVEREIN_N8N_SYNC_ROOT. */
var SYNC_ROOT = "";

/**
 * true = nach Boot Outbox flushen (detached + Delay).
 * Full-Export nur beim JVM-Shutdown.
 */
var ENABLE_START_OUTBOX_FLUSH = false;

/** Delay bevor Start-Outbox / Shutdown-Hook-Registrierung (ms). */
var BOOT_DEFER_MS = 2000;

var HOOK_PROP = "ojv.n8n.sync.shutdown.hook";

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

function _log(msg) {
  try {
    var Logger = _javaType("de.willuhn.logging.Logger");
    Logger.info("[openjverein-n8n-sync] " + msg);
  } catch (e) { /* ignore */ }
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

function _newStringList() {
  return new (_javaType("java.util.ArrayList"))();
}

/**
 * Startet export-trigger detached (kein waitFor). Überlebt JVM-Exit.
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
  } catch (e) { /* ältere Java */ }
  var proc = pb.start();
  try {
    proc.getInputStream().close();
    proc.getErrorStream().close();
    proc.getOutputStream().close();
  } catch (closeErr) { /* ignore */ }
  _log("detached: mode=" + mode + (pidArg ? (" waitPid=" + pidArg) : ""));
}

function onJameicaStartOutbox() {
  if (!ENABLE_START_OUTBOX_FLUSH) {
    return;
  }
  try {
    spawnExport("start");
  } catch (e) {
    _log("Start-Outbox fehlgeschlagen: " + e);
  }
}

function onJameicaShutdownExport() {
  try {
    spawnExport("exit");
  } catch (e) {
    _log("Exit-Sync fehlgeschlagen: " + e);
  }
}

function _registerShutdownHookNow() {
  var System = _javaType("java.lang.System");
  if (String(System.getProperty(HOOK_PROP) || "") === "1") {
    _log("shutdown hook already registered — skip");
    return;
  }
  var Runtime = _javaType("java.lang.Runtime");
  var Thread = _javaType("java.lang.Thread");
  var hook = new Thread(function () {
    try {
      onJameicaShutdownExport();
    } catch (e) { /* swallow */ }
  });
  hook.setName("ojv-n8n-sync-shutdown");
  Runtime.getRuntime().addShutdownHook(hook);
  System.setProperty(HOOK_PROP, "1");
  _log("Runtime.addShutdownHook registered (exit export)");
}

/**
 * Alles Schwere nach Eval: Hook + optional Start-Outbox.
 * Kein MessageConsumer — das hing beim Start.
 */
function _deferredBoot() {
  var Thread = _javaType("java.lang.Thread");
  var delay = BOOT_DEFER_MS;
  if (!(delay >= 0)) {
    delay = 2000;
  }
  var runner = new Thread(function () {
    try {
      if (delay > 0) {
        Thread.sleep(delay);
      }
      _resolveRoot();
      _registerShutdownHookNow();
      onJameicaStartOutbox();
    } catch (e) {
      _log("deferred boot failed: " + e);
    }
  });
  runner.setName("ojv-n8n-sync-boot");
  runner.setDaemon(true);
  runner.start();
}

// --- Bootstrap: nur events + deferred Thread (Eval kehrt sofort zurück) ---
try {
  if (typeof events !== "undefined" && events && events.add) {
    events.add("openjverein.n8n.sync.start", "onJameicaStartOutbox");
    events.add("openjverein.n8n.sync.exit", "onJameicaShutdownExport");
  }
  _log("script loaded — registering hook deferred (" + BOOT_DEFER_MS + "ms)");
  _deferredBoot();
} catch (bootErr) {
  _log("Bootstrap fehlgeschlagen: " + bootErr);
}
