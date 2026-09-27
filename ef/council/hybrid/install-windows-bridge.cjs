'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { bridgeConfiguration } = require('./config.cjs');
const quote = s => "'" + String(s).replace(/'/g, "''") + "'";
function main() {
  if (process.platform !== 'win32') throw Error('Run this installer on the Windows PC');
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node 22+ is required');
  const remove = process.argv.includes('--remove');
  const configIndex = process.argv.indexOf('--config');
  let configFile;
  if (!remove) {
    if (configIndex < 0 || !process.argv[configIndex + 1]) throw Error('Supply --config with the private bridge.env path');
    configFile = path.resolve(process.argv[configIndex + 1]);
    if (!fs.statSync(configFile).isFile()) throw Error('Bridge configuration file missing');
    process.loadEnvFile(configFile); bridgeConfiguration();
  }
  const runner = path.join(__dirname, 'pc-bridge.cjs');
  for (const file of [configFile, runner].filter(Boolean)) if (/["\r\n]/.test(file)) throw Error('Unsupported path characters');
  const marker = 'EF Council outbound Ollama bridge (managed)';
  const script = `
$ErrorActionPreference = 'Stop'
$name = 'EF Council PC Bridge'
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing -and $existing.Description -ne ${quote(marker)}) { throw 'An unrelated task uses this name; it was left unchanged.' }
${remove ? `
if ($existing) { Stop-ScheduledTask -TaskName $name; Unregister-ScheduledTask -TaskName $name -Confirm:$false }
Write-Output 'Removed only the EF Council PC Bridge task.'
` : `
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute ${quote(process.execPath)} -Argument ${quote('--env-file="' + configFile + '" "' + runner + '"')} -WorkingDirectory ${quote(__dirname)}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ${quote(marker)} -Force | Out-Null
$saved = Get-ScheduledTask -TaskName $name
if ($saved.Description -ne ${quote(marker)}) { throw 'Task verification failed' }
Write-Output 'Installed EF Council PC Bridge for your next Windows login. Start it from Task Scheduler after configuration is verified.'
`}
`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  console.log(output.trim());
}
if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
