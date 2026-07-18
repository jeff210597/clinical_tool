$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LocalDir = Join-Path $Root "app\.local"
$LogPath = Join-Path $LocalDir "cloudflare_relay_watchdog.log"
$DisabledPath = Join-Path $LocalDir "cloudflare_shadow_relay.disabled.json"
$Node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (-not (Test-Path $Node)) { $Node = "node.exe" }
if (-not (Test-Path $LocalDir)) { New-Item -ItemType Directory -Path $LocalDir | Out-Null }

function Write-WatchdogLog {
  param([string]$Message)
  Add-Content -LiteralPath $LogPath -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message) -Encoding UTF8
}

function Get-RelayProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "app[\\/]relay[\\/]cloudflare_poll_agent\.mjs(?:\s|$)" }
}

if (Test-Path $DisabledPath) {
  Write-WatchdogLog "disabled by local control flag"
  exit 0
}

$running = @(Get-RelayProcess)
if ($running.Count -gt 0) {
  Write-WatchdogLog "healthy pid=$($running[0].ProcessId)"
  exit 0
}

& $Node "app\relay\cloudflare_poll_agent.mjs" "--check-config" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Cloudflare relay configuration check failed." }

$process = Start-Process -FilePath $Node -ArgumentList "app\relay\cloudflare_poll_agent.mjs" -WorkingDirectory $Root -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
if (-not @(Get-RelayProcess)) { throw "Cloudflare relay process did not remain running." }
Write-WatchdogLog "started pid=$($process.Id)"
