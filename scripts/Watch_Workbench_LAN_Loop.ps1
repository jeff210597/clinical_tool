$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LocalDir = Join-Path $Root "app\.local"
$LogPath = Join-Path $LocalDir "workbench_watchdog.log"
$WatchScript = Join-Path $Root "scripts\Watch_Workbench_LAN.ps1"
$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path $LocalDir)) {
  New-Item -ItemType Directory -Path $LocalDir | Out-Null
}

function Write-LoopLog {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\ClinicalToolWorkbenchWatchdogLoop", [ref]$createdNew)
if (-not $createdNew) {
  Write-LoopLog "watchdog loop already running; exiting duplicate"
  exit 0
}

try {
  Write-LoopLog "watchdog loop started"
  while ($true) {
    Start-Process `
      -FilePath $PowerShellExe `
      -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$WatchScript`"" `
      -WorkingDirectory $Root `
      -WindowStyle Hidden `
      -Wait | Out-Null
    Start-Sleep -Seconds 300
  }
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
  Write-LoopLog "watchdog loop stopped"
}
