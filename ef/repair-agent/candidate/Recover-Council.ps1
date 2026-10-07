$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$config = Get-Content (Join-Path $root 'council-config.json') -Raw | ConvertFrom-Json
if ($config.WindowsSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Use the Windows account that owns Council.' }
$gatewayPath = Join-Path $root 'ef-recovery-gateway.mjs'
function Gateway-Ready {
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$($config.GatewayPort)/health" -TimeoutSec 3
    return ($h.release -eq $config.Release -and $h.launchConfigured -and $h.stationConfigured -and $h.localModelConfigured)
  } catch { return $false }
}
if (!(Gateway-Ready)) {
  foreach ($listener in @(Get-NetTCPConnection -State Listen -LocalPort $config.GatewayPort -ErrorAction SilentlyContinue)) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    if (!$owner -or $owner.ExecutablePath -ine $config.NodeExe -or !$owner.CommandLine -or !$owner.CommandLine.Contains($gatewayPath)) {
      throw 'Another application owns the Council port. It was left untouched.'
    }
    Stop-Process -Id $owner.ProcessId -ErrorAction Stop
  }
}
if ($config.StartupTask -and (Get-ScheduledTask -TaskName $config.StartupTask -ErrorAction SilentlyContinue)) {
  Start-ScheduledTask -TaskName $config.StartupTask
} elseif (!(Gateway-Ready)) {
  Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList @('-NoProfile', '-File', ('"' + (Join-Path $root 'start-recovery-gateway.ps1') + '"'))
}
$secure = (Get-Content (Join-Path $root 'recovery-key.dpapi') -Raw).Trim() | ConvertTo-SecureString
$recoveryKey = ([pscredential]::new('Council', $secure)).GetNetworkCredential().Password.Trim()
$deadline = (Get-Date).AddSeconds(150)
while ((Get-Date) -lt $deadline) {
  if (Gateway-Ready) {
    try {
      $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($config.GatewayPort)/council/recover" -Headers @{Authorization = "Bearer $recoveryKey"} -TimeoutSec 30
      if ($r.ok) {
        Write-Host 'Council gateway and saved member runtimes are responding. Reopen Council from Ventura.' -ForegroundColor Green
        Write-Host 'This recovery preserves saved work. Interrupted actions were not replayed.'
        exit 0
      }
    } catch {}
  }
  Start-Sleep -Seconds 3
}
throw 'Council recovery did not finish. Keep this error; logs are in the CouncilLogs folder. No AI service was restarted.'
