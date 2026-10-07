$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$configPath = Join-Path $root 'council-config.json'
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($config.WindowsSid -ne $identity.User.Value) { throw 'Register startup as the account that owns the saved Council keys.' }
$launcher = Join-Path $root 'start-recovery-gateway.ps1'
$recovery = Join-Path $root 'Recover-Council.ps1'
foreach ($file in @($launcher, $recovery)) { if (!(Test-Path -LiteralPath $file)) { throw "Missing Council file: $file" } }
& (Join-Path $PSHOME 'powershell.exe') -NoProfile -File $launcher -ValidateOnly
if ($LASTEXITCODE -ne 0) { throw 'Council startup validation failed. No task registered.' }
$taskName = 'EF Council Gateway'
$description = 'EF Ventures Council gateway managed startup'
$old = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($old -and $old.Description -ne $description) { throw 'An unrelated task uses this name. It was left untouched.' }
$backup = Join-Path $root ('CouncilBackups\startup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item $configPath (Join-Path $backup 'council-config.json')
if ($old) { Export-ScheduledTask -TaskName $taskName | Set-Content (Join-Path $backup 'task.xml') -Encoding Unicode }
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Recover Council.lnk'
if (Test-Path $shortcutPath) {
  $shell = New-Object -ComObject WScript.Shell
  if ($shell.CreateShortcut($shortcutPath).Description -ne 'EF Ventures Council recovery') { throw 'An unrelated recovery shortcut exists.' }
  Copy-Item $shortcutPath (Join-Path $backup 'Recover Council.lnk')
}
try {
  $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoProfile -NonInteractive -File "' + $launcher + '"') -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description -Force | Out-Null
  $config | Add-Member -NotePropertyName StartupTask -NotePropertyValue $taskName -Force
  $config | ConvertTo-Json -Depth 8 | Set-Content $configPath -Encoding UTF8
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
  $shortcut.Arguments = '-NoProfile -NoExit -File "' + $recovery + '"'
  $shortcut.WorkingDirectory = $root
  $shortcut.Description = 'EF Ventures Council recovery'
  $shortcut.Save()
  $saved = Get-ScheduledTask -TaskName $taskName
  if ($saved.Actions.Execute -ne $action.Execute -or $saved.Actions.Arguments -ne $action.Arguments -or $saved.Principal.UserId -notin @($identity.Name, $identity.User.Value)) { throw 'Startup read-back mismatch.' }
  Write-Output 'Council sign-in task and Recover Council shortcut saved. Actual sign-in/reboot acceptance remains required.'
} catch {
  Copy-Item (Join-Path $backup 'council-config.json') $configPath -Force
  if ($old) { Register-ScheduledTask -TaskName $taskName -Xml (Get-Content (Join-Path $backup 'task.xml') -Raw) -Force | Out-Null }
  else { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }
  if (Test-Path (Join-Path $backup 'Recover Council.lnk')) { Copy-Item (Join-Path $backup 'Recover Council.lnk') $shortcutPath -Force }
  else { Remove-Item $shortcutPath -Force -ErrorAction SilentlyContinue }
  throw
}
