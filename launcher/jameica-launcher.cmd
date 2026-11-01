@echo off
REM Primary Windows launcher stub → PowerShell.
REM Pin this shortcut instead of jameica.exe (see README / create-desktop-shortcut.ps1).
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%jameica-launcher.ps1" %*
exit /b %ERRORLEVEL%
