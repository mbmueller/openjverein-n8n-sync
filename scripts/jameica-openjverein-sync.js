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
 *   1. Repo klonen, .env füllen, SYNC_ROOT unten setzen (Jameica hat oft keine ENV).
 *   2. Jameica normal starten (kein Launcher/Wrapper).
 *   3. Datei → Einstellungen → Scripting → diese Datei hinzufügen → Speichern.
 *   4. Neu starten; sauber beenden (Datei → Beenden) → Exit-Export.
 *
 * Kill/Absturz: Hook bleibt aus → Drive behält letzten erfolgreichen Sync (OK).
 * Kein Cron. Keine personenbezogenen Pfade im Repo.
 */

/* global Java, Packages, __FILE__, __DIR__ */

// =============================================================================
// CONFIG — Marlon: SYNC_ROOT hier setzen (Jameica bekommt meist keine ENV)
// =============================================================================
/**
 * Absoluter Pfad zum geklonten Repo. Platzhalter ersetzen.
 * Windows: Backslashes verdoppeln, z. B. "C:\\Users\\…\\openjverein-n8n-sync"
 * Linux/macOS: "/home/…/openjverein-n8n-sync"
 *
 * Fallback-Reihenfolge: ENV OPENJVEREIN_N8N_SYNC_ROOT → dieser Wert →
 * Parent von scripts/, falls Scripting den registrierten .js-Pfad liefert.
 * Platzhalter/leer → root-fail.txt (Hook registriert sich trotzdem).
 */
var SYNC_ROOT = "C:\\path\\to\\openjverein-n8n-sync";

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

/** Platzhalter oder leer — gilt als „nicht gesetzt“. */
function _isUnsetRoot(value) {
  var s = String(value || "").replace(/^\s+|\s+$/g, "");
  if (!s) {
    return true;
  }
  var lower = s.toLowerCase();
  return (
    lower.indexOf("\\path\\to\\openjverein") >= 0 ||
    lower.indexOf("/path/to/openjverein") >= 0 ||
    lower === "c:\\path\\to\\openjverein-n8n-sync"
  );
}

/**
 * Repo-Root aus registriertem Script-Pfad ableiten (…/scripts/jameica-openjverein-sync.js → …/).
 * Nutzt __FILE__/__DIR__ wenn die Engine sie setzt, sonst ScriptingService.getScripts()
 * bzw. Settings scripts.N (falls Scripting den Pfad exponiert).
 */
function _guessRootFromScript() {
  var File = _javaType("java.io.File");
  var scriptCandidates = [];

  try {
    if (typeof __DIR__ !== "undefined" && __DIR__) {
      scriptCandidates.push(new File(String(__DIR__), "jameica-openjverein-sync.js"));
    }
  } catch (eDir) { /* optional */ }

  try {
    if (typeof __FILE__ !== "undefined" && __FILE__) {
      scriptCandidates.push(new File(String(__FILE__)));
    }
  } catch (eFile) { /* optional */ }

  try {
    var Application = _javaType("de.willuhn.jameica.system.Application");
    var ScriptingService = _javaType("de.willuhn.jameica.services.ScriptingService");
    var svc = Application.getBootLoader().getBootable(ScriptingService);
    if (svc) {
      var files = svc.getScripts();
      if (files) {
        var it = files.iterator();
        while (it.hasNext()) {
          scriptCandidates.push(it.next());
        }
      }
    }
  } catch (eSvc) { /* Scripting API nicht erreichbar */ }

  try {
    var Settings = _javaType("de.willuhn.jameica.system.Settings");
    var settings = new Settings(_javaType("de.willuhn.jameica.services.ScriptingService"));
    // getList ohne Default-Array: manche Settings-Impls liefern null/leer
    var list = null;
    try {
      list = settings.getList("scripts", null);
    } catch (eNull) {
      try {
        var ArrayCls = _javaType("java.lang.reflect.Array");
        var StringCls = _javaType("java.lang.String");
        list = settings.getList("scripts", ArrayCls.newInstance(StringCls, 0));
      } catch (eArr) { /* skip */ }
    }
    if (list) {
      var platform = null;
      try {
        platform = _javaType("de.willuhn.jameica.system.Application").getPlatform();
      } catch (ePlat) { /* ignore */ }
      for (var i = 0; i < list.length; i++) {
        var raw = list[i];
        if (!raw) {
          continue;
        }
        var abs = String(raw);
        try {
          if (platform) {
            abs = String(platform.toAbsolute(abs));
          }
        } catch (eAbs) { /* keep raw */ }
        scriptCandidates.push(new File(abs));
      }
    }
  } catch (eSet) { /* Settings optional */ }

  for (var c = 0; c < scriptCandidates.length; c++) {
    try {
      var sf = scriptCandidates[c];
      if (!sf) {
        continue;
      }
      var name = String(sf.getName() || "").toLowerCase();
      if (name.indexOf("jameica-openjverein-sync") < 0) {
        continue;
      }
      if (!sf.isFile()) {
        continue;
      }
      var scriptsDir = sf.getParentFile();
      if (!scriptsDir) {
        continue;
      }
      var root = scriptsDir.getParentFile();
      if (root && root.isDirectory() && _rootLooksValid(root)) {
        return root.getAbsolutePath();
      }
    } catch (eOne) { /* next candidate */ }
  }
  return "";
}

/** Plausibel: scripts/export-trigger.(cmd|sh) liegt unter dem Root. */
function _rootLooksValid(rootFile) {
  try {
    var File = _javaType("java.io.File");
    var scripts = new File(rootFile, "scripts");
    if (!scripts.isDirectory()) {
      return false;
    }
    var cmd = new File(scripts, "export-trigger.cmd");
    var sh = new File(scripts, "export-trigger.sh");
    return cmd.isFile() || sh.isFile();
  } catch (e) {
    return false;
  }
}

/** Konfigurierten/geratenen Root-String (noch ohne Directory-Check). */
function _configuredRootString() {
  var System = _javaType("java.lang.System");
  try {
    var env = System.getenv("OPENJVEREIN_N8N_SYNC_ROOT");
    if (env && !_isUnsetRoot(env)) {
      return String(env).replace(/^\s+|\s+$/g, "");
    }
  } catch (eEnv) { /* ignore */ }

  var cfg = String(SYNC_ROOT || "");
  if (!_isUnsetRoot(cfg)) {
    return cfg.replace(/^\s+|\s+$/g, "");
  }

  return _guessRootFromScript();
}

function _rootHint() {
  return (
    "SYNC_ROOT in scripts/jameica-openjverein-sync.js oben setzen " +
    '(z. B. SYNC_ROOT = "C:\\\\Pfad\\\\zu\\\\openjverein-n8n-sync") — ' +
    "Jameica hat oft keine ENV; ohne Root kein export-trigger / kein Webhook."
  );
}

/** Root ohne Throw — für Marker; leer wenn unset/ungültig. */
function _peekRoot() {
  try {
    var File = _javaType("java.io.File");
    var root = _configuredRootString();
    if (!root) {
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
  var File = _javaType("java.io.File");
  var root = _configuredRootString();
  if (!root) {
    throw new Error(
      "SYNC_ROOT / OPENJVEREIN_N8N_SYNC_ROOT fehlt oder ist noch der Platzhalter. " +
      _rootHint()
    );
  }
  var f = new File(root);
  if (!f.isDirectory()) {
    throw new Error(
      "SYNC_ROOT ist kein Verzeichnis: " + root + " — " + _rootHint()
    );
  }
  return f.getAbsolutePath();
}

/** Windows: scripts/export-trigger.cmd; sonst .sh — via File-Segmente (kein Separator-Rätsel). */
function _resolveTrigger(root) {
  var File = _javaType("java.io.File");
  var win = _isWindows();
  var scripts = new File(root, "scripts");
  var primary = new File(scripts, win ? "export-trigger.cmd" : "export-trigger.sh");
  if (primary.isFile()) {
    return primary;
  }
  var fallback = new File(scripts, win ? "export-trigger.sh" : "export-trigger.cmd");
  if (fallback.isFile()) {
    return fallback;
  }
  return primary;
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
    _diag(
      DIAG_PREFIX + "spawn-fail.txt",
      "spawn-fail mode=" + mode + " reason=no-sync-root detail=" + rootErr +
        " fix=" + _rootHint()
    );
    throw rootErr;
  }

  var win = _isWindows();
  var trigger = _resolveTrigger(root);
  if (!trigger.isFile()) {
    var miss =
      "spawn-fail mode=" + mode +
      " reason=export-trigger-missing path=" + trigger.getAbsolutePath() +
      " expected=" + (win ? "scripts\\\\export-trigger.cmd" : "scripts/export-trigger.sh") +
      " under SYNC_ROOT=" + root +
      " — Repo-Pfad prüfen; " + _rootHint();
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
  var triggerPath = trigger.getAbsolutePath();
  if (win) {
    var inner = "\"" + triggerPath + "\" " + mode;
    if (pidArg) {
      inner += " " + pidArg;
    }
    // start /B detached; Ausgabe anhängen — .cmd via cmd.exe
    cmd.add("cmd.exe");
    cmd.add("/c");
    cmd.add("start \"\" /B cmd.exe /c " + inner + " >> \"" + logFile + "\" 2>&1");
  } else {
    var shellCmd = "nohup \"" + triggerPath + "\" " + mode;
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
    "spawn mode=" + mode + " root=" + root + " trigger=" + triggerPath +
      " waitPid=" + (pidArg || "-") + " log=" + logFile
  );

  var pb = new ProcessBuilder(cmd);
  pb.directory(new File(root));
  pb.redirectErrorStream(true);
  try {
    var Redirect = _javaType("java.lang.ProcessBuilder$Redirect");
    pb.redirectOutput(Redirect.DISCARD);
    pb.redirectInput(Redirect.DISCARD);
  } catch (e) { /* ältere Java */ }
  try {
    var proc = pb.start();
    try {
      proc.getInputStream().close();
      proc.getErrorStream().close();
      proc.getOutputStream().close();
    } catch (closeErr) { /* ignore */ }
  } catch (startErr) {
    _diag(
      DIAG_PREFIX + "spawn-fail.txt",
      "spawn-fail mode=" + mode + " reason=process-start path=" + triggerPath +
        " detail=" + startErr
    );
    throw startErr;
  }
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
    // spawnExport schreibt bereits spawn-fail; hier nur Log
    _log("Start-Outbox fehlgeschlagen: " + e);
  }
}

function onJameicaShutdownExport() {
  _diag(DIAG_PREFIX + "shutdown-hook-fired.txt", "Runtime shutdown hook fired — spawning exit export");
  try {
    spawnExport("exit");
  } catch (e) {
    // spawnExport schreibt bereits spawn-fail mit Fix-Hinweis
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
        _diag(
          DIAG_PREFIX + "root-fail.txt",
          String(rootErr) + "\nfix=" + _rootHint()
        );
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
