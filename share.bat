@echo off
rem Shares the dashboard on a temporary public link (Cloudflare quick tunnel). Anyone with the link can view it; there is no password.
rem Phone numbers stay masked and "reveal" is switched off while sharing. Close this window (or run stop.bat) to end the link.
rem Needs cloudflared.exe in %LOCALAPPDATA%\cloudflared (or on PATH).
cd /d "%~dp0"
set TUNNEL=1
set ALLOW_REVEAL=false
call stop.bat >nul 2>&1
start "Aquant Insight server" /min node server/index.mjs
echo Waiting for the server (about 20 s) ...
timeout /t 25 /nobreak >nul
if exist "%LOCALAPPDATA%\cloudflared\cloudflared.exe" ("%LOCALAPPDATA%\cloudflared\cloudflared.exe" tunnel --url http://127.0.0.1:8787 --no-autoupdate) else (cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate)
