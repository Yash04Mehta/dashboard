@echo off
rem Aquant Insight: starts the dashboard and opens it in your browser. Everything stays on this computer.
cd /d "%~dp0"
if not exist node_modules ( echo Installing packages, one time only... & call npm install )
if not exist dist\index.html ( echo Building the app, one time only... & call npm run build )
echo.
echo Loading the data takes about 15 seconds. The browser opens by itself. Close this window to stop.
start "" cmd /c "timeout /t 20 /nobreak >nul & start http://localhost:8787"
node server\index.mjs
pause
