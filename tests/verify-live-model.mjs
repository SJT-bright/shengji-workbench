// Explicit live integration check with synthetic material, never a user's library.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shengji-live-'));const inbox=path.join(dir,'inbox'),db=path.join(dir,'data');const port=5195;const token='live-integration-token';
const child=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,SHENGJI_PORT:String(port),SHENGJI_TOKEN:token,SHENGJI_DATA_DIR:db,SHENGJI_INBOX:inbox},stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const api=async(p,method='GET',body)=>{const r=await fetch(`http://127.0.0.1:${port}/api/${p}`,{method,headers:{'X-Shengji-Token':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw new Error(data.error);return data};
try{for(let i=0;i<40;i++){try{await api('health');break}catch{await pause(200)}}
 const text='这是一段合成测试转写，不是真实录音。今天我学习了间隔复习法。老师解释：刚学完以后先用自己的话复述，隔一天再回忆，隔一周再检验。如果只反复看笔记，容易把熟悉误认为理解。我准备明晚不看笔记，用三个例子讲清楚这个方法，并记录忘记了哪些部分。';
 const file=path.join(inbox,'合成测试-学习方法.txt');fs.writeFileSync(file,text);
 await api('scan','POST',{});await api('scan','POST',{});
 let state;for(let i=0;i<120;i++){state=await api('state');const r=state.records[0];if(r&&['done','failed'].includes(r.ai?.status))break;await pause(1000)}
 const record=state.records[0];assert.equal(record.ai.status,'done',record.ai.error);assert.equal(record.category,'learn');assert.equal(record.transcript,text);assert.ok(record.title!=='合成测试-学习方法');assert.ok(record.summary.length>10);assert.ok(record.highlights.every(q=>text.includes(q)));
 fs.writeFileSync(path.join(inbox,'重复同文.txt'),text);await api('scan','POST',{});await api('scan','POST',{});assert.equal((await api('state')).records.length,1);
 fs.mkdirSync('verification',{recursive:true});const report={verifiedAt:new Date().toISOString(),scope:'isolated synthetic transcript; no user recordings',flow:['watch file','automatic import','real local model','category/title/summary','original preserved','duplicate prevented'],model:record.ai.model,category:record.category,title:record.title,summary:record.summary,highlights:record.highlights,actions:record.actions,sourceHash:record.source.hash,status:'PASS'};fs.writeFileSync('verification/live-model.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
