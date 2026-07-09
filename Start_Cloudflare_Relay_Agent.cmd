@echo off
setlocal
cd /d "%~dp0"
set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" app\relay\cloudflare_poll_agent.mjs --echo-only
