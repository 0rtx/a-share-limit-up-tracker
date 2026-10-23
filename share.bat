@echo off
setlocal
cd /d "%~dp0"
set "PORT=8080"

echo [1/2] Checking local server on port %PORT% ...
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if (-not $c) { Start-Process -FilePath 'python' -ArgumentList '-m','http.server','%PORT%' -WorkingDirectory '%~dp0' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"

echo [2/2] Restarting Cloudflare tunnel ...
taskkill /IM cloudflared.exe /F >nul 2>&1
start "A-Share ZT Tunnel" "%~dp0.tools\cloudflared.exe" tunnel --url http://localhost:%PORT% --no-autoupdate

echo.
echo Done. A new window should be open with a URL like:
echo     https://xxxx-xxxx-xxxx.trycloudflare.com
echo Copy that URL and open it on any device.
echo.
echo Keep the tunnel window open while sharing. Close that window to stop.
pause
