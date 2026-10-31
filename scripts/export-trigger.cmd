@echo off
REM Thin launcher for Jameica Scripting hooks (Windows). Sync nur bei Start/Exit — kein Task Scheduler.
REM Usage:
REM   export-trigger.cmd start
REM   export-trigger.cmd exit [JAMEICA_PID]
REM Must never be waited on by Jameica's scripting thread.
setlocal EnableExtensions EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
if not defined ENV_FILE set "ENV_FILE=%REPO_ROOT%\.env"
if not defined PYTHON set "PYTHON=python"
set "EXPORTER=%REPO_ROOT%\exporter\export.py"
set "MODE=%~1"
set "WAIT_PID=%~2"

if "%MODE%"=="" (
  echo Fehler: Modus fehlt ^(start^|exit^) 1>&2
  exit /b 1
)
if not exist "%EXPORTER%" (
  echo Fehler: Exporter fehlt: %EXPORTER% 1>&2
  exit /b 1
)

if exist "%ENV_FILE%" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if not "%%A"=="" if not "%%B"=="" set "%%A=%%B"
  )
)

if /I "%MODE%"=="start" (
  REM Nur Outbox — kurzer HTTP-Timeout; kein H2 beim Start
  if not defined N8N_HTTP_TIMEOUT_SECONDS set "N8N_HTTP_TIMEOUT_SECONDS=8"
  echo [export-trigger] Exporter ^(outbox_flush^)…
  "%PYTHON%" "%EXPORTER%" --env-file "%ENV_FILE%" --trigger outbox_flush --flush-only
  exit /b 0
)

if /I "%MODE%"=="exit" (
  if not "%WAIT_PID%"=="" (
    echo [export-trigger] Warte auf Jameica-PID %WAIT_PID%…
    if not defined EXIT_PID_WAIT_SECONDS set "EXIT_PID_WAIT_SECONDS=600"
    set /a waited=0
    :wait_loop
    tasklist /FI "PID eq %WAIT_PID%" 2>NUL | find "%WAIT_PID%" >NUL
    if not errorlevel 1 (
      timeout /T 1 /NOBREAK >NUL
      set /a waited+=1
      if !waited! GEQ !EXIT_PID_WAIT_SECONDS! (
        echo [export-trigger] Timeout ^(!EXIT_PID_WAIT_SECONDS!s^) — Export trotzdem versuchen 1>&2
        goto wait_done
      )
      goto wait_loop
    )
    :wait_done
    if not defined EXIT_H2_SETTLE_SECONDS set "EXIT_H2_SETTLE_SECONDS=2"
    timeout /T %EXIT_H2_SETTLE_SECONDS% /NOBREAK >NUL
  )
  echo [export-trigger] Exporter ^(jameica_exit^)…
  "%PYTHON%" "%EXPORTER%" --env-file "%ENV_FILE%" --trigger jameica_exit
  exit /b %ERRORLEVEL%
)

echo Fehler: Unbekannter Modus: %MODE% ^(erwartet: start^|exit^) 1>&2
exit /b 1
