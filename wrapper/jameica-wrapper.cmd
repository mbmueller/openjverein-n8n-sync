@echo off
REM OPTIONAL / DEPRECATED: Windows-Stub → PowerShell-Wrapper.
REM Primärpfad: scripts\jameica-openjverein-sync.js (Jameica Scripting).
setlocal
echo [wrapper] Exit-Sync nach Jameica-Ende (zuverlaessig ohne Scripting-Eval). Siehe README.
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%jameica-wrapper.ps1" %*
exit /b %ERRORLEVEL%
