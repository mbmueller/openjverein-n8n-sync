@echo off
REM Windows-Stub: ruft PowerShell-Wrapper auf. Sync nur bei Start/Exit — kein Task Scheduler.
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%jameica-wrapper.ps1" %*
exit /b %ERRORLEVEL%
