@echo off
setlocal
rem 这个页面必须从本地调试服务器打开：file:// 下浏览器会拦掉对 OCR 服务的请求（CORS）。
rem 服务器同时提供同源反代，所以页面里的 serviceUrl 要填 http://127.0.0.1:8099
set "TOOL_DIR=%~dp0"
pushd "%TOOL_DIR%..\.."
start "stage-inspector" /min cmd /c "node tools\stage-inspector\serve.mjs --port 8099"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8099/ocr-debug-tool/index.html"
popd
