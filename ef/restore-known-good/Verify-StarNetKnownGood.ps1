[CmdletBinding()]
param(
  [string]$CouncilModel = "qwen3:8b",
  [int]$OllamaPort = 11434,
  [int]$NexusGatewayPort = 4000,
  [int]$KnownGoodCouncilPort = 8798,
  [int]$CouncilGatewayPort = 8799,
  [string]$NexusRennModelRoute = "nexus-primary",
  [switch]$NoExit,
  [switch]$Quiet
)
$ErrorActionPreference = "Continue"
$checks = New-Object System.Collections.Generic.List[object]
function Add-Check([string]$Name, [bool]$Ok, [string]$Detail = "", $Data = $null) {
  $row = [ordered]@{ name=$Name; ok=$Ok; detail=$Detail }
  if ($null -ne $Data) { $row.data=$Data }
  $checks.Add($row) | Out-Null
  if (-not $Quiet) { Write-Host "[$(if($Ok){'OK'}else{'FAIL'})] $Name $Detail" }
}
function Get-Json($Url, $Method = "GET", $Body = $null, $TimeoutSec = 12) {
  try {
    if ($Method -eq "POST") { return Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json" -Body ($Body | ConvertTo-Json -Depth 8) -TimeoutSec $TimeoutSec -ErrorAction Stop }
    return Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSec -ErrorAction Stop
  } catch { return $null }
}
function Get-Text($Url, $TimeoutSec = 5) {
  try { return Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec -ErrorAction Stop } catch { return $null }
}
$codex = Get-Command codex -ErrorAction SilentlyContinue
Add-Check "codex-cli" ([bool]$codex) $(if($codex){$codex.Source}else{"not found"})
if ($codex) {
  $status = try { & codex --version 2>&1 | Out-String } catch { $_.Exception.Message }
  Add-Check "codex-version" ([bool]$status) ($status.Trim())
}
$tags = Get-Json "http://127.0.0.1:$OllamaPort/api/tags"
$modelNames = @()
if ($tags -and $tags.models) { $modelNames += @($tags.models | ForEach-Object { $_.name; $_.model }) }
Add-Check "ollama-tags" ($null -ne $tags) "port=$OllamaPort"
Add-Check "ollama-model" ($modelNames -contains $CouncilModel) "model=$CouncilModel"
$native = Get-Json "http://127.0.0.1:$OllamaPort/api/generate" "POST" @{ model=$CouncilModel; prompt="Respond with exactly: NEXUS AI READY"; stream=$false; think=$false; options=@{ num_predict=24 } } 45
$nativeText = if ($native) { [string]$native.response } else { "" }
Add-Check "ollama-inference" ($nativeText -match "NEXUS AI READY") $nativeText.Substring(0, [Math]::Min(120, $nativeText.Length))
$nexus = Get-Json "http://127.0.0.1:$NexusGatewayPort/v1/chat/completions" "POST" @{ model=$NexusRennModelRoute; messages=@(@{role="user"; content="Respond with exactly: NEXUS AI READY"}); max_tokens=24; temperature=0 } 45
$nexusText = if ($nexus -and $nexus.choices) { [string]$nexus.choices[0].message.content } else { "" }
Add-Check "nexusrenn-gateway" ($nexusText -match "NEXUS AI READY") "model=$NexusRennModelRoute sample=$($nexusText.Substring(0, [Math]::Min(120, $nexusText.Length)))"
$station = Get-Text "http://127.0.0.1:$KnownGoodCouncilPort/"
Add-Check "known-good-council-8798" ($station -and [int]$station.StatusCode -ge 200 -and [int]$station.StatusCode -lt 500) "status=$($station.StatusCode)"
$gateway = Get-Text "http://127.0.0.1:$CouncilGatewayPort/health"
Add-Check "council-gateway-8799" ($gateway -and [int]$gateway.StatusCode -ge 200 -and [int]$gateway.StatusCode -lt 500) "status=$($gateway.StatusCode)"
$result = [ordered]@{ timestamp=(Get-Date).ToString("o"); checks=$checks; ok=(($checks | Where-Object { -not $_.ok }).Count -eq 0) }
$json = $result | ConvertTo-Json -Depth 10
$json
if (-not $NoExit -and -not $result.ok) { exit 1 }
