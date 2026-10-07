import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(new URL('../candidate/ef-recovery-gateway.mjs', import.meta.url));
const secret = 'test-only-launch-key-'.repeat(3);
const memberA = '11111111-1111-4111-8111-111111111111';
const memberB = '22222222-2222-4222-8222-222222222222';
const station = `
const http=require('node:http'), crypto=require('node:crypto');
require('node:fs').appendFileSync(process.env.EF_COUNCIL_TEST_PID_FILE,process.pid+'\\n');
let hanging=false;
const server=http.createServer((req,res)=>{
 if(req.url==='/hang'){hanging=true;res.end('hanging');return;}
 if(hanging)return;
 if(req.url==='/api/protected'){res.statusCode=req.headers['x-starnet-token']===process.env.STARNET_API_TOKEN?200:403;res.end('protected');return;}
 if(req.url==='/api/run'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.setHeader('content-type','application/json');res.end(body);});return;}
 if(req.url==='/inspect'){res.setHeader('content-type','application/json');res.end(JSON.stringify({
  pid:process.pid, workspace:process.env.SKYNET_WORKSPACES, secret:!!process.env.EF_COUNCIL_LAUNCH_SECRET,
  recovery:!!process.env.EF_AI_RECOVERY_SECRET, cookie:req.headers.cookie||null,
  authorization:req.headers.authorization||null, origin:req.headers.origin||null}));return;}
 if(req.url==='/cookie'){res.setHeader('set-cookie','station-test=1; Path=/');res.end('cookie');return;}
 if(req.url==='/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\\n\\n');setTimeout(()=>res.end('data: last\\n\\n'),30);return;}
 res.end('fixture station');
});
server.on('upgrade',(req,socket)=>{const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');});
server.listen(Number(process.env.SKYNET_PORT),'127.0.0.1');
`;
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function fixture(t,options={}){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'ef-council-test-'));
 const runtime=path.join(folder,'runtime');fs.mkdirSync(path.join(runtime,'sidecar'),{recursive:true});
 if(!options.missingStation)fs.writeFileSync(path.join(runtime,'sidecar','index.js'),station);
 fs.mkdirSync(path.join(folder,'Recovery'));fs.writeFileSync(path.join(folder,'Recovery','ef-recovery-gateway.mjs'),source);
 const port=await freePort();let memberPort=await freePort();while(memberPort===port||memberPort>65000)memberPort=await freePort();
 const pidFile=path.join(folder,'fixture-pids.txt');
 const spawnGateway=()=>spawn(process.execPath,[path.join(folder,'Recovery','ef-recovery-gateway.mjs')],{env:{...process.env,
 EF_COUNCIL_HANG_GRACE_MS:String(options.hangGraceMs||45000),EF_COUNCIL_GATEWAY_PORT:String(port),EF_COUNCIL_MEMBER_PORT_START:String(memberPort),
 EF_COUNCIL_LAUNCH_SECRET:options.noKey?'':secret,EF_AI_RECOVERY_SECRET:'test-only-recovery-key-'.repeat(2),
 EF_COUNCIL_LOCAL_MODEL:options.localModel||'',EF_COUNCIL_LOCAL_BASE_URL:'http://127.0.0.1:11434/v1',EF_COUNCIL_STATION_ROOT:runtime,EF_COUNCIL_DATA_ROOT:path.join(folder,'members'),EF_COUNCIL_TEST_PID_FILE:pidFile},stdio:'pipe'});
 let child=spawnGateway();
 let errors='';child.stderr.on('data',c=>errors+=c);
 const base='http://127.0.0.1:'+port;
 t.after(async()=>{if(fs.existsSync(pidFile))for(const pid of fs.readFileSync(pidFile,'utf8').trim().split('\n'))try{process.kill(Number(pid),'SIGTERM');}catch{}if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}fs.rmSync(folder,{recursive:true,force:true});});
 const deadline=Date.now()+4000;let ready=false;
 while(Date.now()<deadline){try{await fetch(base+'/health');ready=true;break;}catch{await new Promise(r=>setTimeout(r,25));}}
 assert.ok(ready,'fixture starts: '+errors);
 function ticket(member=memberA,iat=Date.now()){const p=Buffer.from(JSON.stringify({sub:member,iat,agent:crypto.randomUUID()})).toString('base64url');return p+'.'+crypto.createHmac('sha256',secret).update(p).digest('base64url');}
 async function launch(member=memberA){const r=await fetch(base+'/launch?ticket='+ticket(member),{redirect:'manual'});assert.equal(r.status,302,await r.clone().text());return {cookie:r.headers.get('set-cookie').split(';')[0],location:r.headers.get('location')};}
 async function crashRestart(){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));child=spawnGateway();child.stderr.on('data',()=>{});const deadline=Date.now()+4000;while(Date.now()<deadline){try{await fetch(base+'/health');return;}catch{await new Promise(r=>setTimeout(r,25));}}throw Error('restart timeout');}
 return {base,port,memberPort,folder,ticket,launch,crashRestart};
}

test('readiness reports usable key and configured station independently',async t=>{const f=await fixture(t);const j=await(await fetch(f.base+'/health')).json();assert.equal(j.launchConfigured,true);assert.equal(j.stationConfigured,true);assert.equal(j.release,'council-repair-v4-candidate');});
test('missing key still permits health but blocks launch',async t=>{const f=await fixture(t,{noKey:true});const h=await(await fetch(f.base+'/health')).json();assert.equal(h.launchConfigured,false);const r=await fetch(f.base+'/launch?ticket='+f.ticket());assert.equal(r.status,401);assert.match(await r.text(),/key is not configured/);});
test('missing runtime is identified before spawning',async t=>{const f=await fixture(t,{missingStation:true});assert.equal((await(await fetch(f.base+'/health')).json()).stationConfigured,false);const r=await fetch(f.base+'/launch?ticket='+f.ticket());assert.match(await r.text(),/station entry is missing/);});
test('launch uses cookie session and omits session id from redirect URL',async t=>{const f=await fixture(t);const s=await f.launch();assert.ok(s.cookie.startsWith('ef_council_session='));assert.ok(!s.location.includes('ef_session'));assert.equal((await fetch(f.base+'/',{headers:{cookie:s.cookie}})).status,200);assert.equal((await fetch(f.base+'/')).status,401);});
test('replay, malformed, expired, future and invalid-member tickets are refused',async t=>{const f=await fixture(t);const tk=f.ticket();assert.equal((await fetch(f.base+'/launch?ticket='+tk,{redirect:'manual'})).status,302);for(const invalid of [tk,tk+'.extra',tk+'x',f.ticket(memberA,Date.now()-130000),f.ticket(memberA,Date.now()+60000),f.ticket('../other')])assert.equal((await fetch(f.base+'/launch?ticket='+invalid,{redirect:'manual'})).status,401);});
test('parallel launches of a member create one station and rotate old sessions',async t=>{const f=await fixture(t);const responses=await Promise.all([f.launch(),f.launch()]);const health=await(await fetch(f.base+'/health')).json();assert.equal(health.activeStations,1);const statuses=await Promise.all(responses.map(s=>fetch(f.base+'/',{headers:{cookie:s.cookie}}).then(r=>r.status)));assert.deepEqual(statuses.sort(),[200,401]);});
test('members receive distinct stable data directories; gateway credentials do not reach child',async t=>{const f=await fixture(t);const a=await f.launch();const b=await f.launch(memberB);const inspect=async s=>(await(await fetch(f.base+'/inspect',{headers:{cookie:s.cookie,authorization:'Bearer gateway-test',origin:'https://council.efventures.app'}})).json());const ja=await inspect(a),jb=await inspect(b);assert.notEqual(ja.workspace,jb.workspace);assert.match(ja.workspace,/[a-f0-9]{32}$/);assert.equal(ja.secret,false);assert.equal(ja.recovery,false);assert.equal(ja.cookie,null);assert.equal(ja.authorization,null);assert.match(ja.origin,/http:\/\/127\.0\.0\.1:/);});
test('query or Referer cannot substitute for session cookie; foreign origin refused',async t=>{const f=await fixture(t);const a=await f.launch();const id=a.cookie.split('=')[1];assert.equal((await fetch(f.base+'/?ef_session='+id)).status,401);assert.equal((await fetch(f.base+'/',{headers:{referer:'https://council.efventures.app/?ef_session='+id}})).status,401);assert.equal((await fetch(f.base+'/',{headers:{cookie:a.cookie,origin:'https://foreign.test'}})).status,403);});
test('upstream cookies and gateway renewal cookies coexist',async t=>{const f=await fixture(t);const a=await f.launch();const r=await fetch(f.base+'/cookie',{headers:{cookie:a.cookie}});assert.match(r.headers.get('set-cookie'),/station-test=1/);});
test('SSE events are forwarded with no buffering cache headers',async t=>{const f=await fixture(t);const a=await f.launch();const r=await fetch(f.base+'/events',{headers:{cookie:a.cookie}});assert.match(r.headers.get('content-type'),/text\/event-stream/);assert.match(r.headers.get('cache-control'),/no-transform/);assert.equal(await r.text(),'data: first\n\ndata: last\n\n');});
test('unauthenticated recovery endpoints are denied without executing repair',async t=>{const f=await fixture(t);for(const route of ['/ef-ai/status','/ef-ai/repair'])assert.equal((await fetch(f.base+route,{method:'POST'})).status,403);});
test('crashed gateway re-adopts its signed member station without a duplicate process',{skip: process.platform !== 'win32' && !fs.existsSync('/proc/'+process.pid+'/cmdline') ? 'Sandbox virtual process IDs cannot be verified through /proc; run on the target Windows PC' : false},async t=>{const f=await fixture(t);const a=await f.launch();const before=await(await fetch(f.base+'/inspect',{headers:{cookie:a.cookie}})).json();await f.crashRestart();const again=await f.launch();const after=await(await fetch(f.base+'/inspect',{headers:{cookie:again.cookie}})).json();assert.equal(after.pid,before.pid);assert.equal(after.workspace,before.workspace);assert.equal(fs.readFileSync(path.join(f.folder,'fixture-pids.txt'),'utf8').trim().split('\n').length,1,'gateway restart must not spawn a second station');});
test('tampered station registry fails closed instead of adopting or overwriting it',async t=>{const f=await fixture(t);await f.launch();const filename=path.join(f.folder,'Recovery','council-stations.json');const saved=JSON.parse(fs.readFileSync(filename));saved.signature='0'.repeat(64);fs.writeFileSync(filename,JSON.stringify(saved));await f.crashRestart();const r=await fetch(f.base+'/launch?ticket='+f.ticket());assert.equal(r.status,401);assert.match(await r.text(),/registry cannot be verified/);});
test('WebSocket handshake contains actual HTTP CRLF; unauthenticated handshake denied',async t=>{const f=await fixture(t);const a=await f.launch();async function handshake(cookie){return new Promise((resolve,reject)=>{const socket=net.connect(f.port,'127.0.0.1',()=>socket.write('GET /socket HTTP/1.1\r\nHost: council.efventures.app\r\nOrigin: https://council.efventures.app\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'+(cookie?'Cookie: '+cookie+'\r\n':'')+'\r\n'));socket.setTimeout(3000,()=>{socket.destroy();reject(Error('handshake timeout'));});socket.once('data',c=>{socket.destroy();resolve(c.toString());});socket.once('error',reject);});}assert.match(await handshake(a.cookie),/^HTTP\/1\.1 101[^\r]*\r\n/);assert.match(await handshake(''),/^HTTP\/1\.1 401[^\r]*\r\n/);});

test('station stays alive after gateway crash independently of owner lookup',async t=>{const f=await fixture(t);const a=await f.launch();const before=await(await fetch(f.base+'/inspect',{headers:{cookie:a.cookie}})).json();assert.ok(fs.existsSync(path.join(path.dirname(before.workspace),'_runtime-logs',path.basename(before.workspace)+'.log')));await f.crashRestart();const direct=await(await fetch('http://127.0.0.1:'+f.memberPort+'/inspect')).json();assert.equal(direct.pid,before.pid);assert.equal(fs.readFileSync(path.join(f.folder,'fixture-pids.txt'),'utf8').trim().split('\n').length,1);});

test('Council run is routed to local Ollama and preserves the prompt while excluding remote fallback',async t=>{
 const f=await fixture(t,{localModel:'qwen3:8b'});const s=await f.launch();
 const messages=[{role:'user',content:'Explain my task clearly'}];
 const response=await fetch(f.base+'/api/run',{method:'POST',headers:{cookie:s.cookie,'content-type':'application/json',origin:'https://council.efventures.app'},body:JSON.stringify({provider:'openrouter',model:'old/model',key:'old-cloud-secret',fallbackProviders:['openai'],messages,agentId:'strategist'})});
 assert.equal(response.status,200);const body=await response.json();
 assert.equal(body.provider,'ollama');assert.equal(body.model,'qwen3:8b');assert.equal(body.baseUrl,'http://127.0.0.1:11434/v1');assert.deepEqual(body.messages,messages);assert.equal(body.agentId,'strategist');assert.equal(body.key,undefined);assert.equal(body.fallbackProviders,undefined);
});
test('crashed member runtime recovers through the same gateway session and retains workspace',async t=>{
 const f=await fixture(t);const s=await f.launch();const inspect=async()=>await(await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).json();
 const before=await inspect();process.kill(before.pid,'SIGKILL');
 await new Promise(r=>setTimeout(r,200));
 const after=await inspect();assert.notEqual(after.pid,before.pid);assert.equal(after.workspace,before.workspace);
});
test('parallel requests after member crash start one replacement, preserving the session',async t=>{
 const f=await fixture(t);const s=await f.launch();const before=await(await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).json();
 process.kill(before.pid,'SIGKILL');await new Promise(r=>setTimeout(r,150));
 const responses=await Promise.all(Array.from({length:8},()=>fetch(f.base+'/inspect',{headers:{cookie:s.cookie}}).then(r=>r.json())));
 assert.equal(new Set(responses.map(r=>r.pid)).size,1);assert.equal(fs.readFileSync(path.join(f.folder,'fixture-pids.txt'),'utf8').trim().split('\n').length,2);
});
test('local routing rejects malformed JSON rather than passing a remote request through',async t=>{
 const f=await fixture(t,{localModel:'qwen3:8b'});const s=await f.launch();
 const r=await fetch(f.base+'/api/run',{method:'POST',headers:{cookie:s.cookie,'content-type':'application/json'},body:'not-json'});assert.equal(r.status,400);
});
test('runtime watchdog replaces a crashed member even without a browser request',async t=>{
 const f=await fixture(t);const s=await f.launch();const before=await(await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).json();
 process.kill(before.pid,'SIGKILL');const file=path.join(f.folder,'fixture-pids.txt');
 const deadline=Date.now()+15000;
 while(Date.now()<deadline&&fs.readFileSync(file,'utf8').trim().split('\n').length<2)await new Promise(r=>setTimeout(r,100));
 assert.equal(fs.readFileSync(file,'utf8').trim().split('\n').length,2);
 const after=await(await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).json();assert.equal(after.workspace,before.workspace);assert.notEqual(after.pid,before.pid);
});

test('watchdog refuses to duplicate a live runtime that stops answering HTTP',async t=>{
 const f=await fixture(t);const s=await f.launch();const before=await(await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).json();
 // Linux-only stopped process proves a live-but-unresponsive PID is not replaced.
 if(process.platform==='win32'){t.skip('SIGSTOP proof is POSIX-only');return;}
 process.kill(before.pid,'SIGSTOP');
 try {const r=await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}});assert.equal(r.status,401);assert.equal(fs.readFileSync(path.join(f.folder,'fixture-pids.txt'),'utf8').trim().split('\n').length,1);}
 finally {process.kill(before.pid,'SIGCONT');}
});


test('hung child is replaced after grace without changing its workspace or session',async t=>{
 if(process.platform==='win32'){t.skip('SIGSTOP is POSIX-only; Windows fixture uses stopped HTTP below');return;}
 const f=await fixture(t,{hangGraceMs:1000});const s=await f.launch();
 const before=await(await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).json();
 process.kill(before.pid,'SIGSTOP');
 try {
  assert.equal((await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).status,401);
  await new Promise(r=>setTimeout(r,1100));
  const after=await(await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).json();
  assert.notEqual(after.pid,before.pid);assert.equal(after.workspace,before.workspace);
 } finally {try{process.kill(before.pid,'SIGCONT');}catch{}}
});


test('browser keeps authenticated API access after a member process crash',async t=>{
 const f=await fixture(t);const s=await f.launch();
 const before=await(await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).json();
 process.kill(before.pid,'SIGKILL');await new Promise(r=>setTimeout(r,200));
 const r=await fetch(f.base+'/api/protected',{headers:{cookie:s.cookie,'x-starnet-token':'old-browser-token'}});
 assert.equal(r.status,200,'session supplies the restarted member API token');
 assert.equal((await fetch(f.base+'/api/protected')).status,401);
});
test('live process with a stalled HTTP server recovers on Windows and Linux',async t=>{
 const f=await fixture(t,{hangGraceMs:1000});const s=await f.launch();
 const before=await(await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).json();
 await fetch(f.base+'/hang',{headers:{cookie:s.cookie}});
 assert.equal((await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).status,401);
 await new Promise(r=>setTimeout(r,1100));
 const after=await(await fetch(f.base+'/inspect',{headers:{cookie:s.cookie}})).json();
 assert.notEqual(after.pid,before.pid);assert.equal(after.workspace,before.workspace);
});
