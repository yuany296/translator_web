@echo off
setlocal
rem 启动「阶段检视台」：一个本地只读服务器（静态 + 同源反代 + 阶段回放），再打开页面。
rem 端口被占用时服务器会自己退出并提示，浏览器仍会打开已经在跑的那个。
set "TOOL_DIR=%~dp0"
pushd "%TOOL_DIR%..\.."
start "stage-inspector" /min cmd /c "node tools\stage-inspector\serve.mjs --port 8099"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8099/stage-inspector/"
popd
