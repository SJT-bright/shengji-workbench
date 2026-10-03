import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {analyzeTranscript,applyAiValue} from '../ai.mjs';
import {localDate} from '../shared.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;}
async function fixture(t,{aiEndpoint='http://127.0.0.1:1/api/chat'}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shengji-isolated-test-')),data=path.join(dir,'data'),inbox=path.join(dir,'inbox');await fs.mkdir(data);await fs.mkdir(inbox);
 const token='isolated-test-token';const port=await freePort();
 await fs.writeFile(path.join(data,'library.json'),JSON.stringify({version:2,records:[],revision:0,seenHashes:[],settings:{watchFolder:inbox,watchEnabled:true,autoAnalyze:false,model:'qwen2.5:7b'}}));
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,SHENGJI_PORT:String(port),SHENGJI_TOKEN:token,SHENGJI_DATA_DIR:data,SHENGJI_INBOX:inbox,SHENGJI_AI_ENDPOINT:aiEndpoint},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 t.after(async()=>{child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(2000)]);if(child.exitCode===null)child.kill('SIGKILL');await fs.rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${port}`;
 const api=async(route,{method='GET',body,headers={}}={})=>{const response=await fetch(base+route,{method,headers:{'x-shengji-token':token,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 for(let i=0;i<100;i++){try{if((await api('/api/health')).status===200)return{api,data,inbox,dir};}catch{}await sleep(30);}throw new Error('Isolated server startup failed: '+logs);
}
test('isolated local API: watcher, raw source, dedup, auth, revision and atomic restore',async t=>{
 const {api,data,inbox}=await fixture(t);
 assert.equal((await api('/api/state',{headers:{'x-shengji-token':'wrong'}})).status,401);
 assert.equal((await api('/api/state',{headers:{Origin:'https://untrusted.invalid'}})).status,403);
 assert.equal((await api('/api/session',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 const raw='1\r\n00:00:01,000 --> 00:00:03,000\r\n这是隔离测试原文。\r\n';await fs.writeFile(path.join(inbox,'test.srt'),raw);
 await api('/api/scan',{method:'POST'});await api('/api/scan',{method:'POST'});
 let state=(await api('/api/state')).body;assert.equal(state.records.length,1);const record=state.records[0];assert.equal(record.transcript,'这是隔离测试原文。');assert.equal(record.ai.status,'none');assert.equal(state.settings.autoAnalyze,false);
 assert.equal(await fs.readFile(path.join(data,'originals',record.source.hash+'.txt'),'utf8'),raw);
 await fs.writeFile(path.join(inbox,'duplicate.srt'),raw);await api('/api/scan',{method:'POST'});await api('/api/scan',{method:'POST'});assert.equal((await api('/api/state')).body.records.length,1);
 const edit=await api('/api/records',{method:'PUT',body:{...record,title:'修改后的标题'}});assert.equal(edit.status,200);assert.equal((await api('/api/records',{method:'PUT',body:{...record,title:'过时的修改'}})).status,409);
 const before=(await api('/api/backup')).body;const broken=structuredClone(before);broken.records.push({...record,id:'bad-record',duration:-1});assert.equal((await api('/api/restore',{method:'POST',body:broken})).status,400);assert.deepEqual((await api('/api/backup')).body.records,before.records);
 assert.equal((await api('/api/state')).body.records[0].ai.status,'none');
});
test('restore safely normalizes a path-bearing source hash without escaping originals',async t=>{
 const {api,data}=await fixture(t);const imported=await api('/api/import',{method:'POST',body:{text:'仅用于隔离审查的原文',autoAnalyze:false}});const record={...imported.body.record,id:'traversal-record',source:{...imported.body.record.source,hash:'../escaped'}};
 const result=await api('/api/restore',{method:'POST',body:{version:2,records:[record]}});
 assert.equal(result.status,200);const saved=(await api('/api/state')).body.records[0];const expected=crypto.createHash('sha256').update(record.transcript).digest('hex');assert.equal(saved.source.hash,expected);assert.equal(await fs.readFile(path.join(data,'originals',expected+'.txt'),'utf8'),record.transcript);await assert.rejects(fs.access(path.join(data,'escaped.txt')),error=>error.code==='ENOENT');
});
test('watcher rejects invalid UTF-8 without creating a lossy record',async t=>{
 const {api,inbox}=await fixture(t);await fs.writeFile(path.join(inbox,'invalid.txt'),Buffer.from([0xff,0xfe,0x41]));await api('/api/scan',{method:'POST'});await api('/api/scan',{method:'POST'});const state=(await api('/api/state')).body;
 assert.equal(state.records.length,0);assert.match(state.watch.error,/UTF-8/);assert.deepEqual(await fs.readFile(path.join(inbox,'invalid.txt')),Buffer.from([0xff,0xfe,0x41]));
});
test('watcher reports oversized text and continues importing later valid files',async t=>{
 const {api,inbox}=await fixture(t);await fs.writeFile(path.join(inbox,'a-too-long.txt'),'A'.repeat(500001));await fs.writeFile(path.join(inbox,'z-valid.txt'),'这段正常的转写应该可以入库。');await api('/api/scan',{method:'POST'});await api('/api/scan',{method:'POST'});await api('/api/scan',{method:'POST'});const state=(await api('/api/state')).body;
 assert.equal(state.records.length,1);assert.equal(state.records[0].transcript,'这段正常的转写应该可以入库。');assert.match(state.watch.error,/a-too-long.txt.*过长/);assert.equal(state.records[0].ai.status,'none');
});
test('portable backup preserves exact SRT source including timestamps and CRLF',async t=>{
 const first=await fixture(t),second=await fixture(t);const raw='1\r\n00:00:01,000 --> 00:00:02,000\r\n备份原文测试。\r\n';await first.api('/api/import',{method:'POST',body:{text:raw,filename:'source.srt',autoAnalyze:false}});const backup=(await first.api('/api/backup')).body;assert.equal((await second.api('/api/restore',{method:'POST',body:backup})).status,200);const record=(await second.api('/api/state')).body.records[0];const restored=await fs.readFile(path.join(second.data,'originals',record.source.hash+'.txt'),'utf8');
 assert.equal(restored,raw);assert.equal(record.transcript,'备份原文测试。');assert.equal(backup.originals[record.source.hash],raw);assert.equal((await second.api('/api/backup')).body.originals[record.source.hash],raw);
});

test('invalid late original in restore leaves database, originals and prior backup untouched',async t=>{
 const {api,data}=await fixture(t);
 const seed=await api('/api/import',{method:'POST',body:{text:'已经保存的重要测试原文',autoAnalyze:false}});assert.equal(seed.status,200);
 const diskBefore=await fs.readFile(path.join(data,'library.json'),'utf8');
 const database=(await api('/api/state')).body.database;assert.equal(database.engine,'SQLite');const sqliteBefore=await fs.readFile(database.path);
 const originalsBefore=await fs.readdir(path.join(data,'originals'));
 const before=(await api('/api/backup')).body;
 const newRecord=(id,text)=>({...seed.body.record,id,transcript:text,source:{name:'test.txt'},revision:1});
 const first=newRecord('first-staged','这是一份尚未保存的有效新原文');
 const last=newRecord('last-invalid','这份原文对应的附件将被故意破坏');
 const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
 const input={version:2,records:[first,last],originals:{[hash(first.transcript)]:first.transcript,[hash(last.transcript)]:'附件与原文不一致'}};
 const response=await api('/api/restore',{method:'POST',body:input});assert.equal(response.status,400);assert.match(response.body.error,/不一致/);
 assert.equal(await fs.readFile(path.join(data,'library.json'),'utf8'),diskBefore);
 assert.deepEqual(await fs.readFile(database.path),sqliteBefore);
 assert.deepEqual(await fs.readdir(path.join(data,'originals')),originalsBefore);
 const after=(await api('/api/backup')).body;assert.deepEqual(after.records,before.records);assert.deepEqual(after.originals,before.originals);
});

test('category CRUD persists, rejects duplicates and moves records to inbox on delete',async t=>{
 const {api}=await fixture(t);let state=(await api('/api/state')).body;
 assert.ok(state.categories.length>=10);
 const custom={id:'custom-english',name:'英语口语',color:'#527778',icon:'mic'};
 let result=await api('/api/categories',{method:'PUT',body:{categories:[...state.categories,custom],revision:state.categoryRevision}});assert.equal(result.status,200);
 let created=await api('/api/import',{method:'POST',body:{text:'隔离验收中的英语练习记录。',category:custom.id,autoAnalyze:false}});assert.equal(created.body.record.category,custom.id);assert.equal(created.body.record.categoryManual,true);
 state=(await api('/api/state')).body;const renamed=state.categories.map(c=>c.id===custom.id?{...c,name:'英语练习'}:c);
 assert.equal((await api('/api/categories',{method:'PUT',body:{categories:renamed,revision:state.categoryRevision}})).status,200);
 assert.equal((await api('/api/categories',{method:'PUT',body:{categories:renamed,revision:state.categoryRevision}})).status,409);
 state=(await api('/api/state')).body;
 assert.equal((await api('/api/categories',{method:'PUT',body:{categories:[...state.categories,{...custom,id:'custom-duplicate',name:'英语练习'}],revision:state.categoryRevision}})).status,400);
 const backup=(await api('/api/backup')).body;assert.ok(backup.categories.some(c=>c.name==='英语练习'));
 assert.equal((await api('/api/categories',{method:'PUT',body:{categories:state.categories.filter(c=>c.id!==custom.id),revision:state.categoryRevision}})).status,200);
 assert.equal((await api('/api/state')).body.records[0].category,'inbox');
 assert.equal((await api('/api/restore',{method:'POST',body:backup})).status,200);
 state=(await api('/api/state')).body;assert.equal(state.records[0].category,custom.id);assert.ok(state.categories.some(c=>c.id===custom.id));
});

test('audio import, raw preservation, paired transcript and portable attachments',async t=>{
 const first=await fixture(t),second=await fixture(t);
 const bytes=Buffer.alloc(44);bytes.write('RIFF',0);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);
 const payload={audio:{name:'测试录音.wav',data:bytes.toString('base64')},autoAnalyze:false,autoTranscribe:false};
 const imported=await first.api('/api/import-audio',{method:'POST',body:payload});assert.equal(imported.status,200);let record=imported.body.record;assert.equal(record.transcription.status,'none');assert.equal(record.transcript,'');assert.equal(record.audio.mime,'audio/wav');
 assert.deepEqual(await fs.readFile(path.join(first.data,'audio',record.audio.hash)),bytes);
 assert.equal((await first.api('/api/import-audio',{method:'POST',body:payload})).body.duplicate,true);
 const raw='1\r\n00:00:00,000 --> 00:00:01,000\r\n这是音频的配套文字稿。\r\n';
 assert.equal((await first.api('/api/transcript',{method:'POST',body:{id:record.id,revision:record.revision,text:raw,filename:'配套.srt',autoAnalyze:false}})).status,200);
 record=(await first.api('/api/state')).body.records[0];assert.equal(record.transcript,'这是音频的配套文字稿。');assert.equal(record.transcription.engine,'manual');assert.equal(record.transcription.status,'done');
 assert.equal((await first.api('/api/transcript',{method:'POST',body:{id:record.id,revision:record.revision,text:'不该覆盖',autoAnalyze:false}})).status,400);
 const backup=(await first.api('/api/backup')).body;assert.equal(backup.audioFiles[record.audio.hash],bytes.toString('base64'));assert.equal((await second.api('/api/restore',{method:'POST',body:backup})).status,200);
 assert.deepEqual(await fs.readFile(path.join(second.data,'audio',record.audio.hash)),bytes);assert.equal(await fs.readFile(path.join(second.data,'originals',record.source.hash+'.txt'),'utf8'),raw);
 const broken=structuredClone(backup);broken.audioFiles[record.audio.hash]=Buffer.from('not audio').toString('base64');assert.equal((await second.api('/api/restore',{method:'POST',body:broken})).status,400);assert.equal((await second.api('/api/state')).body.records[0].transcript,record.transcript);
});

async function seedBackupHistory(api){
 const created=await api('/api/import',{method:'POST',body:{text:'用于备份往返的课程复盘原文。',date:'2026-03-05',autoAnalyze:false}});
 assert.equal(created.status,200);
 const record=created.body.record;
 assert.equal((await api('/api/records',{method:'PUT',body:{...record,actions:['整理课程笔记'],value:'gem',valueSource:'user'}})).status,200);
 assert.equal((await api('/api/action',{method:'POST',body:{recordId:record.id,text:'整理课程笔记',done:true}})).status,200);
 for(const [route,body] of [['digest',{date:'2026-03-05'}],['weekly',{date:'2026-03-05'}],['monthly',{month:'2026-03'}],['yearly',{year:'2026'}]]){
  assert.equal((await api('/api/'+route,{method:'POST',body})).status,200);
 }
 return (await api('/api/state')).body;
}

test('portable backup round-trips all generated reviews and completed actions while keeping local settings',async t=>{
 const first=await fixture(t),second=await fixture(t);
 const before=await seedBackupHistory(first.api);
 const backup=(await first.api('/api/backup')).body;
 const settings=(await second.api('/api/state')).body.settings;
 for(const key of ['digests','weeklies','monthlies','yearlies','doneActions'])assert.deepEqual(backup[key],before[key],key);
 assert.equal((await second.api('/api/restore',{method:'POST',body:backup})).status,200);
 const restored=(await second.api('/api/state')).body;
 const exported=(await second.api('/api/backup')).body;
 for(const key of ['digests','weeklies','monthlies','yearlies','doneActions']){
  assert.deepEqual(restored[key],before[key],key);
  assert.deepEqual(exported[key],before[key],key);
 }
 assert.deepEqual(restored.settings,settings);
});

test('legacy backups without review history clear current history and completed actions',async t=>{
 const {api}=await fixture(t);
 await seedBackupHistory(api);
 const full=(await api('/api/backup')).body;
 const settings=(await api('/api/state')).body.settings;
 for(const version of [1,2]){
  assert.equal((await api('/api/restore',{method:'POST',body:full})).status,200);
  const legacy={version,records:full.records,categories:full.categories,originals:full.originals,audioFiles:full.audioFiles};
  assert.equal((await api('/api/restore',{method:'POST',body:legacy})).status,200);
  const state=(await api('/api/state')).body;
  for(const key of ['digests','weeklies','monthlies','yearlies'])assert.deepEqual(state[key],{},key);
  assert.deepEqual(state.doneActions,[]);
  assert.deepEqual(state.settings,settings);
 }
});

test('invalid backup history is rejected before replacing records or writing original attachments',async t=>{
 const {api,data}=await fixture(t);
 const before=await seedBackupHistory(api);
 const backup=(await api('/api/backup')).body;
 const originalFiles=await fs.readdir(path.join(data,'originals'));
 const sqliteBefore=await fs.readFile(before.database.path);
 const invalidChanges=[
  input=>{input.digests=null},
  input=>{input.weeklies=[]},
  input=>{input.digests['2026-03-05'].date='2026-02-30'},
  input=>{input.weeklies['2026-03-02'].end='2026-03-09'},
  input=>{input.monthlies['2026-03'].month='2026-04'},
  input=>{input.yearlies['2026'].text=17},
  input=>{input.yearlies['2026'].recordCount=-1},
  input=>{input.digests['2026-03-05'].generatedAt='not-a-date'},
  input=>{input.doneActions={}},
  input=>{input.doneActions[0].text=17},
  input=>{input.doneActions[0].at='2026-02-30'},
 ];
 for(const change of invalidChanges){
  const input=structuredClone(backup);
  input.records.push({...backup.records[0],id:'staged-new-record',transcript:'不能在无效备份校验前落盘的新原文。',source:{name:'new.txt'}});
  change(input);
  assert.equal((await api('/api/restore',{method:'POST',body:input})).status,400);
  const after=(await api('/api/state')).body;
  for(const key of ['records','digests','weeklies','monthlies','yearlies','doneActions'])assert.deepEqual(after[key],before[key],key);
  assert.deepEqual(await fs.readdir(path.join(data,'originals')),originalFiles);
  assert.deepEqual(await fs.readFile(before.database.path),sqliteBefore);
 }
});

test('backup history keeps only completed actions belonging to backed-up records and removes duplicates',async t=>{
 const {api}=await fixture(t);
 const before=await seedBackupHistory(api);
 const completed=before.doneActions[0];
 await api('/api/action',{method:'POST',body:{recordId:'removed-record',text:'旧记录的待办',done:true}});
 await api('/api/action',{method:'POST',body:{recordId:completed.recordId,text:'已被改写的待办',done:true}});
 const backup=(await api('/api/backup')).body;
 assert.deepEqual(backup.doneActions,[completed]);
 backup.doneActions.push({...completed},{recordId:'removed-record',text:'旧记录的待办',at:completed.at},{...completed,text:'已被改写的待办'});
 assert.equal((await api('/api/restore',{method:'POST',body:backup})).status,200);
 assert.deepEqual((await api('/api/state')).body.doneActions,[completed]);
});

test('pending period reviews cannot write old-library content after restore, but survive rejected restores',async t=>{
 const scenarios=[
  ['digest',{date:'2026-03-05'},true],
  ['weekly',{date:'2026-03-05'},true],
  ['monthly',{month:'2026-03'},true],
  ['yearly',{year:'2026'},true],
  ['digest',{date:'2026-03-05'},false],
 ];
 for(const [route,body,validRestore] of scenarios)await t.test(`${route}: ${validRestore?'restore succeeds':'restore is rejected'}`,async sub=>{
  let arrived;
  const received=new Promise(resolve=>{arrived=resolve});
  const model=http.createServer((req,res)=>{req.resume();req.on('end',()=>arrived(res))});
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  sub.after(()=>new Promise(resolve=>{model.close(resolve);model.closeAllConnections()}));
  const {api}=await fixture(sub,{aiEndpoint:`http://127.0.0.1:${model.address().port}/api/chat`});
  assert.equal((await api('/api/import',{method:'POST',body:{text:'恢复之前旧库的原文。',date:'2026-03-05',autoAnalyze:false}})).status,200);
  const pending=api('/api/'+route,{method:'POST',body});
  let timeout;
  const response=await Promise.race([received,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('mock model did not receive request')),3000)})]).finally(()=>clearTimeout(timeout));
  const restore={version:2,records:[]};if(!validRestore)restore.digests=null;
  assert.equal((await api('/api/restore',{method:'POST',body:restore})).status,validRestore?200:400);
  response.writeHead(200,{'Content-Type':'application/json'});
  response.end(JSON.stringify({done:true,done_reason:'stop',message:{content:JSON.stringify({text:'旧库原文生成的回顾。'})}}));
  const result=await pending;
  const state=(await api('/api/state')).body;
  if(validRestore){
   assert.equal(result.status,409);assert.match(result.body.error,/恢复|资料库/);
   assert.deepEqual(state.records,[]);
   for(const key of ['digests','weeklies','monthlies','yearlies'])assert.deepEqual(state[key],{},key);
  }else{
   assert.equal(result.status,200);
   assert.equal(state.records.length,1);
   assert.equal(state.digests['2026-03-05'].text,'旧库原文生成的回顾。');
  }
 });
});

test('digest falls back to deterministic text without a model, is stored in state and overwrites per day',async t=>{
 const {api}=await fixture(t);
 assert.deepEqual((await api('/api/state')).body.digests,{});
 const day='2026-03-05';
 const firstImport=await api('/api/import',{method:'POST',body:{text:'第一条原文。',autoAnalyze:false}});
 const secondImport=await api('/api/import',{method:'POST',body:{text:'第二条原文。',autoAnalyze:false}});
 assert.equal(firstImport.status,200);assert.equal(secondImport.status,200);
 const a=firstImport.body.record,b=secondImport.body.record;
 let edit=await api('/api/records',{method:'PUT',body:{...a,title:'晨会记录',date:day,time:'09:00',summary:'这是摘要的第一句。后面还有内容。',actions:['完成周报','整理笔记'],revision:a.revision}});assert.equal(edit.status,200);
 edit=await api('/api/records',{method:'PUT',body:{...b,title:'偶得笔记',date:day,time:'21:00',summary:'',cleanedTranscript:'整理稿的第一句话。后面还有。',revision:b.revision}});assert.equal(edit.status,200);
 const missing=await api('/api/digest',{method:'POST',body:{date:'2026-03-06'}});
 assert.equal(missing.status,400);assert.equal(missing.body.error,'这一天没有记录');
 assert.equal((await api('/api/digest',{method:'POST',body:{date:'03-05'}})).status,400);
 const result=await api('/api/digest',{method:'POST',body:{date:day}});
 assert.equal(result.status,200);
 assert.equal(result.body.model,'fallback');assert.equal(result.body.recordCount,2);assert.equal(result.body.date,day);
 assert(Number.isFinite(Date.parse(result.body.generatedAt)));
 assert.equal(result.body.text,['3月5日 · 共 2 段记录','- 偶得笔记 — 整理稿的第一句话。','- 晨会记录 — 这是摘要的第一句。','接下来：完成周报、整理笔记'].join('\n'));
 let state=(await api('/api/state')).body;
 assert.deepEqual(state.digests[day],result.body);
 state=(await api('/api/state')).body;
 const target=state.records.find(r=>r.title==='晨会记录');
 edit=await api('/api/records',{method:'PUT',body:{...target,title:'改名后的晨会',summary:'新的摘要首句。',actions:[],revision:target.revision}});assert.equal(edit.status,200);
 const again=await api('/api/digest',{method:'POST',body:{date:day}});
 assert.equal(again.status,200);assert.equal(again.body.model,'fallback');
 assert.equal(again.body.text,['3月5日 · 共 2 段记录','- 偶得笔记 — 整理稿的第一句话。','- 改名后的晨会 — 新的摘要首句。'].join('\n'));
 state=(await api('/api/state')).body;
 assert.equal(Object.keys(state.digests).length,1);
 assert.deepEqual(state.digests[day],again.body);
});

test('weekly falls back to deterministic text, keyed by week start in state and overwrites',async t=>{
 const {api}=await fixture(t);
 assert.deepEqual((await api('/api/state')).body.weeklies,{});
 const seed=async(text,title,date,time)=>(await api('/api/import',{method:'POST',body:{text,title,date,time,autoAnalyze:false}})).body.record;
 const a=await seed('周报第一条原文','晨会记录','2026-03-02','09:00');
 await seed('周报第二条原文','早读摘抄','2026-03-03','08:00');
 await seed('周报第三条原文','客户电话','2026-03-03','13:00');
 await seed('周报第四条原文','灵感速记','2026-03-03','19:30');
 await seed('周报第五条原文','晚上的复盘','2026-03-03','21:00');
 const edit=await api('/api/records',{method:'PUT',body:{...a,actions:['完成周报','整理笔记'],revision:a.revision}});assert.equal(edit.status,200);
 const missing=await api('/api/weekly',{method:'POST',body:{date:'2026-03-10'}});
 assert.equal(missing.status,400);assert.equal(missing.body.error,'这一周没有记录');
 assert.equal((await api('/api/weekly',{method:'POST',body:{date:'2026-03-01'}})).status,400);
 assert.equal((await api('/api/weekly',{method:'POST',body:{date:'03-02'}})).status,400);
 const result=await api('/api/weekly',{method:'POST',body:{date:'2026-03-04'}});
 assert.equal(result.status,200);
 assert.equal(result.body.model,'fallback');assert.equal(result.body.start,'2026-03-02');assert.equal(result.body.end,'2026-03-08');
 assert.equal(result.body.recordCount,5);assert.equal(result.body.dayCount,2);
 assert(Number.isFinite(Date.parse(result.body.generatedAt)));
 assert.equal(result.body.text,['3月2日至3月8日 · 共 5 段记录','- 3月2日 · 1 条：晨会记录','- 3月3日 · 4 条：早读摘抄、客户电话、灵感速记等 4 条','本周共留下 2 条待落地行动。'].join('\n'));
 const sunday=await api('/api/weekly',{method:'POST',body:{date:'2026-03-08'}});
 assert.equal(sunday.status,200);assert.equal(sunday.body.start,'2026-03-02');assert.equal(sunday.body.end,'2026-03-08');
 let state=(await api('/api/state')).body;
 assert.deepEqual(state.weeklies['2026-03-02'],sunday.body);
 const target=state.records.find(r=>r.title==='灵感速记');
 const renamed=await api('/api/records',{method:'PUT',body:{...target,title:'灵感便签',revision:target.revision}});assert.equal(renamed.status,200);
 const again=await api('/api/weekly',{method:'POST',body:{date:'2026-03-02'}});
 assert.equal(again.status,200);assert.equal(again.body.model,'fallback');
 assert.equal(again.body.text,['3月2日至3月8日 · 共 5 段记录','- 3月2日 · 1 条：晨会记录','- 3月3日 · 4 条：早读摘抄、客户电话、灵感便签等 4 条','本周共留下 2 条待落地行动。'].join('\n'));
 state=(await api('/api/state')).body;
 assert.deepEqual(Object.keys(state.weeklies),['2026-03-02']);
 assert.deepEqual(state.weeklies['2026-03-02'],again.body);
});

test('monthly falls back to deterministic text, keyed by month in state and overwrites',async t=>{
 const {api}=await fixture(t);
 assert.deepEqual((await api('/api/state')).body.monthlies,{});
 const seed=async(text,title,date,time)=>(await api('/api/import',{method:'POST',body:{text,title,date,time,autoAnalyze:false}})).body.record;
 const a=await seed('月报第一条原文','晨会记录','2026-03-02','09:00');
 await seed('月报第二条原文','客户电话','2026-03-02','13:00');
 await seed('月报第三条原文','灵感速记','2026-03-02','19:30');
 await seed('月报第四条原文','偶得笔记','2026-03-02','21:00');
 await seed('月报第五条原文','晚间复盘','2026-03-10','08:00');
 const edit=await api('/api/records',{method:'PUT',body:{...a,value:'gem',valueSource:'user',reviewCount:2,actions:['完成周报','整理笔记'],revision:a.revision}});assert.equal(edit.status,200);
 const bad=await api('/api/monthly',{method:'POST',body:{month:'2026-13'}});
 assert.equal(bad.status,400);assert.equal(bad.body.error,'月份格式无效，应为 YYYY-MM');
 assert.equal((await api('/api/monthly',{method:'POST',body:{month:'2026-3'}})).status,400);
 assert.equal((await api('/api/monthly',{method:'POST',body:{month:'03'}})).status,400);
 const missing=await api('/api/monthly',{method:'POST',body:{month:'2026-04'}});
 assert.equal(missing.status,400);assert.equal(missing.body.error,'这个月没有记录');
 const result=await api('/api/monthly',{method:'POST',body:{month:'2026-03'}});
 assert.equal(result.status,200);
 assert.equal(result.body.model,'fallback');assert.equal(result.body.month,'2026-03');assert.equal(result.body.start,'2026-03-01');assert.equal(result.body.end,'2026-03-31');
 assert.equal(result.body.recordCount,5);assert.equal(result.body.dayCount,2);
 assert(Number.isFinite(Date.parse(result.body.generatedAt)));
 assert.equal(result.body.text,['3月 · 共 5 段记录','- 3月2日至3月8日 · 4 条：晨会记录、客户电话、灵感速记等 4 条','- 3月9日至3月15日 · 1 条：晚间复盘','其中干货 1 条，复看合计 2 次。','本月共留下 2 条待落地行动。'].join('\n'));
 let state=(await api('/api/state')).body;
 assert.deepEqual(state.monthlies['2026-03'],result.body);
 const target=state.records.find(r=>r.title==='客户电话');
 const renamed=await api('/api/records',{method:'PUT',body:{...target,title:'重要电话',revision:target.revision}});assert.equal(renamed.status,200);
 const again=await api('/api/monthly',{method:'POST',body:{month:'2026-03'}});
 assert.equal(again.status,200);assert.equal(again.body.model,'fallback');
 assert.equal(again.body.text,['3月 · 共 5 段记录','- 3月2日至3月8日 · 4 条：晨会记录、重要电话、灵感速记等 4 条','- 3月9日至3月15日 · 1 条：晚间复盘','其中干货 1 条，复看合计 2 次。','本月共留下 2 条待落地行动。'].join('\n'));
 state=(await api('/api/state')).body;
 assert.deepEqual(Object.keys(state.monthlies),['2026-03']);
 assert.deepEqual(state.monthlies['2026-03'],again.body);
});

test('yearly falls back to deterministic text, keyed by year in state and overwrites',async t=>{
 const {api}=await fixture(t);
 assert.deepEqual((await api('/api/state')).body.yearlies,{});
 const seed=async(text,title,date,time)=>(await api('/api/import',{method:'POST',body:{text,title,date,time,autoAnalyze:false}})).body.record;
 const a=await seed('年报第一条原文','晨会记录','2025-03-02','09:00');
 await seed('年报第二条原文','客户电话','2025-03-02','13:00');
 await seed('年报第三条原文','灵感速记','2025-03-02','19:30');
 await seed('年报第四条原文','偶得笔记','2025-03-02','21:00');
 await seed('年报第五条原文','晚间复盘','2025-06-10','08:00');
 const edit=await api('/api/records',{method:'PUT',body:{...a,value:'gem',valueSource:'user',reviewCount:2,actions:['完成周报','整理笔记'],revision:a.revision}});assert.equal(edit.status,200);
 const bad=await api('/api/yearly',{method:'POST',body:{year:'2025-01'}});
 assert.equal(bad.status,400);assert.equal(bad.body.error,'年份格式无效，应为 YYYY');
 assert.equal((await api('/api/yearly',{method:'POST',body:{year:'25'}})).status,400);
 assert.equal((await api('/api/yearly',{method:'POST',body:{year:'abcd'}})).status,400);
 const missing=await api('/api/yearly',{method:'POST',body:{year:'2024'}});
 assert.equal(missing.status,400);assert.equal(missing.body.error,'这一年没有记录');
 const result=await api('/api/yearly',{method:'POST',body:{year:'2025'}});
 assert.equal(result.status,200);
 assert.equal(result.body.model,'fallback');assert.equal(result.body.year,'2025');assert.equal(result.body.start,'2025-01-01');assert.equal(result.body.end,'2025-12-31');
 assert.equal(result.body.recordCount,5);assert.equal(result.body.dayCount,2);
 assert(Number.isFinite(Date.parse(result.body.generatedAt)));
 assert.equal(result.body.text,['2025年 · 共 5 段记录','- 3月 · 4 条：晨会记录、客户电话、灵感速记等 4 条','- 6月 · 1 条：晚间复盘','其中干货 1 条，复看合计 2 次。','全年共留下 2 条待落地行动。'].join('\n'));
 let state=(await api('/api/state')).body;
 assert.deepEqual(state.yearlies['2025'],result.body);
 const target=state.records.find(r=>r.title==='客户电话');
 const renamed=await api('/api/records',{method:'PUT',body:{...target,title:'重要电话',revision:target.revision}});assert.equal(renamed.status,200);
 const again=await api('/api/yearly',{method:'POST',body:{year:'2025'}});
 assert.equal(again.status,200);assert.equal(again.body.model,'fallback');
 assert.equal(again.body.text,['2025年 · 共 5 段记录','- 3月 · 4 条：晨会记录、重要电话、灵感速记等 4 条','- 6月 · 1 条：晚间复盘','其中干货 1 条，复看合计 2 次。','全年共留下 2 条待落地行动。'].join('\n'));
 state=(await api('/api/state')).body;
 assert.deepEqual(Object.keys(state.yearlies),['2025']);
 assert.deepEqual(state.yearlies['2025'],again.body);
});

test('action toggle appends once, removes matches, rejects bad input and persists doneActions',async t=>{
 const {api}=await fixture(t);
 assert.deepEqual((await api('/api/state')).body.doneActions,[]);
 const imported=await api('/api/import',{method:'POST',body:{text:'行动闭环测试原文',autoAnalyze:false}});
 const id=imported.body.record.id;assert.ok(id);
 assert.equal((await api('/api/action',{method:'POST',body:{text:'完成任务',done:true}})).status,400);
 assert.equal((await api('/api/action',{method:'POST',body:{recordId:id,done:true}})).status,400);
 assert.equal((await api('/api/action',{method:'POST',body:{recordId:id,text:'完成任务'}})).status,400);
 assert.equal((await api('/api/action',{method:'POST',body:{recordId:id,text:'完成任务',done:'yes'}})).status,400);
 const today=localDate();
 let result=await api('/api/action',{method:'POST',body:{recordId:id,text:'完成任务',done:true}});
 assert.equal(result.status,200);assert.deepEqual(result.body.doneActions,[{recordId:id,text:'完成任务',at:today}]);
 result=await api('/api/action',{method:'POST',body:{recordId:id,text:'完成任务',done:true}});
 assert.deepEqual(result.body.doneActions,[{recordId:id,text:'完成任务',at:today}]);
 result=await api('/api/action',{method:'POST',body:{recordId:'missing-record',text:'已删记录的行动',done:true}});
 assert.equal(result.status,200);assert.deepEqual(result.body.doneActions,[{recordId:id,text:'完成任务',at:today},{recordId:'missing-record',text:'已删记录的行动',at:today}]);
 result=await api('/api/action',{method:'POST',body:{recordId:id,text:'完成任务',done:false}});
 assert.deepEqual(result.body.doneActions,[{recordId:'missing-record',text:'已删记录的行动',at:today}]);
 result=await api('/api/action',{method:'POST',body:{recordId:id,text:'没有的行动',done:false}});
 assert.equal(result.status,200);assert.deepEqual(result.body.doneActions,[{recordId:'missing-record',text:'已删记录的行动',at:today}]);
 assert.deepEqual((await api('/api/state')).body.doneActions,[{recordId:'missing-record',text:'已删记录的行动',at:today}]);
});

test('PUT /api/records round-trips value tier fields and rejects invalid ones',async t=>{
 const {api}=await fixture(t);
 const imported=await api('/api/import',{method:'POST',body:{text:'价值分层往返测试原文',autoAnalyze:false}});
 const record=imported.body.record;
 const payload={...record,value:'gem',valueSource:'user',reviewCount:3,lastReviewedAt:'2026-03-05'};
 const saved=await api('/api/records',{method:'PUT',body:payload});
 assert.equal(saved.status,200);
 assert.deepEqual({value:saved.body.value,valueSource:saved.body.valueSource,reviewCount:saved.body.reviewCount,lastReviewedAt:saved.body.lastReviewedAt},{value:'gem',valueSource:'user',reviewCount:3,lastReviewedAt:'2026-03-05'});
 const stored=(await api('/api/state')).body.records[0];
 assert.deepEqual({value:stored.value,valueSource:stored.valueSource,reviewCount:stored.reviewCount,lastReviewedAt:stored.lastReviewedAt},{value:'gem',valueSource:'user',reviewCount:3,lastReviewedAt:'2026-03-05'});
 assert.equal((await api('/api/records',{method:'PUT',body:{...payload,value:'重要',revision:saved.body.revision}})).status,400);
 assert.equal((await api('/api/records',{method:'PUT',body:{...payload,reviewCount:-1,revision:saved.body.revision}})).status,400);
 assert.equal((await api('/api/records',{method:'PUT',body:{...payload,valueSource:'model',revision:saved.body.revision}})).status,400);
 assert.equal((await api('/api/records',{method:'PUT',body:{...payload,lastReviewedAt:'2026/03/05',revision:saved.body.revision}})).status,400);
 const cleared=await api('/api/records',{method:'PUT',body:{...payload,value:'',reviewCount:0,revision:saved.body.revision}});
 assert.equal(cleared.status,200);assert.equal(cleared.body.value,'');assert.equal(cleared.body.reviewCount,0);
});

test('PUT /api/records round-trips gem tags and rejects invalid ones',async t=>{
 const {api}=await fixture(t);
 const imported=await api('/api/import',{method:'POST',body:{text:'干货标签往返测试原文',autoAnalyze:false}});
 const record=imported.body.record;
 const saved=await api('/api/records',{method:'PUT',body:{...record,gemTags:['  AI 复盘  ','方法论','']}});
 assert.equal(saved.status,200);
 assert.deepEqual(saved.body.gemTags,['AI 复盘','方法论']);
 assert.deepEqual((await api('/api/state')).body.records[0].gemTags,['AI 复盘','方法论']);
 const base={...record,gemTags:['AI 复盘','方法论'],revision:saved.body.revision};
 const bad=await api('/api/records',{method:'PUT',body:{...base,gemTags:'重要'}});
 assert.equal(bad.status,400);assert.equal(bad.body.error,'标签格式无效');
 assert.equal((await api('/api/records',{method:'PUT',body:{...base,gemTags:123}})).status,400);
 assert.equal((await api('/api/records',{method:'PUT',body:{...base,gemTags:['a','b','c','d','e','f']}})).status,400);
 assert.equal((await api('/api/records',{method:'PUT',body:{...base,gemTags:['好的','a'.repeat(17)]}})).status,400);
 assert.equal((await api('/api/records',{method:'PUT',body:{...base,gemTags:['可以',42]}})).status,400);
 assert.equal((await api('/api/records',{method:'PUT',body:{...base,gemTags:''}})).status,400);
 const dropped=await api('/api/records',{method:'PUT',body:{...base,gemTags:['','   ']}});
 assert.equal(dropped.status,200);assert.deepEqual(dropped.body.gemTags,[]);
 const cleared=await api('/api/records',{method:'PUT',body:{...base,gemTags:[],revision:dropped.body.revision}});
 assert.equal(cleared.status,200);assert.deepEqual(cleared.body.gemTags,[]);
});

test('analyze value merge keeps a user-marked tier over the AI judgment',async t=>{
 t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,json:async()=>({done:true,done_reason:'stop',message:{content:JSON.stringify({title:'导师指点',category:'learn',summary:'导师分享了一套完整的复盘方法。',highlights:[],learnings:['复盘要先回到事实'],actions:[],reason:'含方法论干货',confidence:0.9,value:'gem'})}})}));
 const ai=await analyzeTranscript('导师指点内容');
 assert.equal(ai.value,'gem');
 assert.deepEqual(applyAiValue({value:'daily',valueSource:'user',reviewCount:2},'gem'),{value:'daily',valueSource:'user',reviewCount:2});
 const merged=applyAiValue({value:'daily',valueSource:'ai'},'gem');
 assert.deepEqual({value:merged.value,valueSource:merged.valueSource},{value:'gem',valueSource:'ai'});
 assert.deepEqual(applyAiValue({summary:'没有任何标记'},undefined),{summary:'没有任何标记'});
 assert.deepEqual(applyAiValue({valueSource:'ai'},'不重要'),{valueSource:'ai'});
});
