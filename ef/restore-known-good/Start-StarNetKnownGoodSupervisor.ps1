[CmdletBinding()]
param(
  [string]$StarNetPath = "C:\Users\Ricardo\Documents\GitHub\starnet",
  [string]$BackupRoot = "C:\NexusAI\KnownGoodRestore",
  [string]$CouncilModel = "qwen3:8b",
  [int]$OllamaPort = 11434,
  [int]$NexusGatewayPort = 4000,
  [int]$KnownGoodCouncilPort = 8798,
  [int]$CouncilGatewayPort = 8799,
  [int]$Minutes = 0
)
$ErrorActionPreference = "Continue"
$logRoot = Join-Path $BackupRoot "logs"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$log = Join-Path $logRoot "supervisor.log"
function Log($Message) { Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $Message" }
function Test-Url($Url, $TimeoutSec = 5) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec -ErrorAction Stop; return [int]$r.StatusCode } catch { return 0 } }
function Test-JsonPost($Url, $Body, $TimeoutSec = 45) {
  try { return Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json" -Body ($Body | ConvertTo-Json -Depth 8) -TimeoutSec $TimeoutSec -ErrorAction Stop } catch { return $null }
}
function New-Secret([int]$Bytes = 48) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+','-').Replace('/','_')
}
function Get-OrCreateSecret([string]$Path, [int]$MinLength) {
  try {
    if (Test-Path -LiteralPath $Path) {
      $existing = (Get-Content -LiteralPath $Path -Raw).Trim()
      if ($existing.Length -ge $MinLength) { return $existing }
    }
    $secret = New-Secret 48
    Set-Content -LiteralPath $Path -Value $secret -Encoding UTF8
    return $secret
  } catch {
    Log "secret unavailable $Path $($_.Exception.Message)"
    return ""
  }
}
function Import-RuntimeSettings() {
  $envPath = Join-Path $BackupRoot "known-good-runtime.env"
  if (-not (Test-Path -LiteralPath $envPath)) { return }
  try {
    foreach ($line in Get-Content -LiteralPath $envPath) {
      if ($line -notmatch "^\s*([^#=]+)=(.*)$") { continue }
      $key = $Matches[1].Trim()
      $value = $Matches[2].Trim()
      if ($key -eq "EF_COUNCIL_LOCAL_MODEL" -and $value) { $script:CouncilModel = $value }
      if ($key -eq "EF_COUNCIL_LOCAL_BASE_URL" -and $value) {
        try { $script:OllamaPort = [int]([uri]$value).Port } catch {}
      }
    }
    Log "loaded runtime env model=$CouncilModel ollamaPort=$OllamaPort"
  } catch {
    Log "runtime env load failed $($_.Exception.Message)"
  }
}

function Start-OllamaIfPresent() {
  if ((Test-Url "http://127.0.0.1:$OllamaPort/api/tags") -ne 0) { return }
  $candidates = @( @(
    "C:\NexusAI\Ollama-Recovery\bin\ollama.exe",
    "C:\Program Files\Ollama\ollama.exe",
    (Get-Command ollama.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } )
  if (-not $candidates -or $candidates.Count -eq 0) { Log "ollama missing for port $OllamaPort"; return }
  $env:OLLAMA_HOST = "127.0.0.1:$OllamaPort"
  Start-Process -FilePath $candidates[0] -ArgumentList @("serve") -WindowStyle Hidden
  Log "started Ollama $($candidates[0]) on $env:OLLAMA_HOST"
}

function Start-CouncilGatewayIfPresent() {
  $packaged = Join-Path $PSScriptRoot "ef-nexus-council-gateway.mjs"
  $repoEntry = Join-Path $StarNetPath "scripts\ef-nexus-council-gateway.mjs"
  $existing = Join-Path "C:\NexusAI\Recovery" "start-recovery-gateway.ps1"
  $entry = if (Test-Path -LiteralPath $packaged) { $packaged } elseif (Test-Path -LiteralPath $repoEntry) { $repoEntry } else { $null }
  if ($entry -and (Test-Path -LiteralPath $entry)) {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
    if (-not $node) { Log "node.exe missing; cannot start Council gateway"; return }
    $launchSecret = Get-OrCreateSecret (Join-Path $BackupRoot "council-launch-secret.txt") 32
    $recoverySecret = Get-OrCreateSecret (Join-Path $BackupRoot "council-recovery-secret.txt") 24
    if ($launchSecret.Length -lt 32 -and $recoverySecret.Length -lt 24) { Log "Council gateway secret missing"; return }
    $env:EF_COUNCIL_LOCAL_MODEL = $CouncilModel
    $env:EF_COUNCIL_LOCAL_BASE_URL = "http://127.0.0.1:$OllamaPort/v1"
    $env:EF_COUNCIL_GATEWAY_PORT = [string]$CouncilGatewayPort
    $env:EF_COUNCIL_STATION_ROOT = $StarNetPath
    $env:EF_COUNCIL_LAUNCH_SECRET = $launchSecret
    $env:EF_AI_RECOVERY_SECRET = $recoverySecret
    if (-not $env:EF_COUNCIL_DATA_ROOT) { $env:EF_COUNCIL_DATA_ROOT = "C:\NexusAI\.ef-nexus-workspaces" }
    $stdout = Join-Path $logRoot "council-gateway.out.log"
    $stderr = Join-Path $logRoot "council-gateway.err.log"
    Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory $StarNetPath -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Log "started Council gateway $entry with station root $StarNetPath"
  } elseif (Test-Path -LiteralPath $existing) {
    Start-Process powershell.exe -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$existing) -WindowStyle Hidden
    Log "started existing recovery gateway script"
  } else { Log "no council gateway launcher found" }
}
function Start-NexusGatewayIfPresent() {
  $container = try { docker ps -a --filter "name=^nexus-ai-gateway$" --format "{{.Names}}" 2>$null } catch { "" }
  if ($container -eq "nexus-ai-gateway") { docker start nexus-ai-gateway | Out-Null; Log "started nexus-ai-gateway container" }
}
function Test-NexusGatewayInference() {
  $reply = Test-JsonPost "http://127.0.0.1:$NexusGatewayPort/v1/chat/completions" @{ model="nexus-primary"; messages=@(@{role="user";content="Respond with exactly: NEXUS AI READY"}); max_tokens=24; temperature=0 }
  $text = if ($reply -and $reply.choices) { [string]$reply.choices[0].message.content } else { "" }
  return ($text.Trim().Length -gt 0)
}
function Start-NexusFallbackGateway() {
  $entry = Join-Path $PSScriptRoot "nexus-renn-loopback-gateway.mjs"
  if (-not (Test-Path -LiteralPath $entry)) { Log "missing Nexus ReNN fallback gateway"; return }
  $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
  if (-not $node) { Log "node.exe missing; cannot start Nexus fallback gateway"; return }
  $env:NEXUS_RENN_GATEWAY_PORT = [string]$NexusGatewayPort
  $env:NEXUSRENN_MODEL_ROUTE = "nexus-primary"
  $env:EF_COUNCIL_LOCAL_MODEL = $CouncilModel
  $env:EF_COUNCIL_LOCAL_BASE_URL = "http://127.0.0.1:$OllamaPort/v1"
  $stdout = Join-Path $logRoot "nexus-renn-gateway.out.log"
  $stderr = Join-Path $logRoot "nexus-renn-gateway.err.log"
  Start-Process -FilePath $node -ArgumentList @($entry) -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Log "started Nexus ReNN fallback gateway $entry model=$CouncilModel"
}
function Repair-NexusGatewayIfNeeded() {
  if (Test-NexusGatewayInference) { return }
  $container = try { docker ps -a --filter "name=^nexus-ai-gateway$" --format "{{.Names}}" 2>$null } catch { "" }
  if ($container -eq "nexus-ai-gateway") {
    try { docker restart nexus-ai-gateway | Out-Null; Log "restarted nexus-ai-gateway container"; Start-Sleep -Seconds 6 } catch { Log "nexus-ai-gateway restart failed $($_.Exception.Message)" }
    if (Test-NexusGatewayInference) { return }
    try { docker stop nexus-ai-gateway | Out-Null; Log "stopped broken nexus-ai-gateway container for fallback" } catch { Log "nexus-ai-gateway stop failed $($_.Exception.Message)" }
    Start-Sleep -Seconds 2
  }
  Start-NexusFallbackGateway
}
function Cycle() {
  $s8798 = Test-Url "http://127.0.0.1:$KnownGoodCouncilPort/"
  $s8799 = Test-Url "http://127.0.0.1:$CouncilGatewayPort/health"
  $s4000 = Test-Url "http://127.0.0.1:$NexusGatewayPort/v1/models"
  Log "health 8798=$s8798 8799=$s8799 4000=$s4000"
  Start-OllamaIfPresent
  if ($s8799 -eq 0) { Start-CouncilGatewayIfPresent }
  if ($s4000 -eq 0) { Start-NexusGatewayIfPresent; Start-Sleep -Seconds 3 }
  Repair-NexusGatewayIfNeeded
}
Import-RuntimeSettings
if ($Minutes -le 0) { Cycle; exit 0 }
$until = (Get-Date).AddMinutes($Minutes)
while ((Get-Date) -lt $until) { Cycle; Start-Sleep -Seconds 60 }
