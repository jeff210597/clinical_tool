$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$WatchScript = Join-Path $Root "scripts\Watch_Cloudflare_Relay.ps1"
$HiddenLauncher = Join-Path $Root "scripts\Start_Cloudflare_Relay_Watchdog_Hidden.vbs"
$TaskName = "ClinicalToolCloudflareRelayWatchdog"

if (-not (Test-Path $WatchScript)) { throw "Missing watchdog script: $WatchScript" }
if (-not (Test-Path $HiddenLauncher)) { throw "Missing hidden watchdog launcher: $HiddenLauncher" }

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$WatchScript`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $argument -WorkingDirectory $Root
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable

$method = "ScheduledTask"
try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($logonTrigger, $repeatTrigger) `
    -Principal $principal `
    -Settings $settings `
    -Description "Supervise the Cloudflare shadow relay using outbound HTTPS polling only. Does not open ports, change firewall rules, or create a tunnel." `
    -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  $task = Get-ScheduledTask -TaskName $TaskName
  $info = $task | Get-ScheduledTaskInfo
  $state = $task.State
} catch {
  $method = "StartupFolder"
  $startupDir = [Environment]::GetFolderPath("Startup")
  $shortcutPath = Join-Path $startupDir "Clinical Tool Cloudflare Relay Watchdog.lnk"
  $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = "`"$HiddenLauncher`""
  $shortcut.WorkingDirectory = $Root
  $shortcut.WindowStyle = 7
  $shortcut.Description = "Keep the Cloudflare shadow relay alive with outbound HTTPS polling only."
  $shortcut.Save()
  Start-Process -FilePath $wscript -ArgumentList "`"$HiddenLauncher`"" -WindowStyle Hidden
  Start-Sleep -Seconds 3
  $state = "Running via Startup folder"
  $info = $null
}
[PSCustomObject]@{
  Method = $method
  TaskName = $TaskName
  State = $state
  LastRunTime = $info.LastRunTime
  LastTaskResult = $info.LastTaskResult
} | Format-List
