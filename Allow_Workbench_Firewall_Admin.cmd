@echo off
echo This script opens inbound TCP 8766 for ward tools.
echo Please run as Administrator if phone/tablet cannot connect from the same intranet.
echo.
netsh advfirewall firewall add rule name="Ward Tools 8766" dir=in action=allow protocol=TCP localport=8766 profile=any
echo.
pause
