$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LocalDir = Join-Path $Root "app\.local"
$LogPath = Join-Path $LocalDir "cloudflare_relay_watchdog.log"
$WatchScript = Join-Path $Root "scripts\Watch_Cloudflare_Relay.ps1"
$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path $LocalDir)) { New-Item -ItemType Directory -Path $LocalDir | Out-Null }

function Write-LoopLog {
  param([string]$Message)
  Add-Content -LiteralPath $LogPath -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message) -Encoding UTF8
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\ClinicalToolCloudflareRelayWatchdogLoop", [ref]$createdNew)
if (-not $createdNew) { exit 0 }

try {
  Write-LoopLog "watchdog loop started"
  while ($true) {
    Start-Process -FilePath $PowerShellExe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$WatchScript`"" -WorkingDirectory $Root -WindowStyle Hidden -Wait | Out-Null
    Start-Sleep -Seconds 60
  }
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
  Write-LoopLog "watchdog loop stopped"
}
