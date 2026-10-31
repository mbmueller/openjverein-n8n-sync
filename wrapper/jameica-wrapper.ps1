# Wrapper (Windows): startet Jameica, nach Exit Exporter; optional vor Start Outbox flushen.
# Sync nur bei Start/Exit — kein Task Scheduler / Cron.
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$JameicaArgs
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
$EnvFile = if ($env:ENV_FILE) { $env:ENV_FILE } else { Join-Path $RepoRoot ".env" }

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
$FlushOnStart = if ($env:FLUSH_OUTBOX_ON_START) { $env:FLUSH_OUTBOX_ON_START } else { "1" }
$Python = if ($env:PYTHON) { $env:PYTHON } else { "python" }
$Exporter = Join-Path $RepoRoot "exporter\export.py"

if (-not $JameicaBin) { throw "JAMEICA_BIN nicht gesetzt (.env)" }
if (-not (Test-Path $JameicaBin)) { throw "JAMEICA_BIN nicht gefunden: $JameicaBin" }
if (-not (Test-Path $Exporter)) { throw "Exporter fehlt: $Exporter" }

function Invoke-Exporter {
    param([string]$Trigger, [string[]]$ExtraArgs = @())
    Write-Host "[wrapper] Exporter ($Trigger)…"
    & $Python $Exporter --env-file $EnvFile --trigger $Trigger @ExtraArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[wrapper] Exporter Exit-Code $LASTEXITCODE (Outbox greift beim nächsten Start/Exit)" -ForegroundColor Yellow
    }
}

if ($FlushOnStart -eq "1") {
    try { Invoke-Exporter -Trigger "outbox_flush" -ExtraArgs @("--flush-only") } catch { }
}

Write-Host "[wrapper] Starte Jameica: $JameicaBin"
$proc = Start-Process -FilePath $JameicaBin -ArgumentList $JameicaArgs -Wait -PassThru
$rc = $proc.ExitCode
Write-Host "[wrapper] Jameica beendet (rc=$rc)"

Invoke-Exporter -Trigger "jameica_exit"
exit $rc
