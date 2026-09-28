import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
let serial=0;
async function fixture(t,handler=()=>{}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'shengji-asr-unit-'));const audio=path.join(directory,'no-extension');await fs.writeFile(audio,'fake bytes for mocked process');
 const calls=[];
 t.mock.method(fs,'access',async()=>{});
 t.mock.method(childProcess,'spawn',(executable,args,options)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{queueMicrotask(()=>child.emit('close',null));return true;};calls.push({executable,args,options});
  queueMicrotask(async()=>{
   try{
    if(await handler({executable,args,options,child,calls})===false)return;
    if(executable.endsWith('/ffprobe'))child.stdout.write(JSON.stringify({streams:[{codec_type:'audio'}],format:{duration:'8.25'}}));
    else if(args.includes('--check'))child.stdout.write(JSON.stringify({available:true}));
    else if(args.includes('--output'))await fs.writeFile(args[args.indexOf('--output')+1],JSON.stringify({text:'这是模拟转写，仅用于单元测试。',duration:8.25,engine:'funasr-paraformer-zh'}));
    child.emit('close',0);
   }catch(error){child.emit('error',error);}
  });return child;
 });
 syncBuiltinESMExports();
 const mod=await import(`../transcribe.mjs?test=${++serial}`);
 t.after(async()=>{t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(directory,{recursive:true,force:true});});
 return{...mod,audio,calls};
}
test('extensionless audio is decoded locally, returned duration is seconds, temp is removed',async t=>{
 const f=await fixture(t);const result=await f.transcribeAudio(f.audio);assert.equal(result.duration,8.25);assert.equal(result.language,'zh');assert.equal(result.engine,'funasr-paraformer-zh');
 const conversion=f.calls.find(call=>call.executable.endsWith('/ffmpeg'));assert(conversion.args.includes(f.audio));assert(conversion.args.includes('16000'));assert(conversion.args.includes('file,pipe'));
 assert(f.calls.every(call=>call.options.shell===false));assert(f.calls.every(call=>!Object.keys(call.options.env).some(key=>/TOKEN$|SECRET|PASSWORD/.test(key))));
 const helper=f.calls.find(call=>call.args.includes('--audio'));const temp=path.dirname(helper.args[helper.args.indexOf('--output')+1]);await assert.rejects(fs.stat(temp),error=>error.code==='ENOENT');
});
test('unavailable Python environment reports unavailable without a download fallback',async t=>{
 const f=await fixture(t,({args,child})=>{if(args.includes('--check')){child.stderr.write('SHENGJI_ASR_ERROR: 缺少本地模型文件\n');child.emit('close',1);return false;}});const result=await f.getTranscriptionStatus();assert.equal(result.available,false);assert.match(result.error,/缺少本地模型/);assert.equal(f.calls.length,1);
});
test('bad audio and greater than two hours reject before model loading',async t=>{
 const f=await fixture(t,({executable,child})=>{if(executable.endsWith('/ffprobe')){child.stdout.write(JSON.stringify({streams:[{codec_type:'audio'}],format:{duration:'7200.1'}}));child.emit('close',0);return false;}});await assert.rejects(f.transcribeAudio(f.audio),/两小时/);assert.equal(f.calls.length,1);
});
test('undecodable file has a readable error',async t=>{
 const f=await fixture(t,({executable,child})=>{if(executable.endsWith('/ffprobe')){child.emit('close',1);return false;}});await assert.rejects(f.transcribeAudio(f.audio),/损坏/);
});
test('cancelled inference terminates process and removes temporary files',async t=>{
 const controller=new AbortController();let output;
 const f=await fixture(t,({args})=>{if(args.includes('--audio')){output=args[args.indexOf('--output')+1];controller.abort();return false;}});await assert.rejects(f.transcribeAudio(f.audio,{signal:controller.signal}),/取消/);await assert.rejects(fs.stat(path.dirname(output)),error=>error.code==='ENOENT');
});
test('silence failure is explicit and cleaned up',async t=>{
 let output;const f=await fixture(t,({args,child})=>{if(args.includes('--audio')){output=args[args.indexOf('--output')+1];child.stderr.write('SHENGJI_ASR_ERROR: 未识别到可转写的语音\n');child.emit('close',1);return false;}});await assert.rejects(f.transcribeAudio(f.audio),/未识别到/);await assert.rejects(fs.stat(path.dirname(output)),error=>error.code==='ENOENT');
});
test('empty and missing files are rejected before subprocess launch',async t=>{
 const f=await fixture(t);await assert.rejects(f.transcribeAudio(f.audio+'-missing'),/不存在/);await fs.writeFile(f.audio,'');await assert.rejects(f.transcribeAudio(f.audio),/为空/);assert.equal(f.calls.length,0);
});
test('inference timeout terminates process and removes temporary files',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let output;
 const f=await fixture(t,({args})=>{if(args.includes('--audio')){output=args[args.indexOf('--output')+1];t.mock.timers.tick(180001);return false;}});
 await assert.rejects(f.transcribeAudio(f.audio),/超时/);await assert.rejects(fs.stat(path.dirname(output)),error=>error.code==='ENOENT');
});
