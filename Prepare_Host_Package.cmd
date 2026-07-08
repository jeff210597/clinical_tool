@echo off
setlocal
cd /d "%~dp0"

set "OUT=deploy\clinical-tools-host"

echo Preparing host deployment package...
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%"

robocopy app "%OUT%\app" /E /XD ".local\onepage_assets" /XF "sessions.json" "audit.ndjson" >nul
copy /Y Start_Workbench_LAN.cmd "%OUT%\" >nul
copy /Y Setup_Stable_Intranet_Link_Admin.cmd "%OUT%\" >nul
copy /Y Allow_Workbench_Firewall_Admin.cmd "%OUT%\" >nul
copy /Y HOST_DEPLOY_README.md "%OUT%\" >nul

if exist "%OUT%\app\.local\sessions.json" del /f /q "%OUT%\app\.local\sessions.json"
if exist "%OUT%\app\.local\audit.ndjson" del /f /q "%OUT%\app\.local\audit.ndjson"

echo.
echo Done.
echo Package folder:
echo %CD%\%OUT%
echo.
echo Copy this folder to the hospital host computer.
pause
