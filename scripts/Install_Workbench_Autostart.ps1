$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$WatchScript = Join-Path $Root "scripts\Watch_Workbench_LAN.ps1"
$HiddenLauncher = Join-Path $Root "scripts\Start_Workbench_Watchdog_Hidden.vbs"
$TaskName = "ClinicalToolWorkbenchWatchdog"

if (-not (Test-Path $WatchScript)) {
  throw "Missing watchdog script: $WatchScript"
}
if (-not (Test-Path $HiddenLauncher)) {
  throw "Missing hidden watchdog launcher: $HiddenLauncher"
}

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$WatchScript`""

$action = New-ScheduledTaskAction -Execute $powershell -Argument $argument -WorkingDirectory $Root
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$repeatTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable

$method = "ScheduledTask"
try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($logonTrigger, $repeatTrigger) `
    -Principal $principal `
    -Settings $settings `
    -Description "Keep the clinical LAN workstation alive on localhost/LAN port 8766. Local process supervision only; no network boundary changes." `
    -Force | Out-Null

  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 5
  $info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
  $lastRunTime = $info.LastRunTime
  $lastTaskResult = $info.LastTaskResult
} catch {
  $method = "StartupFolder"
  $startupDir = [Environment]::GetFolderPath("Startup")
  $shortcutPath = Join-Path $startupDir "Clinical Tool Workbench Watchdog.lnk"
  $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = "`"$HiddenLauncher`""
  $shortcut.WorkingDirectory = $Root
  $shortcut.WindowStyle = 7
  $shortcut.Description = "Keep the clinical LAN workstation alive on localhost/LAN port 8766."
  $shortcut.Save()

  Start-Process -FilePath $wscript -ArgumentList "`"$HiddenLauncher`"" -WindowStyle Hidden
  Start-Sleep -Seconds 5
  $lastRunTime = $null
  $lastTaskResult = "Scheduled task unavailable; installed per-user Startup watchdog."
}

$health = try {
  (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8766/api/health -TimeoutSec 5).Content
} catch {
  $_.Exception.Message
}

[PSCustomObject]@{
  Method = $method
  TaskName = $TaskName
  LastRunTime = $lastRunTime
  LastTaskResult = $lastTaskResult
  Health = $health
} | Format-List
