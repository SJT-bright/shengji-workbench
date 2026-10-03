import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;}
async function fixture(t,{aiEndpoint='http://127.0.0.1:1/api/chat'}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shengji-gc-test-')),data=path.join(dir,'data'),inbox=path.join(dir,'inbox');await fs.mkdir(data);await fs.mkdir(inbox);
 const token='gc-test-token';const port=await freePort();
 await fs.writeFile(path.join(data,'library.json'),JSON.stringify({version:2,records:[],revision:0,seenHashes:[],settings:{watchFolder:inbox,watchEnabled:true,autoAnalyze:false,model:'qwen2.5:7b'}}));
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,SHENGJI_PORT:String(port),SHENGJI_TOKEN:token,SHENGJI_DATA_DIR:data,SHENGJI_INBOX:inbox,SHENGJI_AI_ENDPOINT:aiEndpoint},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 t.after(async()=>{child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(2000)]);if(child.exitCode===null)child.kill('SIGKILL');await fs.rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${port}`;
 const api=async(route,{method='GET',body,headers={}}={})=>{const response=await fetch(base+route,{method,headers:{'x-shengji-token':token,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 for(let i=0;i<100;i++){try{if((await api('/api/health')).status===200)return{api,data,inbox,dir,logs:()=>logs};}catch{}await sleep(30);}throw new Error('Isolated server startup failed: '+logs);
}
const exists=async file=>{try{await fs.stat(file);return true}catch{return false}};
const age=async (file,ms=120000)=>{const past=new Date(Date.now()-ms);await fs.utimes(file,past,past)};
const waitFor=async (predicate,timeout=6000)=>{const start=Date.now();for(;;){if(await predicate())return;if(Date.now()-start>timeout)throw new Error('waitFor 超时');await sleep(100)}};
const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
function wav(seed){const bytes=Buffer.alloc(44);bytes.write('RIFF',0);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(seed,40);return bytes}

test('deleting an audio record reclaims its audio and original while shared originals survive',async t=>{
 const {api,data}=await fixture(t);
 const raw='1\r\n00:00:00,000 --> 00:00:01,000\r\n两条录音共享的配套文字稿。\r\n';
 const importAudio=async seed=>(await api('/api/import-audio',{method:'POST',body:{audio:{name:`录音${seed}.wav`,data:wav(seed).toString('base64')},autoAnalyze:false,autoTranscribe:false}})).body.record;
 const first=await importAudio(1),second=await importAudio(2);
 assert.equal(first.duplicate,undefined);assert.equal(second.duplicate,undefined);
 for(const record of [first,second])assert.equal((await api('/api/transcript',{method:'POST',body:{id:record.id,revision:record.revision,text:raw,filename:'共享.srt',autoAnalyze:false}})).status,200);
 const state=(await api('/api/state')).body,records=state.records;
 assert.equal(records.length,2);
 const sharedHash=sha256('两条录音共享的配套文字稿。');
 const original=path.join(data,'originals',sharedHash+'.txt');
 assert.equal(await fs.readFile(original,'utf8'),raw);
 for(const record of records)assert.equal(await fs.readFile(path.join(data,'audio',record.audio.hash)).then(b=>b.length>0),true);
 for(const file of [original,...records.map(r=>path.join(data,'audio',r.audio.hash))])await age(file);
 await api('/api/records',{method:'DELETE',body:{id:first.id}});
 await waitFor(async()=>!(await exists(path.join(data,'audio',first.audio.hash))));
 assert.equal(await exists(original),true,'仍被第二条记录引用的共享原文必须保留');
 assert.equal(await exists(path.join(data,'audio',second.audio.hash)),true,'仍被引用的音频必须保留');
 await api('/api/records',{method:'DELETE',body:{id:second.id}});
 await waitFor(async()=>!(await exists(path.join(data,'audio',second.audio.hash))));
 await waitFor(async()=>!(await exists(original)));
});

test('restore replaces the library and orphans of the old library are reclaimed',async t=>{
 const {api,data,logs}=await fixture(t);
 const imported=await api('/api/import',{method:'POST',body:{text:'旧库里唯一的原文。',autoAnalyze:false}});
 const record=imported.body.record,original=path.join(data,'originals',record.source.hash+'.txt');
 assert.equal(await fs.readFile(original,'utf8'),record.transcript);
 await age(original);
 const backup=(await api('/api/backup')).body;
 assert.equal((await api('/api/restore',{method:'POST',body:{version:2,records:[]}})).status,200);
 await waitFor(async()=>!(await exists(original)));
 assert.match(logs(),/孤儿文件回收：已删除 1 个/);
 assert.equal((await api('/api/restore',{method:'POST',body:backup})).status,200);
 assert.equal(await fs.readFile(original,'utf8'),record.transcript,'恢复备份后原文必须重新落盘');
 await sleep(2000);
 assert.equal(await fs.readFile(original,'utf8'),record.transcript,'恢复后的原文仍在宽限期内且被引用，不得回收');
});

test('only files unreferenced by library changes are reclaimed; pre-existing files stay intact',async t=>{
 const {api,data}=await fixture(t);
 const originals=path.join(data,'originals'),audio=path.join(data,'audio');
 const agedOriginal=path.join(originals,'a'.repeat(64)+'.txt'),agedAudio=path.join(audio,'c'.repeat(64));
 await fs.writeFile(agedOriginal,'旧版留下的未关联原文');await fs.writeFile(agedAudio,'旧版留下的未关联音频');
 await age(agedOriginal);await age(agedAudio);
 const imported=await api('/api/import',{method:'POST',body:{text:'仍被引用的原文。',autoAnalyze:false}});
 const referenced=path.join(originals,imported.body.record.source.hash+'.txt');await age(referenced);
 const fresh=(await api('/api/import',{method:'POST',body:{text:'删除后先经过宽限期的原文。',autoAnalyze:false}})).body.record;
 const freshFile=path.join(originals,fresh.source.hash+'.txt');
 await api('/api/records',{method:'DELETE',body:{id:fresh.id}});
 await sleep(1500);
 assert.equal(await exists(freshFile),true,'宽限期内的原文不得删除');
 assert.equal(await exists(agedOriginal),true,'未因本次记录删除失去引用的旧原文必须保留');
 assert.equal(await exists(agedAudio),true,'旧版留下的未关联音频必须保留');
 assert.equal(await exists(referenced),true,'仍被引用的原文不得删除');
 await age(freshFile);
 await api('/api/records',{method:'DELETE',body:{id:'不存在的记录'}});
 await waitFor(async()=>!(await exists(freshFile)));
 assert.equal(await exists(agedOriginal),true);
 assert.equal(await exists(agedAudio),true);
});
