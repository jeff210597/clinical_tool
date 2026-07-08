@echo off
setlocal
set "TARGET_NAME=WARD-TOOLS"

echo This one-time setup creates a stable intranet link for the ward tools.
echo Target link: http://%TARGET_NAME%:8766/
echo.
echo It will:
echo 1. Open inbound TCP 8766 in Windows Firewall.
echo 2. Rename this computer to %TARGET_NAME%.
echo.
echo Run this file as Administrator. A reboot is usually required after rename.
echo.

netsh advfirewall firewall add rule name="Ward Tools 8766" dir=in action=allow protocol=TCP localport=8766 profile=any
powershell -NoProfile -ExecutionPolicy Bypass -Command "if ($env:COMPUTERNAME -ne '%TARGET_NAME%') { Rename-Computer -NewName '%TARGET_NAME%' -Force } else { Write-Host 'Computer name already set.' }"

echo.
echo If rename succeeded, restart Windows, then start Start_Workbench_LAN.cmd.
echo Phone/tablet URL: http://%TARGET_NAME%:8766/
echo If that name still cannot resolve on hospital Wi-Fi, ask IT to add DNS alias %TARGET_NAME% pointing to this computer.
echo.
pause
