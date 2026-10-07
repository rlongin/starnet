# Runs only on a disposable GitHub Windows runner, never on the user's installation.
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This fixture is restricted to the disposable CI runner.' }
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('council-supervisor-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $root 'station\sidecar') -Force | Out-Null
Set-Content (Join-Path $root 'station\sidecar\index.js') '// fixture'
$candidate = Join-Path (Split-Path $PSScriptRoot) 'candidate'
Copy-Item (Join-Path $candidate 'start-recovery-gateway.ps1') $root
Copy-Item (Join-Path $candidate 'Recover-Council.ps1') $root
Copy-Item (Join-Path $candidate 'Council-ProcessOwner.ps1') $root
Copy-Item (Join-Path $candidate 'Register-Council-Startup.ps1') $root
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
foreach ($name in @('council-launch-key.dpapi','recovery-key.dpapi')) {
  ConvertTo-SecureString 'fixture-secret-only-not-a-production-key' -AsPlainText -Force | ConvertFrom-SecureString | Set-Content (Join-Path $root $name)
}
$node = (Get-Command node.exe).Source
@{Release='council-repair-v4-candidate'; WindowsSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; NodeExe=$node; StationRoot=(Join-Path $root 'station'); DataRoot=(Join-Path $root 'members'); GatewayPort=$port; MemberPortStart=58001; LocalModel='fixture'; LocalBaseUrl='http://127.0.0.1:11435/v1'} | ConvertTo-Json | Set-Content (Join-Path $root 'council-config.json')
@'
const fs=require('fs'),http=require('http'),path=require('path');
fs.appendFileSync(path.join(__dirname,'pids.txt'),process.pid+'\n');
let hung=false;
http.createServer((req,res)=>{
 if(req.url==='/hang'){hung=true;res.end('hung');return;}
 if(hung)return;
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify({pid:process.pid,ok:true,release:'council-repair-v4-candidate',launchConfigured:true,stationConfigured:true,localModelConfigured:true}));
}).listen(Number(process.env.EF_COUNCIL_GATEWAY_PORT),'127.0.0.1');
'@ | Set-Content (Join-Path $root 'ef-recovery-gateway.mjs')
# Use CommonJS fixture inside .mjs via createRequire so the real launcher path is exercised.
$fixture = Get-Content (Join-Path $root 'ef-recovery-gateway.mjs') -Raw
$fixture = "import {createRequire} from 'node:module'; import {fileURLToPath} from 'node:url'; const require=createRequire(import.meta.url); const __dirname=require('path').dirname(fileURLToPath(import.meta.url));`n" + $fixture
Set-Content (Join-Path $root 'ef-recovery-gateway.mjs') $fixture
function Ready([int]$differentPid=0,[int]$seconds=35) {
  $deadline=(Get-Date).AddSeconds($seconds)
  while((Get-Date) -lt $deadline) {
    try { $h=Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2; if($h.pid -and $h.pid -ne $differentPid){return $h.pid} } catch {}
    Start-Sleep -Milliseconds 500
  }
  throw 'Fixture did not recover in time.'
}
$supervisor=$null
$taskName='EF Council Gateway'
$shortcut=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Recover Council.lnk'
if ((Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) -or (Test-Path $shortcut)) { throw 'Fixture refuses existing startup artifacts.' }
try {
  $launcher=Join-Path $root 'start-recovery-gateway.ps1'
  & powershell.exe -NoProfile -File $launcher -ValidateOnly
  if($LASTEXITCODE -ne 0){throw 'DPAPI/config preflight failed'}
  $supervisor=Start-Process powershell.exe -PassThru -ArgumentList @('-NoProfile','-File',('"'+$launcher+'"'))
  $first=Ready
  $second=Start-Process powershell.exe -PassThru -Wait -ArgumentList @('-NoProfile','-File',('"'+$launcher+'"'))
  if($second.ExitCode -ne 0){throw 'Singleton launch failed'}
  if((Ready) -ne $first){throw 'Singleton created a duplicate gateway'}
  Stop-Process -Id $first
  $replacement=Ready -differentPid $first
  Invoke-RestMethod "http://127.0.0.1:$port/hang" -TimeoutSec 3 | Out-Null
  $afterHang=Ready -differentPid $replacement -seconds 115
  if($afterHang -eq $replacement){throw 'Hung gateway was not replaced'}
  & powershell.exe -NoProfile -File (Join-Path $root 'Recover-Council.ps1')
  if($LASTEXITCODE -ne 0){throw 'Manual recovery action failed'}
  # Kill the supervisor itself; the next launch must reconcile its orphan.
  Stop-Process -Id $supervisor.Id
  $supervisor.WaitForExit()
  $supervisor=Start-Process powershell.exe -PassThru -ArgumentList @('-NoProfile','-File',('"'+$launcher+'"'))
  [void](Ready -differentPid $afterHang)
  & powershell.exe -NoProfile -File (Join-Path $root 'Register-Council-Startup.ps1')
  if($LASTEXITCODE -ne 0){throw 'Startup registration failed'}
  $registered=Get-ScheduledTask -TaskName $taskName
  if($registered.Settings.ExecutionTimeLimit -ne 'PT0S' -or $registered.Settings.MultipleInstances -ne 'IgnoreNew'){throw 'Startup lifetime or singleton settings wrong'}
  if(!(Test-Path $shortcut)){throw 'Recovery shortcut missing'}
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 3
  if((Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult -ne 0){throw 'Scheduled action did not complete its singleton path'}
  $beforeTask=Ready
  # Recovery may have won the mutex and become the active supervisor. Stop the
  # exact isolated fixture launchers, rather than assuming a stale process ID.
  foreach($ownedSupervisor in Get-CimInstance Win32_Process -Filter "Name='powershell.exe'") {
    if($ownedSupervisor.CommandLine -and $ownedSupervisor.CommandLine.Contains($launcher)) {
      Stop-Process -Id $ownedSupervisor.ProcessId -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName $taskName
  [void](Ready -differentPid $beforeTask)
  if((Get-ScheduledTask -TaskName $taskName).State -ne 'Running'){throw 'Task did not retain the gateway supervisor'}
  Write-Output 'PASS: Windows DPAPI, singleton, gateway crash/hang, supervisor crash, manual recovery, startup registration and Task Scheduler gateway launch.'
} finally {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item $shortcut -ErrorAction SilentlyContinue
  foreach($ownedSupervisor in Get-CimInstance Win32_Process -Filter "Name='powershell.exe'") {
    if($ownedSupervisor.CommandLine -and $ownedSupervisor.CommandLine.Contains((Join-Path $root 'start-recovery-gateway.ps1'))) {
      Stop-Process -Id $ownedSupervisor.ProcessId -ErrorAction SilentlyContinue
    }
  }
  $pidFile=Join-Path $root 'pids.txt'
  if(Test-Path $pidFile){foreach($testPid in Get-Content $pidFile){
    $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$testPid" -ErrorAction SilentlyContinue
    if($proc -and $proc.CommandLine.Contains($root)){Stop-Process -Id ([int]$testPid) -ErrorAction SilentlyContinue}
  }}
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
