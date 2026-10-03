import http from 'node:http';
import zlib from 'node:zlib';
import {promisify} from 'node:util';
import {once} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {categories,parseTranscript,localDate,validateRecord,validateBackup,backupHistory,validateBackupHistory,validateCategories,validateAudio} from './shared.mjs';
import {analyzeTranscript,applyAiValue,summarizeDay,summarizeWeek,summarizeMonth,summarizeYear} from './ai.mjs';
import {transcribeAudio,getTranscriptionStatus} from './transcribe.mjs';
import {openStore} from './store.mjs';
import {cleanTranscript} from './cleanup.mjs';
import {answerFromRecords,findRelevantRecords} from './record-qa.mjs';
import {handleConnectorApi} from './connector-routes.mjs';
import {createConnectorService} from './connectors/index.mjs';
const base=path.dirname(fileURLToPath(import.meta.url));
const gzipAsync=promisify(zlib.gzip);
/* /api/health 版本号单一事实源：模块加载时读 package.json，读失败回退内置值 */
let appVersion='0.4.0';try{appVersion=JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8')).version||appVersion}catch(e){console.error('读取 package.json 版本失败，回退内置版本 0.4.0：',e?.message||e)}
const port=Number(process.env.SHENGJI_PORT||5189);
const token=process.env.SHENGJI_TOKEN||crypto.randomUUID();
const dataDir=process.env.SHENGJI_DATA_DIR||path.join(os.homedir(),'Library','Application Support','Shengji');
const defaultInbox=process.env.SHENGJI_INBOX||path.join(os.homedir(),'Documents','声迹收件箱');
const dbPath=path.join(dataDir,'library.json'), originalsDir=path.join(dataDir,'originals');
fs.mkdirSync(originalsDir,{recursive:true,mode:0o700});fs.mkdirSync(defaultInbox,{recursive:true});
const defaults={watchFolder:defaultInbox,watchEnabled:true,autoAnalyze:true,model:'qwen2.5:7b'};
const initialState={version:2,categories:structuredClone(categories),categoryRevision:0,records:[],settings:defaults,seenHashes:[],digests:{},weeklies:{},monthlies:{},yearlies:{},doneActions:[],revision:0};
const store=openStore({dataDir,initialState,validate:validateBackup});
let db=store.load();db.settings={...defaults,...db.settings};db.seenHashes=Array.isArray(db.seenHashes)?db.seenHashes:[];db.revision||=0;
let libraryGeneration=0;
db.digests=db.digests&&typeof db.digests==='object'&&!Array.isArray(db.digests)?db.digests:{};
db.weeklies=db.weeklies&&typeof db.weeklies==='object'&&!Array.isArray(db.weeklies)?db.weeklies:{};db.monthlies=db.monthlies&&typeof db.monthlies==='object'&&!Array.isArray(db.monthlies)?db.monthlies:{};db.yearlies=db.yearlies&&typeof db.yearlies==='object'&&!Array.isArray(db.yearlies)?db.yearlies:{};db.doneActions=Array.isArray(db.doneActions)?db.doneActions:[];
db.categories=validateCategories(db.categories?.length?db.categories:structuredClone(categories));db.categoryRevision||=0;validateBackup(db);
const audioDir=path.join(dataDir,'audio');fs.mkdirSync(audioDir,{recursive:true,mode:0o700});
/* 目录已存在时 mkdirSync 的 mode 不生效：启动时统一补一次 chmod，失败仅记录、不阻断启动 */
for(const dir of [originalsDir,audioDir]){try{fs.chmodSync(dir,0o700)}catch(e){console.error(`目录权限收紧失败（${dir}）：`,e?.message||e)}}
function persist(next){next.revision=(db.revision||0)+1;store.save(next);db=next;}
function mutate(fn){const next=structuredClone(db);fn(next);persist(next)}
for(const r of db.records){if(r.ai?.status==='running')r.ai.status='queued';if(r.transcription?.status==='running')r.transcription.status='queued';}
persist(db);
const cleanHash=s=>crypto.createHash('sha256').update(s).digest('hex');
function preserveOriginal(raw,hash){if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('原文校验值无效');const f=path.join(originalsDir,`${hash}.txt`);if(!fs.existsSync(f))fs.writeFileSync(f,raw,{mode:0o600,flag:'wx'})}
function validateValueFields(r){
 if(r.value!==undefined&&r.value!==''&&!['daily','gem'].includes(r.value))throw new Error('记录价值分层无效');
 if(r.valueSource!==undefined&&!['ai','user'].includes(r.valueSource))throw new Error('价值标记来源无效');
 if(r.reviewCount!==undefined&&(!Number.isInteger(r.reviewCount)||r.reviewCount<0||r.reviewCount>100000))throw new Error('复习次数无效');
 if(r.lastReviewedAt!==undefined&&r.lastReviewedAt!==''&&(!/^\d{4}-\d{2}-\d{2}$/.test(r.lastReviewedAt)||localDate(new Date(`${r.lastReviewedAt}T12:00:00`))!==r.lastReviewedAt))throw new Error('最近回看日期无效');
 if(r.gemTags!==undefined){if(!Array.isArray(r.gemTags)||r.gemTags.length>5||r.gemTags.some(t=>typeof t!=='string'||t.trim().length>16))throw new Error('标签格式无效');r.gemTags=r.gemTags.map(t=>t.trim()).filter(Boolean);}
 return r;
}
/* PUT /api/records 编辑白名单：只接受 validateRecord/validateValueFields 覆盖的业务字段，
   其余自造键一律丢弃，防止垃圾数据入库并被 /api/state 每次回显。
   其中 transcript/source/ai/categoryManual/revision 组装时仍以服务端 current/重算值为准
   （与旧行为一致，客户端不可借 PUT 改写），audio/transcription 不在白名单、强制取自 current。 */
const recordFieldKeys=new Set(['id','title','category','date','time','duration','transcript','summary','highlights','learnings','actions','reviewed','favorite','demo','cleanedTranscript','cleanup','value','valueSource','gemTags','reviewCount','lastReviewedAt','categoryManual','revision','source','ai']);
function newRecord({text,filename='',date,time,duration=0,title='',category,autoAnalyze=db.settings.autoAnalyze,sourcePath='',sourceKind='',dateBasis='导入时间'}){
 if(typeof text!=='string'||!text.trim())throw new Error('没有可导入的转写文字');
 if(text.length>500000)throw new Error('转写文字过长，请分段导入');
 const transcript=parseTranscript(text,filename);if(!transcript.trim())throw new Error('文件中没有可整理的正文');
 const hash=cleanHash(transcript);const existing=db.records.find(r=>r.source?.hash===hash);
 if(existing)return {record:existing,duplicate:true};
 preserveOriginal(text,hash);const now=new Date();
 const record={id:crypto.randomUUID(),title:(title.trim()||filename.replace(/\.[^.]+$/,'')||'新导入的录音').slice(0,120),category:category||'inbox',date:date||localDate(now),time:time||now.toTimeString().slice(0,5),duration:Number(duration)||0,transcript,summary:'',highlights:[],learnings:[],actions:[],reviewed:false,favorite:false,demo:false,revision:1,categoryManual:!!category&&category!=='inbox',source:{name:filename||'粘贴转写',path:sourcePath,hash,kind:sourceKind||(sourcePath?'watch':'manual'),importedAt:now.toISOString(),dateBasis},ai:{status:autoAnalyze?'queued':'none',error:'',model:db.settings.model}};
 validateRecord(record,db.categories);mutate(next=>{next.records.unshift(record);if(!next.seenHashes.includes(hash))next.seenHashes.push(hash)});queueMicrotask(runQueue);return {record,duplicate:false};
}
function audioMime(bytes,name){
 const ext=path.extname(name).toLowerCase();
 if(ext==='.mp3'&&(bytes.subarray(0,3).toString()==='ID3'||(bytes[0]===255&&(bytes[1]&224)===224)))return 'audio/mpeg';
 if(ext==='.wav'&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE')return 'audio/wav';
 if(ext==='.m4a'&&bytes.subarray(4,8).toString()==='ftyp')return 'audio/mp4';
 throw new Error('请选择有效的 MP3、M4A 或 WAV 音频文件');
}
function decodeAudio(data,name){
 if(typeof name!=='string'||!name||name.length>255||typeof data!=='string'||data.length>140*1024*1024||!data.length||data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw new Error('音频数据无效或超过 100 MB');
 const bytes=Buffer.from(data,'base64');/* 长度/4KB 对齐/字符集已在入口校验，省去与原图等大的回环 base64 比较 */if(bytes.length<12||bytes.length>100*1024*1024)throw new Error('音频数据无效或超过 100 MB');audioMime(bytes,name);return bytes;
}
function preserveAudio(bytes,hash){const file=path.join(audioDir,hash);if(!fs.existsSync(file))fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'})}
function newAudioRecord(input){
 const {audio,text='',filename='',title='',category='inbox',date,time,duration=0,autoAnalyze=db.settings.autoAnalyze,autoTranscribe=true,sourcePath='',sourceKind='',dateBasis='导入时间'}=input;
 const bytes=decodeAudio(audio?.data,audio?.name),hash=cleanHash(bytes),existing=db.records.find(r=>r.audio?.hash===hash);
 if(existing)return {record:existing,duplicate:true};
 if(typeof text!=='string'||text.length>500000)throw new Error('文字稿过长或格式无效');
 const transcript=parseTranscript(text,filename),now=new Date();
 const record={id:crypto.randomUUID(),title:(title.trim()||audio.name.replace(/\.[^.]+$/,'')).slice(0,120),category,categoryManual:category!=='inbox',date:date||localDate(now),time:time||now.toTimeString().slice(0,5),duration:Number(duration)||0,transcript,summary:'',highlights:[],learnings:[],actions:[],reviewed:false,favorite:false,demo:false,revision:1,audio:{hash,name:audio.name,mime:audioMime(bytes,audio.name),size:bytes.length},transcription:{status:transcript?'done':autoTranscribe?'queued':'none',error:'',engine:transcript?'manual':'',autoAnalyze:!!autoAnalyze},source:{hash:transcript?cleanHash(transcript):hash,name:filename||audio.name,path:sourcePath,kind:sourceKind||(sourcePath?'watch':'manual'),importedAt:now.toISOString(),dateBasis},ai:{status:transcript&&autoAnalyze?'queued':'none',error:'',model:db.settings.model}};
 validateRecord(record,db.categories);preserveAudio(bytes,hash);if(transcript)preserveOriginal(text,cleanHash(transcript));
 mutate(n=>{n.records.unshift(record);n.seenHashes.push(hash)});queueMicrotask(runQueue);return {record,duplicate:false};
}
const connectorService=createConnectorService({dataDir,importFile:async({name,bytes,mtime,source})=>{
 const parsed=mtime?new Date(mtime):new Date(),when=Number.isNaN(parsed.getTime())?new Date():parsed,date=localDate(when),time=when.toTimeString().slice(0,5),dateBasis='文件修改时间（可手动更正）';
 let text='';
 if(!/\.(mp3|m4a|wav)$/i.test(name)){
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}
  catch{throw new Error('不是有效的 UTF-8 文字文件，请重新导出')}
  if(text.includes('\u0000'))throw new Error('不是纯文字文件，请重新导出');
 }
 const result=/\.(mp3|m4a|wav)$/i.test(name)
  ?newAudioRecord({audio:{name,data:bytes.toString('base64')},sourcePath:`connector:${source?.connectorId||''}`,sourceKind:'connector',date,time,dateBasis})
  :newRecord({text,filename:name,sourcePath:`connector:${source?.connectorId||''}`,sourceKind:'connector',date,time,dateBasis});
 return {duplicate:!!result.duplicate,recordId:result.record?.id};
}});
let busy=false,activeId=null,activeAbort=null;
async function runQueue(){
 if(busy||db.settings.processingPaused)return;
 const record=db.records.find(r=>r.transcription?.status==='queued'||(r.ai?.status==='queued'&&r.transcript));
 if(!record)return;
 busy=true;activeId=record.id;activeAbort=new AbortController();
 const isTranscribing=record.transcription?.status==='queued';const runId=crypto.randomUUID();
 const startingRevision=record.revision||0;
 try{
  if(isTranscribing){
   mutate(n=>{const r=n.records.find(r=>r.id===record.id);r.transcription={...r.transcription,status:'running',runId,error:''}});
   const result=await transcribeAudio(path.join(audioDir,record.audio.hash),{signal:activeAbort.signal});
   const current=db.records.find(r=>r.id===record.id);
   if(current?.transcription?.runId===runId&&current.transcription.status==='running'&&!current.transcript){
    const transcript=result.text.trim();if(!transcript)throw new Error('没有识别到清晰语音，可补贴文字稿后继续整理');
    if(transcript.length>500000)throw new Error('转写结果超过保存上限，请拆分音频');
    const hash=cleanHash(transcript);preserveOriginal(transcript,hash);
    mutate(n=>{const r=n.records.find(r=>r.id===record.id);r.transcript=transcript;r.source.hash=hash;r.source.transcriptName='本地语音转写';r.duration=r.duration||Math.round(result.duration/60*10)/10;r.transcription={...r.transcription,status:'done',error:'',engine:result.engine,duration:result.duration,completedAt:new Date().toISOString()};r.ai={status:r.transcription.autoAnalyze?'queued':'none',error:'',model:n.settings.model};r.revision=(r.revision||0)+1;if(!n.seenHashes.includes(hash))n.seenHashes.push(hash)});
   }
  }else{
   mutate(n=>{n.records.find(r=>r.id===record.id).ai={...record.ai,status:'running',error:'',runId}});
   mutate(n=>{n.records.find(r=>r.id===record.id).ai.phase='cleanup'});
   const cleaned=await cleanTranscript(record.transcript,{model:db.settings.model,signal:activeAbort.signal,onProgress:(done,total)=>mutate(n=>{const r=n.records.find(r=>r.id===record.id);if(r?.ai.runId===runId)r.ai.cleanupProgress={done,total}})});
   mutate(n=>{const r=n.records.find(r=>r.id===record.id);if(r?.ai.runId===runId)r.ai.phase='summary'});
   const result=await analyzeTranscript(record.transcript,{model:db.settings.model,signal:activeAbort.signal,categories:db.categories});
   const current=db.records.find(r=>r.id===record.id);
   if(current?.ai?.status==='running'&&current.ai.runId===runId){
    if((current.revision||0)!==startingRevision)mutate(n=>{n.records.find(r=>r.id===record.id).ai={...current.ai,status:'failed',error:'整理期间记录已被修改，未覆盖你的内容。请重新整理。'}});
     else mutate(n=>{const r=n.records.find(r=>r.id===record.id);const cleanupFailed=cleaned.chunksFailed||0;Object.assign(r,{title:result.title.replace(/[。．.]+$/u,'')||result.title,cleanedTranscript:cleaned.text,cleanup:{model:cleaned.model,cleanedAt:cleaned.cleanedAt,coverage:cleaned.coverage,method:cleaned.method,chunksFailed:cleanupFailed},category:r.categoryManual?r.category:(n.categories.some(c=>c.id===result.category)?result.category:'inbox'),summary:result.summary,highlights:result.highlights,learnings:result.learnings,actions:result.actions,revision:startingRevision+1,ai:{status:'done',reason:cleanupFailed>0?`${result.reason}有 ${cleanupFailed} 块未能清理，已保留原文。`:result.reason,confidence:result.confidence,model:result.model,analyzedAt:result.analyzedAt,coverage:result.coverage,error:''}});applyAiValue(r,result.value)});
   }
  }
 }catch(e){
  try{
   const current=db.records.find(r=>r.id===record.id),field=isTranscribing?'transcription':'ai';
   if(current?.[field]?.status==='running'&&current[field].runId===runId)mutate(n=>{n.records.find(r=>r.id===record.id)[field]={...current[field],status:'failed',error:String(e.message||'处理失败').slice(0,600)}});
  }catch(persistError){
   console.error('队列失败状态持久化失败：',persistError?.message||persistError);
   /* 落盘失败会让记录停在 running 且无重试入口：延迟后在内存里翻回 queued，交给 runQueue 再走一轮 */
   setTimeout(()=>{try{mutate(n=>{const rr=n.records.find(x=>x.id===record.id),f=isTranscribing?'transcription':'ai';if(rr?.[f]?.status==='running'&&rr[f].runId===runId)rr[f]={...rr[f],status:'queued',error:''}})}catch(e2){console.error('队列状态恢复仍失败：',e2?.message||e2)}},5000);
  }
 }finally{busy=false;activeId=null;activeAbort=null;setTimeout(runQueue,200)}
}
/* 兜底：磁盘写满等持久化异常不允许拖垮整个本地服务 */
process.on('unhandledRejection',e=>console.error('未处理的异步错误：',e?.stack||e));
process.on('uncaughtException',e=>console.error('未捕获异常：',e?.stack||e));

/* 孤儿附件回收：originals/ 与 audio/ 只写不删，按引用计数清理不再被任何记录引用的文件 */
function referencedHashes(){const refs=new Set();for(const r of db.records){if(r.audio?.hash)refs.add(r.audio.hash);if(r.source?.hash)refs.add(r.source.hash);if(r.transcript)refs.add(cleanHash(r.transcript))}return refs}
const cleanupCandidates=new Set();let gcTimer=null;
function cleanupOrphans(){
 const refs=referencedHashes(),now=Date.now();let removed=0,nextDelay=60000;
 for(const hash of cleanupCandidates){
  if(refs.has(hash)){cleanupCandidates.delete(hash);continue}
  let pending=false;
  for(const [dir,suffix] of [[originalsDir,'.txt'],[audioDir,'']]){
   try{
    const file=path.join(dir,hash+suffix),stat=fs.lstatSync(file);
    if(!stat.isFile())continue;
    const remaining=60000-(now-stat.mtimeMs);
    if(remaining<=0){fs.unlinkSync(file);removed++}
    else{pending=true;nextDelay=Math.min(nextDelay,remaining+100)}
   }catch(error){if(error.code!=='ENOENT'){pending=true;console.error('附件回收失败：',error.message)}}
  }
  if(!pending)cleanupCandidates.delete(hash);
 }
 if(removed)console.error(`孤儿文件回收：已删除 ${removed} 个不再被任何记录引用的文件（超过 60 秒宽限期）`);
 if(cleanupCandidates.size)scheduleCleanup([],Math.max(1000,nextDelay));
}
function runCleanupSafely(){try{cleanupOrphans()}catch(e){console.error('孤儿文件回收失败：',e?.stack||e)}}
function scheduleCleanup(hashes=[],delay=1000){
 for(const hash of hashes)if(/^[a-f0-9]{64}$/.test(hash))cleanupCandidates.add(hash);
 if(!cleanupCandidates.size)return;
 clearTimeout(gcTimer);gcTimer=setTimeout(()=>{gcTimer=null;runCleanupSafely()},delay);gcTimer.unref();
}

let stability=new Map(),watchError='',lastScan='',scanBusy=false;
async function scan(){if(scanBusy||!db.settings.watchEnabled)return;scanBusy=true;const errors=[];try{const folder=fs.realpathSync(db.settings.watchFolder);const names=fs.readdirSync(folder);const present=new Set();for(const name of names){if(name.startsWith('.')||! /\.(txt|md|srt|vtt|mp3|m4a|wav)$/i.test(name))continue;const f=path.join(folder,name);try{const stat=fs.lstatSync(f);if(!stat.isFile()||stat.isSymbolicLink())continue;present.add(f);const isAudio=/\.(mp3|m4a|wav)$/i.test(name);if(stat.size>(isAudio?100:5)*1024*1024)throw new Error('文件过大，未自动导入');const mark=`${stat.size}:${stat.mtimeMs}`;if(stability.get(f)!==mark){stability.set(f,mark)}else if(isAudio){const bytes=await fs.promises.readFile(f);if(bytes.length>100*1024*1024)throw new Error('文件过大，未自动导入');if(!db.seenHashes.includes(cleanHash(bytes)))newAudioRecord({audio:{name,data:bytes.toString('base64')},sourcePath:f,date:localDate(stat.mtime),time:stat.mtime.toTimeString().slice(0,5),dateBasis:'文件修改时间（可手动更正）'})}else{let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await fs.promises.readFile(f))}catch{throw new Error('不是有效的 UTF-8 文字，请重新导出')}if(raw.trim()){if(raw.includes('\u0000'))throw new Error('不是纯文字文件，请重新导出');const hash=cleanHash(parseTranscript(raw,name));if(!db.seenHashes.includes(hash)){const modified=stat.mtime;newRecord({text:raw,filename:name,sourcePath:f,date:localDate(modified),time:modified.toTimeString().slice(0,5),dateBasis:'文件修改时间（可手动更正）'})}}}}catch(e){errors.push(`${name}：${e.message}`)}await new Promise(r=>setImmediate(r))}for(const key of stability.keys())if(!present.has(key))stability.delete(key);lastScan=new Date().toISOString();watchError=errors.slice(0,3).join('；');}catch(e){watchError=`无法读取监测文件夹：${e.code==='ENOENT'?'文件夹不存在':e.code==='EACCES'?'没有访问权限':e.message}`}finally{scanBusy=false}}

const timer=setInterval(scan,5000);timer.unref();setTimeout(()=>{scan();runQueue()},500);
async function readBody(req,sizeLimit=2*1024*1024){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>sizeLimit)throw new Error(`请求体过大（超过 ${Math.round(sizeLimit/1024/1024)} MB），请分批导入`);chunks.push(chunk)}return JSON.parse(Buffer.concat(chunks).toString()||'{}')}
function digestFallback(day,records){
 const [,month,dayOfMonth]=day.split('-').map(Number);
 const head=(text,len=40)=>{const s=String(text||'').trim();if(!s)return '';return ((s.split(/(?<=[。！？!?…；;\n])/)[0]||s).trim()).slice(0,len)};
 const lines=[`${month}月${dayOfMonth}日 · 共 ${records.length} 段记录`];
 for(const r of records)lines.push(`- ${r.title} — ${head(r.summary)||head(r.cleanedTranscript)||'无摘要'}`);
 const actions=[...new Set(records.flatMap(r=>Array.isArray(r.actions)?r.actions.map(a=>String(a).trim()):[]).filter(Boolean))];
 if(actions.length)lines.push(`接下来：${actions.slice(0,5).join('、')}`);
 return lines.join('\n');
}
async function buildDigest(day,records){
 const stamp={date:day,generatedAt:new Date().toISOString(),recordCount:records.length};
 try{const result=await summarizeDay(records.map(r=>({title:r.title,summary:r.summary,text:r.cleanedTranscript||r.transcript})),{model:db.settings.model});return {...stamp,text:result.text,model:'qwen'}}
 catch{return {...stamp,text:digestFallback(day,records),model:'fallback'}}
}
function weeklyFallback(start,end,records){
 const format=day=>{const [,month,dayOfMonth]=day.split('-').map(Number);return `${month}月${dayOfMonth}日`};
 const sorted=[...records].sort((a,b)=>a.date===b.date?a.time.localeCompare(b.time):a.date.localeCompare(b.date));
 const lines=[`${format(start)}至${format(end)} · 共 ${records.length} 段记录`];
 for(const day of [...new Set(sorted.map(r=>r.date))]){
  const items=sorted.filter(r=>r.date===day),titles=items.map(r=>r.title.trim()).filter(Boolean);
  lines.push(`- ${format(day)} · ${items.length} 条：${titles.slice(0,3).join('、')}${titles.length>3?`等 ${items.length} 条`:''}`);
 }
 const actions=sorted.flatMap(r=>Array.isArray(r.actions)?r.actions.map(a=>String(a).trim()):[]).filter(Boolean);
 if(actions.length)lines.push(`本周共留下 ${actions.length} 条待落地行动。`);
 return lines.join('\n');
}
async function buildWeekly(start,end,records){
 const days=[...new Set(records.map(r=>r.date))].sort();
 const stamp={start,end,generatedAt:new Date().toISOString(),recordCount:records.length,dayCount:days.length};
 const entries=days.filter(d=>typeof db.digests?.[d]?.text==='string'&&db.digests[d].text.trim()).map(d=>({kind:'day',date:d,text:db.digests[d].text}));
 entries.push(...records.map(r=>({kind:'record',title:r.title,summary:r.summary,text:r.cleanedTranscript||r.transcript})));
 try{const result=await summarizeWeek(entries,{model:db.settings.model});return {...stamp,text:result.text,model:'qwen'}}
 catch{return {...stamp,text:weeklyFallback(start,end,records),model:'fallback'}}
}
function monthlyFallback(month,records){
 const [year,m]=month.split('-').map(Number),last=new Date(year,m,0).getDate();
 const sorted=[...records].sort((a,b)=>a.date===b.date?a.time.localeCompare(b.time):a.date.localeCompare(b.date));
 const lines=[`${m}月 · 共 ${records.length} 段记录`];
 for(let s=1;s<=last;){
  const w=(new Date(year,m-1,s).getDay()+6)%7,e=Math.min(last,s+6-w);
  const items=sorted.filter(r=>{const d=Number(r.date.slice(8));return d>=s&&d<=e});
  if(items.length){const titles=items.map(r=>r.title.trim()).filter(Boolean);lines.push(`- ${m}月${s}日至${m}月${e}日 · ${items.length} 条：${titles.slice(0,3).join('、')}${titles.length>3?`等 ${items.length} 条`:''}`)}
  s=e+1;
 }
 const gems=sorted.filter(r=>r.value==='gem');
 if(gems.length)lines.push(`其中干货 ${gems.length} 条，复看合计 ${gems.reduce((n,r)=>n+(r.reviewCount||0),0)} 次。`);
 const actions=sorted.flatMap(r=>Array.isArray(r.actions)?r.actions.map(a=>String(a).trim()):[]).filter(Boolean);
 if(actions.length)lines.push(`本月共留下 ${actions.length} 条待落地行动。`);
 return lines.join('\n');
}
async function buildMonthly(month,start,end,records){
 const days=[...new Set(records.map(r=>r.date))].sort();
 const stamp={month,start,end,generatedAt:new Date().toISOString(),recordCount:records.length,dayCount:days.length};
 const entries=days.filter(d=>typeof db.digests?.[d]?.text==='string'&&db.digests[d].text.trim()).map(d=>({kind:'day',date:d,text:db.digests[d].text}));
 for(const w of Object.values(db.weeklies||{}))if(typeof w?.text==='string'&&(w.start?.slice(0,7)===month||w.end?.slice(0,7)===month))entries.push({kind:'week',date:w.start,text:w.text});
 entries.push(...records.map(r=>({kind:'record',date:r.date,title:r.title,summary:r.summary,text:r.cleanedTranscript||r.transcript})));
 try{const result=await summarizeMonth(entries,{model:db.settings.model});return {...stamp,text:result.text,model:'qwen'}}
 catch{return {...stamp,text:monthlyFallback(month,records),model:'fallback'}}
}
function yearlyFallback(year,records){
 const sorted=[...records].sort((a,b)=>a.date===b.date?a.time.localeCompare(b.time):a.date.localeCompare(b.date));
 const lines=[`${year}年 · 共 ${records.length} 段记录`];
 for(let m=1;m<=12;m++){
  const items=sorted.filter(r=>Number(r.date.slice(5,7))===m);
  if(!items.length)continue;
  const titles=items.map(r=>r.title.trim()).filter(Boolean);
  lines.push(`- ${m}月 · ${items.length} 条：${titles.slice(0,3).join('、')}${titles.length>3?`等 ${items.length} 条`:''}`);
 }
 const gems=sorted.filter(r=>r.value==='gem');
 if(gems.length)lines.push(`其中干货 ${gems.length} 条，复看合计 ${gems.reduce((n,r)=>n+(r.reviewCount||0),0)} 次。`);
 const actions=sorted.flatMap(r=>Array.isArray(r.actions)?r.actions.map(a=>String(a).trim()):[]).filter(Boolean);
 if(actions.length)lines.push(`全年共留下 ${actions.length} 条待落地行动。`);
 return lines.join('\n');
}
async function buildYearly(year,start,end,records){
 const days=[...new Set(records.map(r=>r.date))].sort();
 const stamp={year,start,end,generatedAt:new Date().toISOString(),recordCount:records.length,dayCount:days.length};
 const entries=[];
 for(const [month,w] of Object.entries(db.monthlies||{}))if(month.slice(0,4)===year&&typeof w?.text==='string'&&w.text.trim())entries.push({kind:'month',date:month,text:w.text});
 for(const [day,digest] of Object.entries(db.digests||{}))if(day.slice(0,4)===year&&typeof digest?.text==='string'&&digest.text.trim())entries.push({kind:'day',date:day,text:digest.text});
 entries.push(...records.map(r=>({kind:'record',date:r.date,title:r.title,summary:r.summary,text:r.cleanedTranscript||r.transcript})));
 try{const result=await summarizeYear(entries,{model:db.settings.model});return {...stamp,text:result.text,model:'qwen'}}
 catch{return {...stamp,text:yearlyFallback(year,records),model:'fallback'}}
}
const allowedOrigins=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`,'http://127.0.0.1:5178','http://localhost:5178']);
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value))}
const server=http.createServer(async(req,res)=>{try{
 const host=req.headers.host||'';if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return json(res,403,{error:'主机地址不受信任'});
 const url=new URL(req.url,`http://127.0.0.1:${port}`),p=url.pathname;
 if(req.headers.origin&&!allowedOrigins.has(req.headers.origin))return json(res,403,{error:'不允许外部网页访问本地记录'});
 if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'不允许跨站访问'});
 if(p==='/api/health')return json(res,200,{ok:true,app:'shengji',version:appVersion});
 if(p==='/api/session'&&req.method==='GET')return json(res,200,{token});
 if(p.startsWith('/api/')&&req.headers['x-shengji-token']!==token)return json(res,401,{error:'请重新打开声迹以连接本地服务'});
 if(await handleConnectorApi(req,res,{service:connectorService,readBody,json}))return;
 if(p==='/api/revision'&&req.method==='GET')return json(res,200,{revision:db.revision,categoryRevision:db.categoryRevision,lastScan,watchError});
 if(p==='/api/state'&&req.method==='GET'){
  const state={records:db.records,categories:db.categories,categoryRevision:db.categoryRevision,settings:db.settings,digests:db.digests,weeklies:db.weeklies,monthlies:db.monthlies,yearlies:db.yearlies,doneActions:db.doneActions,revision:db.revision,watch:{lastScan,error:watchError},dataDir,defaultInbox,activeId,database:store.stats()};
  const acceptsGzip=String(req.headers['accept-encoding']||'').split(',').some(entry=>{
   const [coding,...parameters]=entry.trim().split(';');
   const quality=parameters.find(value=>/^\s*q\s*=/i.test(value));
   return coding.toLowerCase()==='gzip'&&(!quality||Number(quality.split('=')[1])>0);
  });
  res.setHeader('Vary','Accept-Encoding');
  if(!acceptsGzip)return json(res,200,state);
  const body=await gzipAsync(Buffer.from(JSON.stringify(state)));
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Encoding':'gzip','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  return res.end(body);
 }
 if(p==='/api/search'&&req.method==='GET'){const q=(url.searchParams.get('q')||'').trim();if(q.length>500)throw new Error('搜索内容最多 500 字');return json(res,200,{records:store.search(q,50)});}
 if(p==='/api/ask'&&req.method==='POST'){
  const {question}=await readBody(req);if(typeof question!=='string'||!question.trim()||question.length>500)throw new Error('请填写 1–500 字的问题');
  const candidates=findRelevantRecords(question,(term,limit)=>store.search(term,limit));
  const controller=new AbortController();res.on('close',()=>controller.abort());
  return json(res,200,await answerFromRecords(question,candidates,{model:db.settings.model,signal:controller.signal}));
 }
 if(p==='/api/queue'&&req.method==='POST'){const input=await readBody(req);if(typeof input.paused!=='boolean')throw new Error('队列状态无效');mutate(n=>{n.settings.processingPaused=input.paused});queueMicrotask(runQueue);return json(res,200,{paused:db.settings.processingPaused,activeId});}
 if(p==='/api/models'&&req.method==='GET'){try{let result=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(4000)});if(!result.ok)throw new Error('模型服务未响应');const data=await result.json();return json(res,200,{available:true,memoryGB:Math.round(os.totalmem()/2**30),models:(data.models||[]).filter(m=>['qwen2.5:7b','qwen3:14b'].includes(m.name)&&!m.remote_host).map(m=>({id:m.name,size:m.size})),error:''})}catch{return json(res,200,{available:false,models:[],error:'本地 Ollama 未运行，请打开 Ollama 后重试。原文仍会正常保存。'})}}
 if(p==='/api/transcription-status'&&req.method==='GET')return json(res,200,await getTranscriptionStatus());
 if(p==='/api/transcribe'&&req.method==='POST'){const {id}=await readBody(req);const r=db.records.find(r=>r.id===id);if(!r?.audio)throw new Error('音频不存在');if(r.transcript)throw new Error('已有文字稿，不会覆盖；可直接进行 AI 整理');if(!['queued','running'].includes(r.transcription?.status))mutate(n=>{const current=n.records.find(r=>r.id===id);current.transcription={...current.transcription,status:'queued',error:'',autoAnalyze:n.settings.autoAnalyze}});queueMicrotask(runQueue);return json(res,200,{ok:true})}
 if(p==='/api/categories'&&req.method==='PUT'){
 const input=await readBody(req),list=validateCategories(input.categories);
 if(input.revision!==db.categoryRevision)return json(res,409,{error:'分类已更新，请重新打开管理分类'});
 mutate(n=>{n.categories=list;n.categoryRevision++;for(const r of n.records)if(!list.some(c=>c.id===r.category)){r.category='inbox';r.categoryManual=false;r.revision=(r.revision||0)+1}});return json(res,200,{ok:true});
 }
 if(p==='/api/import-audio'&&req.method==='POST')return json(res,200,newAudioRecord(await readBody(req,200*1024*1024)));
 if(p.startsWith('/api/audio/')&&req.method==='GET'){
 const r=db.records.find(r=>r.id===decodeURIComponent(p.slice(11)));if(!r?.audio)return json(res,404,{error:'音频不存在'});
 validateAudio(r.audio);const file=path.join(audioDir,r.audio.hash);if(!fs.existsSync(file))throw new Error('音频附件缺失，请恢复完整备份');
 res.writeHead(200,{'Content-Type':r.audio.mime,'Content-Length':r.audio.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});fs.createReadStream(file).pipe(res);return;
 }
 if(p==='/api/transcript'&&req.method==='POST'){
 const input=await readBody(req),r=db.records.find(r=>r.id===input.id);if(!r?.audio)throw new Error('音频记录不存在');
 if(input.revision!==r.revision)return json(res,409,{error:'记录已更新，请重新打开'});
 if(r.transcript)throw new Error('此记录已有原文，未覆盖');
 if(typeof input.text!=='string'||input.text.length>500000||!input.text.trim())throw new Error('请提供不超过 500000 字符的文字稿');
 const text=parseTranscript(input.text,input.filename||'');if(!text)throw new Error('文字稿没有正文');const hash=cleanHash(text);preserveOriginal(input.text,hash);if(activeId===r.id)activeAbort?.abort();
 mutate(n=>{const r=n.records.find(r=>r.id===input.id);r.transcript=text;r.source.transcriptName=input.filename||'粘贴转写';r.source.hash=hash;r.revision++;r.transcription={status:'done',engine:'manual',error:'',autoAnalyze:!!input.autoAnalyze};r.ai={status:input.autoAnalyze?'queued':'none',error:'',model:n.settings.model}});queueMicrotask(runQueue);return json(res,200,{ok:true});
 }
 if(p==='/api/import'&&req.method==='POST')return json(res,200,newRecord(await readBody(req)));
 if(p==='/api/records'&&req.method==='PUT'){const input=await readBody(req);validateRecord(input,db.categories);validateValueFields(input);const current=db.records.find(r=>r.id===input.id);if(!current)return json(res,404,{error:'记录不存在'});if((input.revision||0)!==(current.revision||0))return json(res,409,{error:'记录已更新，请重新打开后编辑，避免覆盖新内容'});const picked={};for(const k of recordFieldKeys)if(input[k]!==undefined)picked[k]=input[k];const saved={...picked,audio:current.audio,transcription:current.transcription,categoryManual:input.category!==current.category?true:current.categoryManual,source:{...current.source,...((input.date!==current.date||input.time!==current.time)?{dateBasis:'手动设置'}:{})},ai:current.ai,transcript:current.transcript,revision:(current.revision||0)+1};mutate(n=>{n.records[n.records.findIndex(r=>r.id===input.id)]=saved});return json(res,200,saved)}
 if(p==='/api/records'&&req.method==='DELETE'){const {id}=await readBody(req),previousRefs=referencedHashes();if(activeId===id)activeAbort?.abort();mutate(n=>{n.records=n.records.filter(r=>r.id!==id)});scheduleCleanup(previousRefs);return json(res,200,{ok:true})}
 if(p==='/api/analyze'&&req.method==='POST'){const {id}=await readBody(req);const r=db.records.find(r=>r.id===id);if(!r)return json(res,404,{error:'记录不存在'});if(!r.transcript.trim())throw new Error('请先补充文字稿，再进行 AI 整理');if(!['queued','running'].includes(r.ai?.status))mutate(n=>{n.records.find(r=>r.id===id).ai={...r.ai,status:'queued',error:'',model:db.settings.model}});queueMicrotask(runQueue);return json(res,200,{ok:true})}
 if(p==='/api/digest'&&req.method==='POST'){
 const {date:day}=await readBody(req);
 if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||Number.isNaN(+new Date(`${day}T12:00:00`))||localDate(new Date(`${day}T12:00:00`))!==day)throw new Error('日期格式无效，应为 YYYY-MM-DD');
 const dayRecords=db.records.filter(r=>r.date===day);
 if(!dayRecords.length)throw new Error('这一天没有记录');
 const generation=libraryGeneration,digest=await buildDigest(day,dayRecords);
 if(generation!==libraryGeneration)return json(res,409,{error:'资料库已恢复，本次回顾未写入。请重新提炼。'});
 mutate(n=>{n.digests={...(n.digests||{}),[day]:digest}});
 return json(res,200,digest);
 }
 if(p==='/api/weekly'&&req.method==='POST'){
 const {date}=await readBody(req);
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(+new Date(`${date}T12:00:00`))||localDate(new Date(`${date}T12:00:00`))!==date)throw new Error('日期格式无效，应为 YYYY-MM-DD');
 const anchor=new Date(`${date}T12:00:00`);anchor.setDate(anchor.getDate()-((anchor.getDay()+6)%7));
 const lastDay=new Date(anchor);lastDay.setDate(lastDay.getDate()+6);
 const start=localDate(anchor),end=localDate(lastDay);
 const weekRecords=db.records.filter(r=>r.date>=start&&r.date<=end);
 if(!weekRecords.length)return json(res,400,{error:'这一周没有记录'});
 const generation=libraryGeneration,weekly=await buildWeekly(start,end,weekRecords);
 if(generation!==libraryGeneration)return json(res,409,{error:'资料库已恢复，本次回顾未写入。请重新提炼。'});
 mutate(n=>{n.weeklies={...(n.weeklies||{}),[start]:weekly}});
 return json(res,200,weekly);
 }
 if(p==='/api/monthly'&&req.method==='POST'){
 const {month}=await readBody(req);
 if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new Error('月份格式无效，应为 YYYY-MM');
 const [year,m]=month.split('-').map(Number);
 const start=localDate(new Date(year,m-1,1,12)),end=localDate(new Date(year,m,0,12));
 const monthRecords=db.records.filter(r=>r.date>=start&&r.date<=end);
 if(!monthRecords.length)return json(res,400,{error:'这个月没有记录'});
 const generation=libraryGeneration,monthly=await buildMonthly(month,start,end,monthRecords);
 if(generation!==libraryGeneration)return json(res,409,{error:'资料库已恢复，本次回顾未写入。请重新提炼。'});
 mutate(n=>{n.monthlies={...(n.monthlies||{}),[month]:monthly}});
 return json(res,200,monthly);
 }
 if(p==='/api/yearly'&&req.method==='POST'){
 const {year}=await readBody(req);
 if(typeof year!=='string'||!/^\d{4}$/.test(year))throw new Error('年份格式无效，应为 YYYY');
 const start=`${year}-01-01`,end=`${year}-12-31`;
 const yearRecords=db.records.filter(r=>r.date>=start&&r.date<=end);
 if(!yearRecords.length)return json(res,400,{error:'这一年没有记录'});
 const generation=libraryGeneration,yearly=await buildYearly(year,start,end,yearRecords);
 if(generation!==libraryGeneration)return json(res,409,{error:'资料库已恢复，本次回顾未写入。请重新提炼。'});
 mutate(n=>{n.yearlies={...(n.yearlies||{}),[year]:yearly}});
 return json(res,200,yearly);
 }
 if(p==='/api/action'&&req.method==='POST'){
 const input=await readBody(req);
 if(typeof input.recordId!=='string'||!input.recordId||typeof input.text!=='string'||!input.text||typeof input.done!=='boolean')throw new Error('参数格式无效');
 mutate(n=>{n.doneActions=Array.isArray(n.doneActions)?n.doneActions:[];if(input.done){if(!n.doneActions.some(a=>a.recordId===input.recordId&&a.text===input.text))n.doneActions.push({recordId:input.recordId,text:input.text,at:localDate()})}else n.doneActions=n.doneActions.filter(a=>a.recordId!==input.recordId||a.text!==input.text)});
 return json(res,200,{doneActions:db.doneActions});
 }
 if(p==='/api/settings'&&req.method==='PUT'){const input=await readBody(req);if(!['qwen2.5:7b','qwen3:14b'].includes(input.model)||typeof input.watchEnabled!=='boolean'||typeof input.autoAnalyze!=='boolean'||typeof input.watchFolder!=='string')throw new Error('设置格式无效');const folder=fs.realpathSync(input.watchFolder);if(!fs.statSync(folder).isDirectory())throw new Error('请选择一个文件夹');fs.accessSync(folder,fs.constants.R_OK);mutate(n=>{n.settings={...n.settings,model:input.model,watchEnabled:input.watchEnabled,autoAnalyze:input.autoAnalyze,watchFolder:folder}});stability.clear();watchError='';await scan();return json(res,200,db.settings)}
 if(p==='/api/scan'&&req.method==='POST'){await scan();return json(res,200,{ok:true,error:watchError,lastScan})}
 if(p==='/api/backup'&&req.method==='GET'){
  /* 分块写出：响应仍是一个完整 JSON（字段与旧实现完全一致），但不再把全部音频读进内存拼整包字符串 */
  const snapshot=db,history=backupHistory(snapshot),controller=new AbortController();
  const closed=()=>controller.abort();res.once('close',closed);
  const writeChunk=async chunk=>{if(res.destroyed)throw new Error('备份下载已断开');if(!res.write(chunk))await once(res,'drain',{signal:controller.signal})};
  try{
   res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   await writeChunk(JSON.stringify({version:2,exportedAt:new Date().toISOString(),records:snapshot.records,categories:snapshot.categories,...history}).slice(0,-1)+',"audioFiles":{');
   let first=true;
   for(const hash of new Set(snapshot.records.filter(r=>r.audio).map(r=>r.audio.hash))){
    const bytes=await fs.promises.readFile(path.join(audioDir,hash));
    await writeChunk(`${first?'':','}${JSON.stringify(hash)}:"${bytes.toString('base64')}"`);first=false;
    await new Promise(r=>setImmediate(r));
   }
   await writeChunk('},"originals":{');
   const fallbacks=new Map();
   for(const r of snapshot.records){const hash=cleanHash(r.transcript);if(!fallbacks.has(hash))fallbacks.set(hash,r.transcript)}
   first=true;
   for(const [hash,fallback] of fallbacks){
    const file=path.join(originalsDir,hash+'.txt');
    const raw=fs.existsSync(file)?await fs.promises.readFile(file,'utf8'):fallback;
    await writeChunk(`${first?'':','}${JSON.stringify(hash)}:${JSON.stringify(raw)}`);first=false;
    await new Promise(r=>setImmediate(r));
   }
   res.end('}}');
  }catch(e){
   /* 响应已开始就只能断开，让客户端把这次备份当作损坏重试 */
   if(res.headersSent)res.destroy();else json(res,400,{error:String(e.message||'操作失败').slice(0,700)});
   console.error('备份导出失败：',e?.stack||e);
  }finally{res.off('close',closed)}
  return;
 }
 if((p==='/api/restore'||p==='/api/migrate')&&req.method==='POST'){
  const input=await readBody(req,200*1024*1024),imported=validateBackup(input),history=validateBackupHistory(input,imported);
  if(p==='/api/migrate'&&db.records.length)return json(res,409,{error:'应用中已有记录，请使用备份恢复入口迁移'});
  const staged=[],stagedAudio=[];
  for(const r of imported){
   if(r.audio){
    const bytes=decodeAudio(input.audioFiles?.[r.audio.hash],r.audio.name);
    if(cleanHash(bytes)!==r.audio.hash||bytes.length!==r.audio.size||audioMime(bytes,r.audio.name)!==r.audio.mime)throw new Error('音频附件校验失败');
    stagedAudio.push({bytes,hash:r.audio.hash});
   }
   const hash=cleanHash(r.transcript),raw=input.originals?.[hash]??r.transcript;
   if(typeof raw!=='string'||raw.length>600000||parseTranscript(raw,r.source?.transcriptName||r.source?.name||'')!==r.transcript)throw new Error('备份中的原始文件与转写内容不一致');
   staged.push({raw,hash});
   r.source={...r.source,hash:r.transcript?hash:(r.audio?.hash||hash),name:r.source?.name||'备份恢复',kind:'restore'};
   r.revision=(r.revision||0)+1;
   if(['running','queued'].includes(r.ai?.status))r.ai={...r.ai,status:'failed',error:'恢复后的记录尚未重新整理，可手动重试'};
   if(['queued','running'].includes(r.transcription?.status))r.transcription={...r.transcription,status:'failed',error:'备份已恢复，可点击重新转写继续'};
  }
  for(const {raw,hash} of staged)preserveOriginal(raw,hash);
  for(const {bytes,hash} of stagedAudio)preserveAudio(bytes,hash);
  const previousRefs=referencedHashes();activeAbort?.abort();
  mutate(n=>{
   n.records=imported;n.categories=structuredClone(input.categories??categories);n.categoryRevision++;
   Object.assign(n,history);
   n.seenHashes=[...new Set([...n.seenHashes,...imported.flatMap(r=>[r.source.hash,...(r.audio?[r.audio.hash]:[])])])];
  });
  libraryGeneration++;
  scheduleCleanup(previousRefs);
  return json(res,200,{ok:true,count:imported.length});
 }
 if(p==='/api/clear-demo'&&req.method==='POST'){const previousRefs=referencedHashes();mutate(n=>{n.records=n.records.filter(r=>!r.demo)});scheduleCleanup(previousRefs);return json(res,200,{ok:true})}
 if(p.startsWith('/api/'))return json(res,404,{error:'接口不存在'});
 if(req.method!=='GET')return json(res,405,{error:'方法不支持'});
 const root=path.join(base,'dist'),file=path.resolve(root,'.'+decodeURIComponent(p==='/'?'/index.html':p));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,404,{error:'页面不存在，请先构建应用'});
 const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'"});fs.createReadStream(file).pipe(res);
 }catch(e){json(res,400,{error:String(e.message||'操作失败').slice(0,700)})}});
server.on('error',e=>{console.error(`声迹无法启动：${e.code==='EADDRINUSE'?'端口已被占用':e.message}`);process.exit(1)});
server.listen(port,'127.0.0.1',()=>console.log(`声迹本地服务已启动 http://127.0.0.1:${port}`));
function shutdown(){activeAbort?.abort();clearInterval(timer);server.close(()=>{store.close();process.exit(0)});setTimeout(()=>process.exit(0),1500).unref()}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
