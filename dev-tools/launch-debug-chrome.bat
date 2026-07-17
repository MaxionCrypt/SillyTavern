@echo off
REM Launches a SEPARATE Chrome profile with remote debugging enabled, so it
REM never conflicts with your normal everyday Chrome (the flag is silently
REM ignored if Chrome is already running under your normal profile, which is
REM why manually adding --remote-debugging-port to a running Chrome doesn't work).
REM
REM This profile persists your SillyTavern login/session between runs
REM (stored in dev-tools\chrome-debug-profile, gitignored), so you don't have
REM to re-login every time.
REM
REM Usage: double-click this file, or run it from a terminal.
REM Once it opens, tell Claude it's ready — it can then connect to
REM http://127.0.0.1:9222/json/list and inspect the REAL page you're looking at.

set PROFILE_DIR=%~dp0chrome-debug-profile
set DEBUG_PORT=9222

echo Launching debug Chrome on port %DEBUG_PORT%...
echo Profile: %PROFILE_DIR%

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
    --remote-debugging-port=%DEBUG_PORT% ^
    --user-data-dir="%PROFILE_DIR%" ^
    --no-first-run ^
    --no-default-browser-check ^
    http://127.0.0.1:8000

echo.
echo Chrome launching. Verify it's ready with:
echo   curl http://127.0.0.1:%DEBUG_PORT%/json/version
