# One-time helper: Desktop-Verknuepfung auf jameica-launcher.cmd.
# Danach diese Verknuepfung pinnen / nutzen — nicht jameica.exe.
# Usage (PowerShell im Repo):
#   .\launcher\create-desktop-shortcut.ps1
# Optional:
#   .\launcher\create-desktop-shortcut.ps1 -Name "Jameica (Sync)"
param(
    [string]$Name = "Jameica (OpenJVerein Sync)"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
$Target = Join-Path $ScriptDir "jameica-launcher.cmd"
$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop ($Name + ".lnk")

if (-not (Test-Path $Target)) {
    throw "Launcher fehlt: $Target"
}

$Wsh = New-Object -ComObject WScript.Shell
$Sc = $Wsh.CreateShortcut($ShortcutPath)
$Sc.TargetPath = $Target
$Sc.WorkingDirectory = $RepoRoot.Path
$Sc.WindowStyle = 1
$Sc.Description = "Startet Jameica; nach Beenden automatischer Einwilligungs-Export"
$Sc.Save()

Write-Host "Verknuepfung erstellt: $ShortcutPath"
Write-Host "Diese Verknuepfung starten/pinnen — nicht die nackte jameica.exe."
Write-Host "Voraussetzung: JAMEICA_BIN (und H2/n8n) in .env gesetzt."
