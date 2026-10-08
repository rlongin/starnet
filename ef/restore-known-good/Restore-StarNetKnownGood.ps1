<#
Restores Ricardo's StarNet/Nexus local setup to the last known-good Council/Nexus settings.

Default mode is audit-only. Pass -Apply to change the Windows machine.
This script backs up config before writing, stashes repo changes before checkout,
and registers a limited current-user startup task for the supervisor.
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$Quiet,
  [string]$StarNetPath = "C:\Users\Ricardo\Documents\GitHub\starnet",
  [string]$NexusPath = "C:\Users\Ricardo\Documents\GitHub\efv-nexus-hub",
  [string]$BackupRoot = "C:\NexusAI\KnownGoodRestore",
  [string]$StarNetBranch = "backup/council-station-working-20260928",
  [string]$StarNetCommit = "24cf4da4f2e0e5a9374797bed17f087401859ed7",
  [string]$NexusBranch = "backup/nexusrenn-golden-2026-09-24",
  [string]$NexusCommit = "390449bc1decc21c1c3334c44c0271437d9f071f",
  [string]$CodexModel = "gpt-5.5",
  [string]$CouncilModel = "qwen3:8b",
  [int[]]$OllamaPorts = @(11434, 11435),
  [int]$NexusGatewayPort = 4000,
  [int]$KnownGoodCouncilPort = 8798,
  [int]$CouncilGatewayPort = 8799,
  [int]$FirstMemberPort = 8801,
  [string]$NexusRennModelRoute = "nexus-primary",
  [string]$NexusRennModelName = "Laleau"
)
$ErrorActionPreference = "Stop"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runRoot = Join-Path $BackupRoot $stamp
$actions = New-Object System.Collections.Generic.List[object]
$packageRoot = $PSScriptRoot

function Add-Action([string]$Name, [bool]$Ok, [string]$Detail = "", $Data = $null) {
  $row = [ordered]@{ name = $Name; ok = $Ok; detail = $Detail }
  if ($null -ne $Data) { $row.data = $Data }
  $actions.Add($row) | Out-Null
  if (-not $Quiet) {
    $status = if ($Ok) { "OK" } else { "FAIL" }
    Write-Host "[$status] $Name $Detail"
  }
}
function Ensure-Directory([string]$Path) {
  if ($Apply -and -not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}
function Invoke-Checked([string]$File, [string[]]$ArgumentList, [string]$WorkingDirectory = $PWD.Path) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $File
  foreach ($a in $ArgumentList) { [void]$psi.ArgumentList.Add($a) }
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
  $stdout = $p.StandardOutput.ReadToEnd()
  $stderr = $p.StandardError.ReadToEnd()
  if ($p.ExitCode -ne 0) { throw "$File $($ArgumentList -join ' ') failed with exit $($p.ExitCode): $stderr $stdout" }
  return $stdout.Trim()
}
function Test-HttpJson([string]$Url, [int]$TimeoutSec = 4) {
  try { return Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSec -ErrorAction Stop } catch { return $null }
}
function Test-HttpText([string]$Url, [int]$TimeoutSec = 4) {
  try { return Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec -ErrorAction Stop } catch { return $null }
}
function Detect-OllamaPort([string]$Model) {
  foreach ($port in $OllamaPorts) {
    $tags = Test-HttpJson "http://127.0.0.1:$port/api/tags"
    if ($null -eq $tags) { continue }
    $names = @()
    if ($tags.models) { $names += @($tags.models | ForEach-Object { $_.name; $_.model }) }
    if ($names -contains $Model) { return $port }
  }
  foreach ($port in $OllamaPorts) {
    if (Test-HttpJson "http://127.0.0.1:$port/api/tags") { return $port }
  }
  return $null
}
function Backup-File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  Ensure-Directory $runRoot
  $safe = ($Path -replace '[:\\/]+','_').Trim('_')
  $dest = Join-Path $runRoot $safe
  if ($Apply) { Copy-Item -LiteralPath $Path -Destination $dest -Force }
  return $dest
}
function Write-TextFile([string]$Path, [string]$Content) {
  Ensure-Directory (Split-Path -Parent $Path)
  if ($Apply) { Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 }
}
function Restore-GitRepo([string]$Path, [string]$Branch, [string]$Commit, [string]$LocalBranch) {
  if (-not (Test-Path -LiteralPath (Join-Path $Path ".git"))) { Add-Action "git:$LocalBranch" $false "missing repo $Path"; return }
  $head = Invoke-Checked -File "git" -ArgumentList @("rev-parse", "HEAD") -WorkingDirectory $Path
  $dirty = Invoke-Checked -File "git" -ArgumentList @("status", "--porcelain") -WorkingDirectory $Path
  if ($Apply -and $dirty) {
    Invoke-Checked -File "git" -ArgumentList @("stash", "push", "-u", "-m", "pre-known-good-restore-$stamp") -WorkingDirectory $Path | Out-Null
  }
  if ($Apply) {
    Invoke-Checked -File "git" -ArgumentList @("fetch", "--no-tags", "origin", $Branch) -WorkingDirectory $Path | Out-Null
    Invoke-Checked -File "git" -ArgumentList @("switch", "-C", $LocalBranch, $Commit) -WorkingDirectory $Path | Out-Null
  }
  Add-Action "git:$LocalBranch" $true "current=$head target=$Commit dirty=$([bool]$dirty)"
}
function Configure-Codex([string]$RepoPath) {
  $codex = Get-Command codex -ErrorAction SilentlyContinue
  Add-Action "codex-cli" ([bool]$codex) $(if($codex){$codex.Source}else{"codex command not found"})
  $cfgPath = Join-Path $env:USERPROFILE ".codex\config.toml"
  $backup = Backup-File $cfgPath
  $content = @"
model = "$CodexModel"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
model_reasoning_effort = "medium"
web_search = "cached"

[windows]
sandbox = "elevated"
"@
  Write-TextFile $cfgPath $content
  $projectCfg = Join-Path $RepoPath ".codex\config.toml"
  Write-TextFile $projectCfg $content
  Add-Action "codex-config" $true "model=$CodexModel approval=on-request sandbox=workspace-write backup=$backup"
  $launcher = Join-Path $BackupRoot "START-STARNET-CODEX-GPT55.cmd"
  $cmd = @"
@echo off
cd /d "$RepoPath"
codex --model $CodexModel --ask-for-approval on-request --sandbox workspace-write --cd "$RepoPath"
"@
  Write-TextFile $launcher $cmd
  Add-Action "codex-launcher" $true $launcher
}
function Write-RuntimeSettings([int]$OllamaPort) {
  $envPath = Join-Path $BackupRoot "known-good-runtime.env"
  $base = "http://127.0.0.1:$OllamaPort/v1"
  $content = @"
EF_COUNCIL_LOCAL_MODEL=$CouncilModel
EF_COUNCIL_LOCAL_BASE_URL=$base
EF_COUNCIL_GATEWAY_PORT=$CouncilGatewayPort
EF_COUNCIL_MEMBER_PORT_START=$FirstMemberPort
LOCAL_AI_GATEWAY_URL=http://127.0.0.1:$NexusGatewayPort/v1/chat/completions
NEXUSRENN_MODEL_ROUTE=$NexusRennModelRoute
NEXUSRENN_MODEL_NAME=$NexusRennModelName
STARNET_DEFAULT_MODEL=$CouncilModel
OLLAMA_BASE_URL=$base
"@
  Write-TextFile $envPath $content
  Add-Action "runtime-env" $true $envPath @{ ollamaPort=$OllamaPort; councilModel=$CouncilModel; nexusRoute=$NexusRennModelRoute }
}
function Register-SupervisorTask() {
  $supervisor = Join-Path $packageRoot "Start-StarNetKnownGoodSupervisor.ps1"
  if (-not (Test-Path -LiteralPath $supervisor)) { Add-Action "startup-task" $false "missing $supervisor"; return }
  if ($Apply) {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$supervisor`" -StarNetPath `"$StarNetPath`" -BackupRoot `"$BackupRoot`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 7) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName "EF StarNet KnownGood Supervisor" -Action $action -Trigger $trigger -Settings $settings -Description "Restarts EF Council/Nexus local health checks after login." -Force | Out-Null
  }
  Add-Action "startup-task" $true "EF StarNet KnownGood Supervisor"
}

Ensure-Directory $runRoot
if ($Apply) {
  $stablePackageRoot = Join-Path $BackupRoot "restore-package"
  Ensure-Directory $stablePackageRoot
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "*") -Destination $stablePackageRoot -Recurse -Force
  $packageRoot = $stablePackageRoot
  Add-Action "self-copy" $true $stablePackageRoot
}
$ollamaPort = Detect-OllamaPort $CouncilModel
if ($null -eq $ollamaPort) { $ollamaPort = 11434; Add-Action "ollama-detect" $false "model $CouncilModel not reachable; defaulting to $ollamaPort" } else { Add-Action "ollama-detect" $true "port=$ollamaPort model=$CouncilModel" }
Restore-GitRepo $StarNetPath $StarNetBranch $StarNetCommit "known-good-council-20260928"
if (Test-Path -LiteralPath $NexusPath) { Restore-GitRepo $NexusPath $NexusBranch $NexusCommit "known-good-nexusrenn-20260924" } else { Add-Action "git:known-good-nexusrenn-20260924" $false "missing Nexus repo $NexusPath" }
Configure-Codex $StarNetPath
Write-RuntimeSettings $ollamaPort
Register-SupervisorTask

$verify = & (Join-Path $packageRoot "Verify-StarNetKnownGood.ps1") -CouncilModel $CouncilModel -OllamaPort $ollamaPort -NexusGatewayPort $NexusGatewayPort -KnownGoodCouncilPort $KnownGoodCouncilPort -CouncilGatewayPort $CouncilGatewayPort -NexusRennModelRoute $NexusRennModelRoute -Quiet
Add-Action "verification" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE" $verify
$result = [ordered]@{ applied = [bool]$Apply; timestamp = (Get-Date).ToString("o"); backupRoot = $runRoot; actions = $actions }
$json = $result | ConvertTo-Json -Depth 12
if ($Apply) { Set-Content -LiteralPath (Join-Path $runRoot "restore-result.json") -Value $json -Encoding UTF8 }
$json
if (($actions | Where-Object { -not $_.ok }).Count -gt 0) { exit 1 }
