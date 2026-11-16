@echo off
rem Stops the Aquant Insight server only (the process listening on port 8787 that runs server\index.mjs).
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess); if ($p.CommandLine -match 'server[\/]index\.mjs') { Stop-Process -Id $c.OwningProcess -Force; 'Aquant Insight stopped.' } else { 'Port 8787 is used by another program. Not touching it.' } } else { 'Aquant Insight is not running.' }"
pause
