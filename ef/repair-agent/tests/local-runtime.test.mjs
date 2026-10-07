import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel, checkEvents } from '../candidate/Verify-Local-Council.mjs';
test('chooses installed Qwen3, never silently switches to a different model family', () => {
 assert.equal(chooseModel({models:[{name:'gemma3:4b'},{name:'qwen3:8b'}]}),'qwen3:8b');
 assert.throws(()=>chooseModel({models:[{name:'qwen3:14b'}]}), /Configured model/);
 assert.equal(chooseModel({models:[{name:'qwen3:14b'}]}, 'qwen3:14b'),'qwen3:14b');
 assert.throws(()=>chooseModel({models:[{name:'gemma3:4b'}]}));
});
test('HTTP success or streamed text alone never proves agent completion', () => {
 const token=JSON.stringify({name:'agent.token',payload:{delta:'COUNCIL_LOCAL_OK'}})+'\n';
 for(const reason of ['error','budget','max_iters','interrupted'])assert.throws(()=>checkEvents(token+JSON.stringify({name:'agent.run.end',payload:{reason}})));
 assert.throws(()=>checkEvents(token));
 assert.equal(checkEvents(token+JSON.stringify({name:'agent.run.end',payload:{reason:'done'}})).completed,true);
});
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verify } from '../candidate/Verify-Local-Council.mjs';
async function acceptanceFixture(t, reason='done') {
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'council-verify-test-'));
 fs.mkdirSync(path.join(folder,'sidecar'));
 fs.writeFileSync(path.join(folder,'sidecar','index.js'), `
 const http=require('node:http');
 const s=http.createServer((req,res)=>{
  if(req.headers['x-starnet-token']!==process.env.STARNET_API_TOKEN){res.writeHead(403);res.end();return;}
  if(req.url==='/api/health'){res.end('ok');return;}
  let body='';req.on('data',c=>body+=c);req.on('end',()=>{
   const b=JSON.parse(body);
   if(b.provider!=='ollama'||b.model!=='qwen3:8b'||!b.baseUrl.startsWith('http://127.0.0.1:')){res.writeHead(400);res.end();return;}
   res.end(JSON.stringify({name:'agent.token',payload:{delta:'COUNCIL_LOCAL_OK'}})+'\\n'+JSON.stringify({name:'agent.run.end',payload:{reason:${JSON.stringify(reason)}}})+'\\n');
  });
 });s.listen(Number(process.env.STARNET_PORT),'127.0.0.1');`);
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({models:[{name:'qwen3:8b'}]}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(folder,{recursive:true,force:true});});
 return {folder,baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'};
}
test('acceptance driver starts token-protected runtime and requires a completed local response',async t=>{
 const f=await acceptanceFixture(t);const result=await verify(f.folder,f.baseUrl);
 assert.equal(result.actualRuntimeResponse,'PASS');assert.equal(result.model,'qwen3:8b');assert.equal(result.provider,'ollama');
});
test('acceptance driver refuses a failed actual run despite HTTP 200 and text output',async t=>{
 const f=await acceptanceFixture(t,'error');await assert.rejects(verify(f.folder,f.baseUrl),/Local agent result/);
});
test('acceptance refuses remote model endpoints before any runtime launch',async()=>{
 await assert.rejects(verify('/unused','https://remote.example/v1'),/loopback/);
});

test('natural local-model confirmation is accepted without an exact phrase',()=>{assert.equal(checkEvents(JSON.stringify({name:'agent.token',payload:{delta:'The local connection is working.'}})+'\n'+JSON.stringify({name:'agent.run.end',payload:{reason:'done'}})).completed,true);});
