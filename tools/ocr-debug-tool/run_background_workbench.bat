@echo off
setlocal
set "TOOL_DIR=%~dp0"
set "WORKBENCH_URL=http://127.0.0.1:8088/debug_background_workbench.html"

powershell.exe -NoProfile -Command "$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8088 -State Listen -ErrorAction SilentlyContinue; if (-not $listener) { Start-Process -FilePath python -ArgumentList @('-m','http.server','8088','--bind','127.0.0.1','--directory','%TOOL_DIR%') -WindowStyle Hidden }"
timeout /t 1 /nobreak >nul
start "" "%WORKBENCH_URL%"
