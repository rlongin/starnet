param([switch]$Apply)
$ErrorActionPreference = "Stop"
$results = [ordered]@{}
function Test-Http($Url,$Timeout=4) {
  try { $r=Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $Timeout; return @{ok=$true;status=[int]$r.StatusCode;body=$r.Content} }
  catch { return @{ok=$false;status=0;body=$_.Exception.Message} }
}
function Test-JsonPost($Url,$Body,$Headers=@{}) {
  try { $r=Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json" -Headers $Headers -Body ($Body|ConvertTo-Json -Depth 8) -TimeoutSec 45; return @{ok=$true;data=$r} }
  catch { return @{ok=$false;error=$_.Exception.Message} }
}
# Recovery Ollama: never stop/restart the user's normal Ollama process.
$ollama=Test-Http "http://127.0.0.1:11435/api/tags"
$results.ollama=@{ok=$ollama.ok;port=11435}
if(-not $ollama.ok -and $Apply) {
  $exe="C:\NexusAI\Ollama-Recovery\bin\ollama.exe"
  if(Test-Path $exe) {
    Start-Process -FilePath $exe -ArgumentList "serve" -WindowStyle Hidden -Environment @{OLLAMA_HOST="127.0.0.1:11435"}
    Start-Sleep -Seconds 3
    $ollama=Test-Http "http://127.0.0.1:11435/api/tags"
    $results.ollama=@{ok=$ollama.ok;port=11435;repaired=$ollama.ok}
  }
}
# Native deterministic inference proves the model, not just the port.
$qwen=Test-JsonPost "http://127.0.0.1:11435/api/generate" @{model="qwen3:8b";prompt="Respond with exactly: NEXUS AI READY";stream=$false;think=$false;options=@{num_predict=24}}
$qwenText=if($qwen.ok){[string]$qwen.data.response}else{""}
$results.qwen=@{ok=($qwen.ok -and $qwenText -match "NEXUS AI READY");sample=$qwenText.Substring(0,[Math]::Min(80,$qwenText.Length))}
# LiteLLM/NexusRENN gateway inference.
$gw=Test-JsonPost "http://127.0.0.1:4000/v1/chat/completions" @{model="nexus-primary";messages=@(@{role="user";content="Respond with exactly: NEXUS AI READY"});max_tokens=24;temperature=0}
$gwText=if($gw.ok){[string]$gw.data.choices[0].message.content}else{""}
$results.nexusrenn=@{ok=($gw.ok -and $gwText -match "NEXUS AI READY");sample=$gwText.Substring(0,[Math]::Min(80,$gwText.Length))}
if(-not $results.nexusrenn.ok -and $Apply) {
  $container=(docker ps -a --filter "name=^nexus-ai-gateway$" --format "{{.Names}}" 2>$null)
  if($container -eq "nexus-ai-gateway") {
    docker restart nexus-ai-gateway | Out-Null
    Start-Sleep -Seconds 5
    $gw=Test-JsonPost "http://127.0.0.1:4000/v1/chat/completions" @{model="nexus-primary";messages=@(@{role="user";content="Respond with exactly: NEXUS AI READY"});max_tokens=24;temperature=0}
    $gwText=if($gw.ok){[string]$gw.data.choices[0].message.content}else{""}
    $results.nexusrenn=@{ok=($gw.ok -and $gwText -match "NEXUS AI READY");repaired=$true;sample=$gwText.Substring(0,[Math]::Min(80,$gwText.Length))}
  }
}
# Preserve the known-good 8798 Council. Probe only; never terminate/restart it.
$council=Test-Http "http://127.0.0.1:8798/"
$results.council=@{ok=$council.ok;port=8798;preserved=$true}
$gateway=Test-Http "http://127.0.0.1:8799/health"
$results.councilGateway=@{ok=$gateway.ok;port=8799}
$results.overall=($results.ollama.ok -and $results.qwen.ok -and $results.nexusrenn.ok -and $results.council.ok -and $results.councilGateway.ok)
$results.timestamp=(Get-Date).ToString("o")
$results | ConvertTo-Json -Depth 8
