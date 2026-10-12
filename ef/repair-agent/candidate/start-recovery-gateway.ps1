param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$config = Get-Content (Join-Path $root 'council-config.json') -Raw | ConvertFrom-Json
. (Join-Path $root 'Council-ProcessOwner.ps1')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($config.WindowsSid -ne $identity) { throw 'Council must run under the Windows account that owns its encrypted keys.' }
$gateway = Join-Path $root 'ef-recovery-gateway.mjs'
foreach ($file in @($config.NodeExe, $gateway, (Join-Path $config.StationRoot 'sidecar\index.js'))) {
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Council runtime file is unavailable: $file" }
}
function Read-Key([string]$name, [int]$minimum) {
  $secure = (Get-Content -LiteralPath (Join-Path $root $name) -Raw).Trim() | ConvertTo-SecureString
  $value = ([pscredential]::new('Council', $secure)).GetNetworkCredential().Password.Trim()
  if ($value.Length -lt $minimum) { throw "Council encrypted key is invalid: $name" }
  return $value
}
$env:EF_COUNCIL_LAUNCH_SECRET = Read-Key 'council-launch-key.dpapi' 32
$env:EF_AI_RECOVERY_SECRET = Read-Key 'recovery-key.dpapi' 24
$env:EF_COUNCIL_GATEWAY_PORT = [string]$config.GatewayPort
$env:EF_COUNCIL_MEMBER_PORT_START = [string]$config.MemberPortStart
$env:EF_COUNCIL_STATION_ROOT = [string]$config.StationRoot
$env:EF_COUNCIL_DATA_ROOT = [string]$config.DataRoot
$env:EF_COUNCIL_LOCAL_MODEL = [string]$config.LocalModel
$env:EF_COUNCIL_LOCAL_BASE_URL = [string]$config.LocalBaseUrl
if (!$config.LocalModel -or !$config.LocalBaseUrl) { throw 'Configured local model and endpoint are required.' }
$endpoint = [uri]$config.LocalBaseUrl
if ($endpoint.Scheme -ne 'http' -or $endpoint.Host -ne '127.0.0.1' -or $endpoint.UserInfo) { throw 'Council model endpoint must be local loopback.' }
if ($ValidateOnly) { Write-Output 'Council configuration and encrypted-key access: PASS'; exit 0 }

function Is-Ready {
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$($config.GatewayPort)/health" -TimeoutSec 3
    return ($h.release -eq $config.Release -and $h.launchConfigured -and $h.stationConfigured -and $h.localModelConfigured)
  } catch { return $false }
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\EFVCouncilGatewaySupervisor')
$held = $false
$worker = $null
try {
  try { $held = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
  if (!$held) { Write-Output 'Council supervisor is already running.'; exit 0 }
  # Never adopt or kill an unknown gateway simply because it occupies this port.
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $config.GatewayPort -ErrorAction SilentlyContinue)
  if ($listeners.Count) {
    $owned = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Get-OwnedCouncilGateway $_ })
    # A previous supervisor may have died while its exact child survived.
    foreach ($orphan in $owned) { $orphan.Kill(); if (!$orphan.WaitForExit(5000)) { throw 'Owned orphan did not exit.' }; $orphan.Dispose() }
  }
  $logs = Join-Path $root 'CouncilLogs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $delay = 2
  while ($true) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $outLog = Join-Path $logs "gateway-$stamp-output.log"
    $errLog = Join-Path $logs "gateway-$stamp-error.log"
    $worker = Start-Process -FilePath $config.NodeExe -ArgumentList ('"' + $gateway + '"') -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $started = Get-Date
    $failures = 0
    while (!$worker.HasExited) {
      Start-Sleep -Seconds 10
      $worker.Refresh()
      if ($worker.HasExited) { break }
      if (Is-Ready) { $failures = 0; $delay = 2 }
      elseif (((Get-Date) - $started).TotalSeconds -ge 45) { $failures++ }
      if ($failures -ge 3) {
        # Process object retains this exact child handle; no port-only/global kill.
        $worker.Kill()
        if (!$worker.WaitForExit(5000)) { throw 'Owned gateway did not exit; replacement refused.' }
        break
      }
    }
    $worker.Dispose()
    $worker = $null
    Get-ChildItem -LiteralPath $logs -Filter 'gateway-*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds $delay
    $delay = [Math]::Min(60, $delay * 2)
  }
} finally {
  if ($worker) {
    try { if (!$worker.HasExited) { $worker.Kill(); [void]$worker.WaitForExit(5000) } } catch {}
    $worker.Dispose()
  }
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
