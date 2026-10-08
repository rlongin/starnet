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

function Start-OllamaIfPresent() {
  if ((Test-Url "http://127.0.0.1:$OllamaPort/api/tags") -ne 0) { return }
  $candidates = @(
    "C:\NexusAI\Ollama-Recovery\bin\ollama.exe",
    "C:\Program Files\Ollama\ollama.exe",
    (Get-Command ollama.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if (-not $candidates -or $candidates.Count -eq 0) { Log "ollama missing for port $OllamaPort"; return }
  $env:OLLAMA_HOST = "127.0.0.1:$OllamaPort"
  Start-Process -FilePath $candidates[0] -ArgumentList @("serve") -WindowStyle Hidden
  Log "started Ollama $($candidates[0]) on $env:OLLAMA_HOST"
}

function Start-CouncilGatewayIfPresent() {
  $existing = Join-Path "C:\NexusAI\Recovery" "start-recovery-gateway.ps1"
  if (Test-Path -LiteralPath $existing) { Start-Process powershell.exe -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$existing) -WindowStyle Hidden; Log "started existing recovery gateway script"; return }
  $entry = Join-Path $StarNetPath "scripts\ef-nexus-council-gateway.mjs"
  if (Test-Path -LiteralPath $entry) {
    $env:EF_COUNCIL_LOCAL_MODEL = $CouncilModel
    $env:EF_COUNCIL_LOCAL_BASE_URL = "http://127.0.0.1:$OllamaPort/v1"
    $env:EF_COUNCIL_GATEWAY_PORT = [string]$CouncilGatewayPort
    Start-Process node.exe -ArgumentList @($entry) -WorkingDirectory $StarNetPath -WindowStyle Hidden
    Log "started repo council gateway $entry"
  } else { Log "no council gateway launcher found" }
}
function Start-NexusGatewayIfPresent() {
  $container = try { docker ps -a --filter "name=^nexus-ai-gateway$" --format "{{.Names}}" 2>$null } catch { "" }
  if ($container -eq "nexus-ai-gateway") { docker start nexus-ai-gateway | Out-Null; Log "started nexus-ai-gateway container" }
}
function Cycle() {
  $s8798 = Test-Url "http://127.0.0.1:$KnownGoodCouncilPort/"
  $s8799 = Test-Url "http://127.0.0.1:$CouncilGatewayPort/health"
  $s4000 = Test-Url "http://127.0.0.1:$NexusGatewayPort/v1/models"
  Log "health 8798=$s8798 8799=$s8799 4000=$s4000"
  Start-OllamaIfPresent
  if ($s8799 -eq 0) { Start-CouncilGatewayIfPresent }
  if ($s4000 -eq 0) { Start-NexusGatewayIfPresent }
}
if ($Minutes -le 0) { Cycle; exit 0 }
$until = (Get-Date).AddMinutes($Minutes)
while ((Get-Date) -lt $until) { Cycle; Start-Sleep -Seconds 60 }

