@echo off
setlocal
cd /d "%~dp0"
set "API_HOST=0.0.0.0"
set "API_PORT=8766"
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
echo Starting ward tools for LAN access...
echo Open this computer: http://127.0.0.1:8766/
echo Stable intranet link after hostname setup: http://WARD-TOOLS:8766/
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%B in ("%%A") do echo Open phone/tablet on same intranet: http://%%B:8766/
)
echo.
"%NODE_EXE%" app\server.mjs
