@echo off
REM Called by Jameica Scripting shutdown hook (detached) or manually.
REM launcher\ is cancelled — not primary. No Task Scheduler.
REM Usage:
REM   export-trigger.cmd start
REM   export-trigger.cmd exit [JAMEICA_PID]
setlocal EnableExtensions EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
if not defined ENV_FILE set "ENV_FILE=%REPO_ROOT%\.env"
REM PYTHON: optional Override (ENV/.env). Sonst .venv, sonst PATH — siehe :resolve_python
set "EXPORTER=%REPO_ROOT%\exporter\export.py"
set "MODE=%~1"
set "WAIT_PID=%~2"
set "LOG_DIR=%REPO_ROOT%\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM Marker unter %%TEMP%% und logs\ (kein PII in Git; lokale Pfade ok in TEMP)
set "DIAG_TMP=%TEMP%"
if not defined DIAG_TMP set "DIAG_TMP=%TMP%"
if not defined DIAG_TMP set "DIAG_TMP=%LOG_DIR%"

goto :main

REM --- helpers (avoid `rc=1>` eating the digit — always space before `>` / use blocks) ---
:write_fail
REM args: reason detail rc
set "_reason=%~1"
set "_detail=%~2"
set "_rc=%~3"
if not defined _rc set "_rc=unknown"
(
  echo reason=!_reason! detail=!_detail! rc=!_rc! mode=!MODE! python=!PYTHON!
  echo %DATE% %TIME%
) > "%DIAG_TMP%\ojv-n8n-sync-exporter-fail.txt"
copy /Y "%DIAG_TMP%\ojv-n8n-sync-exporter-fail.txt" "%LOG_DIR%\ojv-n8n-sync-exporter-fail.txt" >NUL 2>&1
echo [export-trigger] FAIL reason=!_reason! rc=!_rc! detail=!_detail! 1>&2
exit /b 0

:write_spawned
(
  echo export-trigger mode=!MODE! waitPid=!WAIT_PID! root=!REPO_ROOT! envFile=!ENV_FILE! python=!PYTHON!
  echo %DATE% %TIME%
) > "%DIAG_TMP%\ojv-n8n-sync-trigger-spawned.txt"
copy /Y "%DIAG_TMP%\ojv-n8n-sync-trigger-spawned.txt" "%LOG_DIR%\ojv-n8n-sync-trigger-spawned.txt" >NUL 2>&1
echo [export-trigger] diag ojv-n8n-sync-trigger-spawned.txt mode=!MODE!
exit /b 0

REM Prefer SYNC_ROOT/.venv (Jameica-Spawn aktiviert die venv nicht → oft System-Python ohne jaydebeapi).
REM Absoluter PYTHON=-Pfad (existierende Datei) überschreibt; bloßer Name "python" verliert gegen .venv.
:resolve_python
if defined PYTHON if not "!PYTHON!"=="" if exist "!PYTHON!" exit /b 0
if exist "%REPO_ROOT%\.venv\Scripts\python.exe" (
  set "PYTHON=%REPO_ROOT%\.venv\Scripts\python.exe"
  exit /b 0
)
if defined PYTHON if not "!PYTHON!"=="" (
  where "!PYTHON!" >NUL 2>&1
  if not errorlevel 1 exit /b 0
)
where python >NUL 2>&1
if not errorlevel 1 (
  set "PYTHON=python"
  exit /b 0
)
where py >NUL 2>&1
if not errorlevel 1 (
  set "PYTHON=py"
  exit /b 0
)
where python3 >NUL 2>&1
if not errorlevel 1 (
  set "PYTHON=python3"
  exit /b 0
)
exit /b 1

:main
if "%MODE%"=="" (
  echo Fehler: Modus fehlt ^(start^|exit^) 1>&2
  call :write_fail missing_mode "start_or_exit_required" 1
  exit /b 1
)
if not exist "%EXPORTER%" (
  echo Fehler: Exporter fehlt: %EXPORTER% 1>&2
  call :write_fail exporter_missing "%EXPORTER%" 1
  exit /b 1
)

if not exist "%ENV_FILE%" (
  echo Fehler: .env fehlt: %ENV_FILE% 1>&2
  call :write_fail missing_env_file "copy_.env.example_to_.env_and_set_N8N_WEBHOOK_URL" 2
  exit /b 2
)

if exist "%ENV_FILE%" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if not "%%A"=="" if not "%%B"=="" set "%%A=%%B"
  )
)

call :resolve_python
if errorlevel 1 (
  call :write_fail python_not_found "no_.venv_and_python_not_on_PATH_create_.venv_or_set_PYTHON" 127
  exit /b 127
)

call :write_spawned

if /I "%MODE%"=="start" (
  if not defined N8N_HTTP_TIMEOUT_SECONDS set "N8N_HTTP_TIMEOUT_SECONDS=8"
  set "EXPORT_LOG=%LOG_DIR%\export-outbox_flush.log"
  echo [export-trigger] Exporter ^(outbox_flush^)… log=!EXPORT_LOG!
  "%PYTHON%" "%EXPORTER%" --env-file "%ENV_FILE%" --trigger outbox_flush --flush-only > "!EXPORT_LOG!" 2>&1
  set "RC=!ERRORLEVEL!"
  if not "!RC!"=="0" (
    REM Do not overwrite exporter's reason= marker; fallback only if missing
    findstr /C:"reason=" "%DIAG_TMP%\ojv-n8n-sync-exporter-fail.txt" >NUL 2>&1
    if errorlevel 1 (
      call :write_fail exporter_exit "see_logs_export-outbox_flush.log" "!RC!"
    )
  )
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
    timeout /T !EXIT_H2_SETTLE_SECONDS! /NOBREAK >NUL
  )
  set "EXPORT_LOG=%LOG_DIR%\export-jameica_exit.log"
  echo [export-trigger] Exporter ^(jameica_exit^)… log=!EXPORT_LOG!
  "%PYTHON%" "%EXPORTER%" --env-file "%ENV_FILE%" --trigger jameica_exit > "!EXPORT_LOG!" 2>&1
  set "RC=!ERRORLEVEL!"
  if not defined RC set "RC=1"
  if "!RC!"=="" set "RC=1"
  if not "!RC!"=="0" (
    REM Keep Python reason=missing_webhook / h2_* / …; only fill empty/missing marker
    findstr /C:"reason=" "%DIAG_TMP%\ojv-n8n-sync-exporter-fail.txt" >NUL 2>&1
    if errorlevel 1 (
      call :write_fail exporter_exit "see_logs_export-jameica_exit.log" "!RC!"
    )
  )
  exit /b !RC!
)

echo Fehler: Unbekannter Modus: %MODE% ^(erwartet: start^|exit^) 1>&2
call :write_fail unknown_mode "%MODE%" 1
exit /b 1
