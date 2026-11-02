# Primary launcher (Windows): start Jameica, wait for exit, then export-trigger.
# Pin/use this instead of raw jameica.exe — UI unchanged; sync runs after Beenden.
# No Task Scheduler / Cron. No Jameica Scripting.
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$JameicaArgs
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
$EnvFile = if ($env:ENV_FILE) { $env:ENV_FILE } else { Join-Path $RepoRoot ".env" }
$Trigger = Join-Path $RepoRoot "scripts\export-trigger.cmd"

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { return }
        $i = $line.IndexOf("=")
        if ($i -lt 1) { return }
        $name = $line.Substring(0, $i).Trim()
        $value = $line.Substring($i + 1).Trim()
        if ($value.StartsWith('"') -and $value.EndsWith('"')) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
        Set-Item -Path "Env:$name" -Value $value
    }
}

Import-DotEnv $EnvFile

$JameicaBin = $env:JAMEICA_BIN
$FlushOnStart = if ($env:FLUSH_OUTBOX_ON_START) { $env:FLUSH_OUTBOX_ON_START } else { "0" }

if (-not $JameicaBin) { throw "JAMEICA_BIN nicht gesetzt (.env)" }
if (-not (Test-Path $JameicaBin)) { throw "JAMEICA_BIN nicht gefunden: $JameicaBin" }
if (-not (Test-Path $Trigger)) { throw "export-trigger fehlt: $Trigger" }

if ($FlushOnStart -eq "1") {
    try { & $Trigger start } catch { }
}

Write-Host "[launcher] Starte Jameica: $JameicaBin"
$proc = Start-Process -FilePath $JameicaBin -ArgumentList $JameicaArgs -Wait -PassThru
$rc = $proc.ExitCode
Write-Host "[launcher] Jameica beendet (rc=$rc) — starte Export…"

& $Trigger exit
exit $rc
