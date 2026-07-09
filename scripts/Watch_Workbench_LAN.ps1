param(
  [int]$Port = 8766,
  [string]$BindHost = "0.0.0.0",
  [string]$HealthUrl = "http://127.0.0.1:8766/api/health"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LocalDir = Join-Path $Root "app\.local"
$LogPath = Join-Path $LocalDir "workbench_watchdog.log"

if (-not (Test-Path $LocalDir)) {
  New-Item -ItemType Directory -Path $LocalDir | Out-Null
}

function Write-WatchLog {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Test-WorkbenchHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
      return $true
    }
  } catch {
    return $false
  }
  return $false
}

function Get-WorkbenchListener {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Test-IsWorkbenchProcess {
  param([int]$ProcessId)
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
    if (-not $process) { return $false }
    $commandLine = [string]$process.CommandLine
    return ($commandLine -match "app\\server\.mjs" -or $commandLine -match "app/server\.mjs")
  } catch {
    return $false
  }
}

function Start-Workbench {
  $node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (-not (Test-Path $node)) {
    $node = "node"
  }

  $env:API_HOST = $BindHost
  $env:API_PORT = [string]$Port

  Start-Process -FilePath $node -ArgumentList "app\server.mjs" -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
  Write-WatchLog "started workbench on $BindHost`:$Port"
}

if (Test-WorkbenchHealth) {
  Write-WatchLog "healthy"
  exit 0
}

$listener = Get-WorkbenchListener
if ($listener) {
  $pid = [int]$listener.OwningProcess
  if (Test-IsWorkbenchProcess -ProcessId $pid) {
    Write-WatchLog "unhealthy listener pid=$pid; restarting"
    Stop-Process -Id $pid -Force
    Start-Sleep -Seconds 1
  } else {
    Write-WatchLog "port $Port is occupied by non-workbench pid=$pid; not touching it"
    exit 2
  }
} else {
  Write-WatchLog "not listening; starting"
}

Start-Workbench
Start-Sleep -Seconds 3

if (Test-WorkbenchHealth) {
  Write-WatchLog "restart verified"
  exit 0
}

Write-WatchLog "restart failed health check"
exit 1
