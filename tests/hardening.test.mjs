import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;}
async function fixture(t,{preCreateDirs=false}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shengji-hardening-test-')),data=path.join(dir,'data'),inbox=path.join(dir,'inbox');await fs.mkdir(data);await fs.mkdir(inbox);
 /* 预先以宽松权限建目录，验证启动时对已存在目录仍会补 chmod 0700 */
 if(preCreateDirs){await fs.mkdir(path.join(data,'originals'),{mode:0o755});await fs.mkdir(path.join(data,'audio'),{mode:0o755});}
 const token='hardening-test-token';const port=await freePort();
 await fs.writeFile(path.join(data,'library.json'),JSON.stringify({version:2,records:[],revision:0,seenHashes:[],settings:{watchFolder:inbox,watchEnabled:false,autoAnalyze:false,model:'qwen2.5:7b'}}));
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,SHENGJI_PORT:String(port),SHENGJI_TOKEN:token,SHENGJI_DATA_DIR:data,SHENGJI_INBOX:inbox},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 t.after(async()=>{child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(2000)]);if(child.exitCode===null)child.kill('SIGKILL');await fs.rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${port}`;
 const api=async(route,{method='GET',body,headers={}}={})=>{const raw=typeof body==='string'?body:body===undefined?undefined:JSON.stringify(body);const response=await fetch(base+route,{method,headers:{'x-shengji-token':token,'Content-Type':'application/json',...headers},body:raw});return {status:response.status,body:await response.json()};};
 for(let i=0;i<100;i++){try{if((await api('/api/health')).status===200)return{api,data,inbox,dir,logs:()=>logs};}catch{}await sleep(30);}throw new Error('Isolated server startup failed: '+logs);
}
function wav(seed){const bytes=Buffer.alloc(44);bytes.write('RIFF',0);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(seed,40);return bytes}
const marker='zz-evil-payload-zz';

test('PUT /api/records drops self-invented keys so they never reach SQLite or /api/state',async t=>{
 const {api,data}=await fixture(t);
 const imported=await api('/api/import',{method:'POST',body:{text:'白名单加固测试原文。',autoAnalyze:false}});
 assert.equal(imported.status,200);
 const record=imported.body.record;
 const database=(await api('/api/state')).body.database;
 assert.equal(database.engine,'SQLite');
 const baseline=await fs.readFile(database.path);
 /* body 里带自造键（含超大字符串）与原始 __proto__ 键（以原始 JSON 注入，绕过 JS 字面量语义） */
 const payload={...record,title:'加固后的标题',evil:{note:marker,blob:'x'.repeat(300*1024)},junk:marker,pollute:{admin:true}};
 const raw=JSON.stringify(payload).slice(0,-1)+`,"__proto__":{"admin":true,"note":"${marker}"}}`;
 const put=await api('/api/records',{method:'PUT',body:raw});
 assert.equal(put.status,200);
 assert.equal(put.body.evil,undefined);assert.equal(put.body.junk,undefined);assert.equal(put.body.pollute,undefined);
 const stored=(await api('/api/state')).body.records[0];
 assert.equal(stored.title,'加固后的标题');
 assert.equal(stored.evil,undefined,'自造键不得在 /api/state 回显');
 assert.equal(stored.junk,undefined);
 assert.equal(stored.pollute,undefined);
 assert.equal(Object.keys(stored).includes('evil'),false);
 assert.equal(Object.keys(stored).includes('__proto__'),false);
 /* 库文件里不得出现垃圾负载：当前页与历史页都不允许 */
 const after=await fs.readFile(database.path);
 assert.equal(after.includes(Buffer.from(marker)),false,'SQLite 库文件不得包含被丢弃的自造键内容');
 assert.ok(after.length<=baseline.length+8192,`库体积不得被垃圾负载撑大（baseline=${baseline.length}, after=${after.length}）`);
 /* 白名单拦截不得影响后续正常编辑 */
 const second=await api('/api/records',{method:'PUT',body:{...stored,title:'再次编辑',revision:stored.revision}});
 assert.equal(second.status,200);
 assert.equal(second.body.title,'再次编辑');
 assert.equal((await api('/api/state')).body.records[0].title,'再次编辑');
});

test('PUT /api/records keeps every whitelisted business field intact',async t=>{
 const {api}=await fixture(t);
 const imported=await api('/api/import',{method:'POST',body:{text:'完整字段往返测试原文，用于确认编辑不丢数据。',autoAnalyze:false}});
 assert.equal(imported.status,200);
 const record=imported.body.record;
 const patch={title:'完整字段往返',summary:'一句话摘要。',cleanedTranscript:'整理后的干净稿子。',value:'gem',valueSource:'user',gemTags:['方法论','  AI 复盘 ',''],reviewCount:2,lastReviewedAt:'2026-10-01',highlights:['关键原话一句'],learnings:['学到的一件事'],actions:['落地的一个行动'],reviewed:true,favorite:true,demo:false,date:'2026-09-30',time:'08:30'};
 const put=await api('/api/records',{method:'PUT',body:{...record,...patch}});
 assert.equal(put.status,200);
 const stored=(await api('/api/state')).body.records[0];
 assert.equal(stored.title,'完整字段往返');
 assert.equal(stored.summary,'一句话摘要。');
 assert.equal(stored.cleanedTranscript,'整理后的干净稿子。');
 assert.deepEqual(stored.highlights,['关键原话一句']);
 assert.deepEqual(stored.learnings,['学到的一件事']);
 assert.deepEqual(stored.actions,['落地的一个行动']);
 assert.equal(stored.reviewed,true);assert.equal(stored.favorite,true);assert.equal(stored.demo,false);
 assert.equal(stored.date,'2026-09-30');assert.equal(stored.time,'08:30');assert.equal(stored.duration,record.duration);
 assert.deepEqual({value:stored.value,valueSource:stored.valueSource,reviewCount:stored.reviewCount,lastReviewedAt:stored.lastReviewedAt},{value:'gem',valueSource:'user',reviewCount:2,lastReviewedAt:'2026-10-01'});
 assert.deepEqual(stored.gemTags,['方法论','AI 复盘'],'gemTags 应保留并完成裁剪清洗');
 assert.equal(stored.source.dateBasis,'手动设置','改日期/时间后 dateBasis 语义应保留');
 assert.equal(stored.revision,record.revision+1);
 /* 服务端强管字段：PUT 不得借道改写 transcript 与 ai */
 assert.equal(stored.transcript,record.transcript);
 assert.deepEqual(stored.ai,record.ai);
 assert.equal(stored.categoryManual,false);
});

test('import-audio still rejects truncated, undersized and non-audio payloads',async t=>{
 const {api}=await fixture(t);
 /* 正常音频仍可导入（正对照） */
 const good=await api('/api/import-audio',{method:'POST',body:{audio:{name:'正常录音.wav',data:wav(7).toString('base64')},autoAnalyze:false,autoTranscribe:false}});
 assert.equal(good.status,200);assert.equal(good.body.duplicate,false);
 /* 解码后不足 12 字节：合成短内容 */
 const tiny=await api('/api/import-audio',{method:'POST',body:{audio:{name:'太短.wav',data:Buffer.from('RIFFxxxx').toString('base64')},autoAnalyze:false,autoTranscribe:false}});
 assert.equal(tiny.status,400);assert.equal(tiny.body.error,'音频数据无效或超过 100 MB');
 /* 真实 WAV 被截断到不足 12 字节 */
 const truncated=await api('/api/import-audio',{method:'POST',body:{audio:{name:'截断.wav',data:wav(9).subarray(0,10).toString('base64')},autoAnalyze:false,autoTranscribe:false}});
 assert.equal(truncated.status,400);assert.equal(truncated.body.error,'音频数据无效或超过 100 MB');
 /* 字符集不合法的 base64（长度对齐但含非法字符） */
 const garbage=await api('/api/import-audio',{method:'POST',body:{audio:{name:'乱码.wav',data:'%%%%'},autoAnalyze:false,autoTranscribe:false}});
 assert.equal(garbage.status,400);assert.equal(garbage.body.error,'音频数据无效或超过 100 MB');
 /* 内容有效但不是 MP3/M4A/WAV 魔数 */
 const fake=await api('/api/import-audio',{method:'POST',body:{audio:{name:'假音频.wav',data:Buffer.from('this is definitely not an audio file payload').toString('base64')},autoAnalyze:false,autoTranscribe:false}});
 assert.equal(fake.status,400);assert.equal(fake.body.error,'请选择有效的 MP3、M4A 或 WAV 音频文件');
 /* 被拒的导入不得留下任何记录 */
 assert.equal((await api('/api/state')).body.records.length,1);
});

test('startup tightens permissions on pre-existing originals and audio directories',async t=>{
 const {data,logs}=await fixture(t,{preCreateDirs:true});
 for(const name of ['originals','audio']){
  const stat=await fs.stat(path.join(data,name));
  assert.equal(stat.mode&0o777,0o700,`${name}/ 已存在时启动仍应收紧为 0700`);
 }
 assert.doesNotMatch(logs(),/目录权限收紧失败/);
});
