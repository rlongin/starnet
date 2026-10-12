# Returns only the exact configured gateway owned by the DPAPI account.
function Get-OwnedCouncilGateway([int]$processId) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
  $gatewayFile = Join-Path $PSScriptRoot 'ef-recovery-gateway.mjs'
  $commandPattern = '^"?' + [regex]::Escape([string]$config.NodeExe) + '"?\s+"?' + [regex]::Escape($gatewayFile) + '"?\s*$'
  $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
  if (!$process -or $process.ExecutablePath -ine $config.NodeExe -or $process.CommandLine -inotmatch $commandPattern -or $owner.Sid -ne $config.WindowsSid) {
    throw 'Council port is owned by an unverified process. It was left untouched.'
  }
  return Get-Process -Id $processId -ErrorAction Stop
}
