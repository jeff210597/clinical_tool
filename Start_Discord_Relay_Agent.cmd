@echo off
setlocal
cd /d "%~dp0app"
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
if not exist ".local" mkdir ".local"
"%NODE_EXE%" relay\discord_agent.mjs >> ".local\discord_relay.log" 2>&1
