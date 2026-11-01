/**
 * OpenJVerein → n8n Sync — Jameica Scripting-Hook (ohne Launcher).
 *
 * Wichtig (Hang-Ursache): MessageConsumer via Java.extend / JavaAdapter beim
 * ScriptingService.eval blockiert den Start. Shutdown hier über
 * Runtime.addShutdownHook (deferred), Export nur detached (kein waitFor).
 *
 * Rhino/Nashorn: globales `events` (ScriptingService$Events) NICHT als JS-Wert
 * behandeln — kein `var e = events`, kein `if (events)`, kein Wrap/Return.
 * Wahrheitstest wirft: InternalError: Invalid JavaScript value of type
 * …ScriptingService$Events. Dieser Sync-Pfad braucht events nicht.
 *
 * Datei→Beenden: Application.shutDown() sendet SYSTEM_SHUTDOWN, schließt den
 * Logger und ruft System.exit(0) → JVM-Shutdown-Hooks laufen. events.* bekommt
 * SYSTEM_SHUTDOWN nicht. Logger im Hook ist oft schon geschlossen → Marker unter
 * %TEMP%/$TMPDIR sind der Beweis.
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

/* global Java, Packages */

/**
 * Absoluter Pfad zum Repo — oder Umgebungsvariable OPENJVEREIN_N8N_SYNC_ROOT.
 * Leer lassen = ENV nutzen; beides leer → root-fail.txt, Hook trotzdem registriert.
 */
var SYNC_ROOT = "";

/**
 * true = nach Boot Outbox flushen (detached + Delay).
 * Full-Export / Webhook nur beim JVM-Shutdown (Datei→Beenden).
 * Start sendet absichtlich keinen Full-Export.
 */
var ENABLE_START_OUTBOX_FLUSH = false;

/** Delay bevor Start-Outbox / Shutdown-Hook-Registrierung (ms). */
var BOOT_DEFER_MS = 2000;

var HOOK_PROP = "ojv.n8n.sync.shutdown.hook";
var DIAG_PREFIX = "ojv-n8n-sync-";

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
  } catch (e) { /* Logger oft schon geschlossen im Shutdown-Hook */ }
}

/**
 * Sichtbare Diagnose ohne PII: Timestamp-Marker unter java.io.tmpdir
 * und optional <SYNC_ROOT>/logs/ (wenn Root bekannt).
 */
function _diag(basename, text) {
  var System = _javaType("java.lang.System");
  var File = _javaType("java.io.File");
  var FileWriter = _javaType("java.io.FileWriter");
  var when = String(new Date());
  var body = String(text || "") + "\n" + when + "\n";
  var written = [];

  function writeOne(dir, name) {
    if (!dir) {
      return;
    }
    try {
      var d = new File(String(dir));
      if (!d.exists()) {
        d.mkdirs();
      }
      var f = new File(d, name);
      var w = new FileWriter(f, false);
      try {
        w.write(body);
      } finally {
        w.close();
      }
      written.push(f.getAbsolutePath());
    } catch (e) { /* ignore single target */ }
  }

  try {
    writeOne(System.getProperty("java.io.tmpdir"), basename);
  } catch (e1) { /* ignore */ }

  try {
    var root = _peekRoot();
    if (root) {
      writeOne(new File(root, "logs").getAbsolutePath(), basename);
    }
  } catch (e2) { /* ignore */ }

  if (written.length > 0) {
    _log("diag: " + basename + " → " + written.join(" | "));
  } else {
    _log("diag failed: " + basename);
  }
}

/** Root ohne Throw — für Marker; leer wenn unset/ungültig. */
function _peekRoot() {
  try {
    var System = _javaType("java.lang.System");
    var File = _javaType("java.io.File");
    var env = System.getenv("OPENJVEREIN_N8N_SYNC_ROOT");
    var root = (env && String(env).length > 0) ? String(env) : String(SYNC_ROOT || "");
    if (!root || root.length === 0) {
      return "";
    }
    var f = new File(root);
    if (!f.isDirectory()) {
      return "";
    }
    return f.getAbsolutePath();
  } catch (e) {
    return "";
  }
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

function _diagLogPath(root) {
  var File = _javaType("java.io.File");
  var logs = new File(root, "logs");
  try {
    logs.mkdirs();
  } catch (e) { /* ignore */ }
  return new File(logs, "export-trigger-spawn.log").getAbsolutePath();
}

/**
 * Startet export-trigger detached (kein waitFor). Überlebt JVM-Exit.
 * stdout/stderr → logs/export-trigger-spawn.log (nicht /dev/null).
 * @param {string} mode "start" | "exit"
 */
function spawnExport(mode) {
  var File = _javaType("java.io.File");
  var ProcessBuilder = _javaType("java.lang.ProcessBuilder");
  var root;
  try {
    root = _resolveRoot();
  } catch (rootErr) {
    _diag(DIAG_PREFIX + "spawn-fail.txt", "spawn skip: " + rootErr);
    throw rootErr;
  }

  var win = _isWindows();
  var trigger = new File(root, win ? "scripts\\export-trigger.cmd" : "scripts/export-trigger.sh");
  if (!trigger.isFile()) {
    var miss = "export-trigger nicht gefunden: " + trigger.getAbsolutePath();
    _diag(DIAG_PREFIX + "spawn-fail.txt", miss);
    throw new Error(miss);
  }

  var pidArg = "";
  if (mode === "exit") {
    var cur = _currentPid();
    if (cur) {
      pidArg = String(cur);
    }
  }

  var logFile = _diagLogPath(root);
  var cmd = _newStringList();
  if (win) {
    var inner = "\"" + trigger.getAbsolutePath() + "\" " + mode;
    if (pidArg) {
      inner += " " + pidArg;
    }
    // start /B detached; Ausgabe anhängen
    cmd.add("cmd.exe");
    cmd.add("/c");
    cmd.add("start \"\" /B cmd.exe /c " + inner + " >> \"" + logFile + "\" 2>&1");
  } else {
    var shellCmd = "nohup \"" + trigger.getAbsolutePath() + "\" " + mode;
    if (pidArg) {
      shellCmd += " " + pidArg;
    }
    shellCmd += " >> \"" + logFile + "\" 2>&1 &";
    cmd.add("/bin/bash");
    cmd.add("-c");
    cmd.add(shellCmd);
  }

  _diag(
    DIAG_PREFIX + "spawn-" + mode + ".txt",
    "spawn mode=" + mode + " root=" + root + " waitPid=" + (pidArg || "-") + " log=" + logFile
  );

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
  _log("detached: mode=" + mode + (pidArg ? (" waitPid=" + pidArg) : "") + " log=" + logFile);
}

function onJameicaStartOutbox() {
  if (!ENABLE_START_OUTBOX_FLUSH) {
    _diag(
      DIAG_PREFIX + "start-skipped.txt",
      "ENABLE_START_OUTBOX_FLUSH=false — kein Start-Webhook/Outbox (Absicht)"
    );
    return;
  }
  try {
    spawnExport("start");
  } catch (e) {
    _diag(DIAG_PREFIX + "spawn-fail.txt", "start spawn: " + e);
    _log("Start-Outbox fehlgeschlagen: " + e);
  }
}

function onJameicaShutdownExport() {
  _diag(DIAG_PREFIX + "shutdown-hook-fired.txt", "Runtime shutdown hook fired — spawning exit export");
  try {
    spawnExport("exit");
  } catch (e) {
    _diag(DIAG_PREFIX + "spawn-fail.txt", "exit spawn: " + e);
    _log("Exit-Sync fehlgeschlagen: " + e);
  }
}

function _registerShutdownHookNow() {
  var System = _javaType("java.lang.System");
  if (String(System.getProperty(HOOK_PROP) || "") === "1") {
    _log("shutdown hook already registered — skip");
    _diag(DIAG_PREFIX + "hook-already.txt", "shutdown hook already registered");
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
  _diag(DIAG_PREFIX + "hook-registered.txt", "Runtime.addShutdownHook registered (exit export)");
  _log("Runtime.addShutdownHook registered (exit export)");
}

/**
 * Alles Schwere nach Eval: Hook + optional Start-Outbox.
 * Kein MessageConsumer — das hing beim Start.
 * Hook wird auch bei fehlendem SYNC_ROOT registriert (Diagnose Quit-Pfad);
 * Spawn schreibt dann spawn-fail.txt.
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
      try {
        var root = _resolveRoot();
        _diag(DIAG_PREFIX + "root-ok.txt", "SYNC_ROOT ok: " + root);
      } catch (rootErr) {
        _diag(DIAG_PREFIX + "root-fail.txt", String(rootErr));
        _log("SYNC_ROOT fehlt/ungültig — Hook trotzdem registrieren: " + rootErr);
      }
      _registerShutdownHookNow();
      onJameicaStartOutbox();
    } catch (e) {
      _diag(DIAG_PREFIX + "boot-fail.txt", "deferred boot failed: " + e);
      _log("deferred boot failed: " + e);
    }
  });
  runner.setName("ojv-n8n-sync-boot");
  runner.setDaemon(true);
  runner.start();
}

// --- Bootstrap: nur deferred Thread → Runtime.addShutdownHook (kein events) ---
try {
  _diag(DIAG_PREFIX + "eval.txt", "script eval ok (bootstrap)");
  // Absichtlich kein events.* — Rhino wirft bei Truthiness/Assign auf
  // ScriptingService$Events (eval-fail: Invalid JavaScript value …Events).
  _log("script loaded — registering hook deferred (" + BOOT_DEFER_MS + "ms)");
  _deferredBoot();
} catch (bootErr) {
  try {
    _diag(DIAG_PREFIX + "eval-fail.txt", "Bootstrap fehlgeschlagen: " + bootErr);
  } catch (e2) { /* ignore */ }
  _log("Bootstrap fehlgeschlagen: " + bootErr);
}
