import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createConnectorService,assertPublicHttpsUrl,isForbiddenIp,sha256Hex} from '../connectors/index.mjs';

// 测试不访问真实网络：URL 策略直接断言，网络行为通过注入的 request/lookup 模拟。
// 测试里的“令牌”是虚构占位字符串，不是任何可用凭据。
function tempDir(label){return fs.mkdtempSync(path.join(os.tmpdir(),`shengji-conn-${label}-`))}

function bodyRes(buffer,headers={}){return {status:200,headers,stream:Readable.from([buffer])}}
function jsonResponse(obj,headers={}){return bodyRes(Buffer.from(JSON.stringify(obj)),{'content-type':'application/json',...headers})}
function statusRes(status,headers={}){return {status,headers,stream:Readable.from([])}}
function redirectRes(location){return {status:302,headers:{location},stream:Readable.from([])}}

// 注入传输层：记录每次请求并按 handler 生成响应；lookup 统一解析到公网 IP，避免真实 DNS
function fakeTransport(handler,{ip='93.184.216.34'}={}){
 const requests=[];
 const request=async(urlObj,opts)=>{
  requests.push({url:urlObj.toString(),headers:{...opts.headers}});
  return handler(urlObj,opts,requests.length);
 };
 return {transport:{request,lookup:async()=>[{address:ip,family:4}]},requests};
}

function manifest({files,version=1,device}={}){
 return {version,device:device??{id:'dev-1',name:'测试设备（演示）',model:'测试型号'},files};
}
function fileEntry(over={}){
 const base={id:'f1',name:'演示录音-测试.wav',url:'https://cdn.example.com/f1.wav',size:1024};
 return {...base,...over};
}
function mockImportFile(){
 const seen=new Set(),calls=[];
 const fn=async input=>{
  calls.push(input);
  const h=sha256Hex(input.bytes);
  if(seen.has(h))return {duplicate:true,record:{id:'existing'}};
  seen.add(h);
  return {duplicate:false,record:{id:`rec-${calls.length}`}};
 };
 fn.calls=calls;
 return fn;
}
const demo=bytes=>bytes;

test('add/list/remove：默认值、模拟标记与配置持久化',async()=>{
 const dir=tempDir('lifecycle'),svc=createConnectorService({dataDir:dir,importFile:mockImportFile()});
 const sim=await svc.add({kind:'simulator'});
 assert.equal(sim.kind,'simulator');
 assert.equal(sim.simulated,true);
 assert.equal(sim.status,'configured');
 assert.ok(sim.name.includes('演示'));
 assert.ok(sim.id);
 const listed=await svc.list();
 assert.equal(listed.length,1);
 assert.deepEqual(Object.keys(listed[0]).sort(),['capabilities','createdAt','id','kind','lastError','lastSyncAt','name','simulated','status'].sort());
 assert.ok(fs.existsSync(path.join(dir,'connectors.json')));
 assert.equal((await svc.remove(sim.id)).ok,true);
 assert.deepEqual(await svc.list(),[]);
 await assert.rejects(()=>svc.remove(sim.id),/来源不存在或已移除/);
 await assert.rejects(()=>svc.add({kind:'iflytek-cloud'}),/来源类型无效/);
});

test('bearer token 只留内存：不写入 connectors.json，不出现在 list() 结果',async()=>{
 const dir=tempDir('token-persist'),svc=createConnectorService({dataDir:dir,importFile:mockImportFile()});
 const token='演示占位令牌-NOT-A-REAL-CREDENTIAL-9876543210';
 const src=await svc.add({kind:'remote-manifest',name:'我的远程来源',manifestUrl:'https://files.example.com/v1/manifest.json',bearerToken:token});
 const raw=fs.readFileSync(path.join(dir,'connectors.json'),'utf8');
 assert.ok(!raw.includes(token),'connectors.json 不得包含令牌');
 const listed=await svc.list();
 assert.ok(!JSON.stringify(listed).includes(token));
 assert.equal(listed[0].hasToken,true);
 assert.ok(!JSON.stringify(src).includes(token));
});

test('模拟来源 test：reachable + 演示标记 + 演示设备信息',async()=>{
 const dir=tempDir('sim-test'),svc=createConnectorService({dataDir:dir,importFile:mockImportFile()});
 const src=await svc.add({kind:'simulator'});
 const result=await svc.test(src.id);
 assert.equal(result.status,'reachable');
 assert.equal(result.simulated,true);
 assert.equal(result.device.name,'演示录音设备');
 assert.equal(result.device.model,'模拟器 · 非真实设备');
 assert.equal(result.fileCount,3);
 const listed=await svc.list();
 assert.equal(listed[0].status,'reachable');
 assert.equal(listed[0].lastError,'');
});

test('模拟来源 sync：导入演示文件，音频为有效 WAV，携带来源与 mtime 元数据',async()=>{
 const dir=tempDir('sim-sync'),importFile=mockImportFile(),svc=createConnectorService({dataDir:dir,importFile});
 const src=await svc.add({kind:'simulator'});
 const result=await svc.sync(src.id);
 assert.equal(result.sourceId,src.id);
 assert.equal(result.simulated,true);
 assert.equal(result.discovered,3);
 assert.equal(result.imported,3);
 assert.equal(result.duplicates,0);
 assert.equal(result.failed,0);
 assert.equal(result.files.length,3);
 assert.ok(result.files.every(f=>f.status==='imported'));
 assert.equal(importFile.calls.length,3);
 const audio=importFile.calls.filter(c=>c.name.endsWith('.wav'));
 assert.equal(audio.length,2);
 assert.ok(audio.every(c=>c.name.startsWith('演示录音')));
 for(const c of audio){
  assert.equal(c.bytes.subarray(0,4).toString(),'RIFF');
  assert.equal(c.bytes.subarray(8,12).toString(),'WAVE');
  assert.ok(c.bytes.length<100*1024*1024);
 }
 const text=importFile.calls.find(c=>c.name.endsWith('.txt'));
 assert.ok(text.name.startsWith('演示转写'));
 assert.ok(text.bytes.toString('utf8').includes('演示数据 · 非真实录音'));
 for(const c of importFile.calls){
  assert.equal(typeof c.mtime,'string');
  assert.ok(!Number.isNaN(+new Date(c.mtime)));
  assert.equal(c.source.connectorKind,'simulator');
  assert.equal(c.source.simulated,true);
  assert.equal(c.source.deviceName,'演示录音设备');
  assert.ok(c.source.fileId);
 }
});

test('模拟来源二次 sync：全部去重，不再触发 importFile；重启（新实例）后仍去重',async()=>{
 const dir=tempDir('sim-dedupe'),importFile=mockImportFile(),svc=createConnectorService({dataDir:dir,importFile});
 const src=await svc.add({kind:'simulator'});
 const first=await svc.sync(src.id);
 assert.equal(first.imported,3);
 const second=await svc.sync(src.id);
 assert.equal(second.imported,0);
 assert.equal(second.duplicates,3);
 assert.equal(second.failed,0);
 assert.equal(importFile.calls.length,3,'重复文件不应再次调用导入');
 // 模拟重启：新实例从 connectors.json 恢复已导入哈希
 const importFile2=mockImportFile();
 const svc2=createConnectorService({dataDir:dir,importFile:importFile2});
 const third=await svc2.sync(src.id);
 assert.equal(third.imported,0);
 assert.equal(third.duplicates,3);
 assert.equal(importFile2.calls.length,0);
});

test('remote-manifest 正常路径：下载导入、无清单 sha 时二次同步仍按内容去重',async()=>{
 const dir=tempDir('remote-basic'),importFile=mockImportFile();
 const wav=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVE'),Buffer.alloc(2040)]),txt=demo(Buffer.from('【演示】远程清单文字稿'));
 const urlBytes=new Map([['https://cdn.example.com/f1.wav',wav],['https://cdn.example.com/f2.txt',txt]]);
 const transport=fakeTransport((url)=>{
  const u=url.toString();
  if(u==='https://files.example.com/v1/manifest.json')return jsonResponse(manifest({files:[fileEntry({size:wav.length}),fileEntry({id:'f2',name:'演示转写-测试.txt',url:'https://cdn.example.com/f2.txt',size:txt.length})]}));
  if(urlBytes.has(u))return bodyRes(urlBytes.get(u));
  return statusRes(404);
 });
 const svc=createConnectorService({dataDir:dir,importFile,transport:transport.transport});
 const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json',bearerToken:'演示占位令牌-0'});
 const result=await svc.sync(src.id);
 assert.equal(result.simulated,false);
 assert.equal(result.imported,2);
 assert.equal(result.discovered,2);
 assert.equal(transport.requests.length,3,'清单 1 次 + 文件 2 次');
 assert.equal(transport.requests[0].headers.authorization,'Bearer 演示占位令牌-0');
 assert.equal(transport.requests[1].headers.authorization,'Bearer 演示占位令牌-0');
 assert.equal(importFile.calls[0].bytes.subarray(0,4).toString(),'RIFF');
 assert.equal(importFile.calls[1].bytes.toString('utf8').includes('演示'),true);
 const second=await svc.sync(src.id);
 assert.equal(second.imported,0);
 assert.equal(second.duplicates,2);
 assert.equal(transport.requests.length,6,'无清单 sha 时会重新下载，但不重复导入');
 assert.equal(importFile.calls.length,2,'内容相同不应再次进入导入');
 const listed=await svc.list();
 assert.equal(listed[0].status,'reachable');
 assert.ok(listed[0].lastSyncAt);
});

test('remote-manifest 清单带 sha256：重复同步完全不下载',async()=>{
 const dir=tempDir('remote-sha'),importFile=mockImportFile();
 const bytes=demo(Buffer.alloc(512,3));
 const url='https://cdn.example.com/only.wav';
 const sha=sha256Hex(bytes);
 const transport=fakeTransport(requestUrl=>{
  if(requestUrl.toString()==='https://files.example.com/v1/manifest.json')return jsonResponse(manifest({files:[fileEntry({url,sha256:sha,size:bytes.length})]}));
  return bodyRes(bytes);
 });
 const svc=createConnectorService({dataDir:dir,importFile,transport:transport.transport});
 const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json'});
 assert.equal((await svc.sync(src.id)).imported,1);
 assert.equal(transport.requests.length,2);
 const second=await svc.sync(src.id);
 assert.equal(second.duplicates,1);
 assert.equal(second.imported,0);
 assert.equal(transport.requests.filter(r=>r.url===url).length,1,'命中已记录 sha 时不应重复下载文件');
 assert.equal(importFile.calls.length,1);
});

test('远程文件大小或 sha256 与清单不一致时拒绝导入',async()=>{
 const bytes=Buffer.alloc(64,7);
 for(const [label,size,sha256] of [
  ['size',bytes.length+1,sha256Hex(bytes)],
  ['sha',bytes.length,'0'.repeat(64)],
 ]){
  const importFile=mockImportFile();
  const transport=fakeTransport(url=>url.toString().endsWith('manifest.json')
   ?jsonResponse(manifest({files:[fileEntry({size,sha256})]}))
   :bodyRes(bytes));
  const svc=createConnectorService({dataDir:tempDir(`integrity-${label}`),importFile,transport:transport.transport});
  const source=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/manifest.json'});
  const result=await svc.sync(source.id);
  assert.equal(result.imported,0);
  assert.equal(result.failed,1);
  assert.match(result.files[0].error,/不一致/);
  assert.equal(importFile.calls.length,0);
 }
});

test('清单版本或结构不符 → unsupported（不支持此来源）',async()=>{
 const dir=tempDir('remote-unsupported'),svc=createConnectorService({dataDir:dir,importFile:mockImportFile()});
 const cases=[
  [jsonResponse(manifest({version:2,files:[]})),'版本'],
  [jsonResponse({foo:'bar'}),'version'],
  [bodyRes(Buffer.from('<html><body>hello</body></html>'),{'content-type':'text/html'}),'JSON'],
  [jsonResponse(manifest({files:'nope'})),'files'],
 ];
 let caseIdx=0;
 for(const [res] of cases){
  const transport=fakeTransport(()=>res);
  const svc2=createConnectorService({dataDir:tempDir(`remote-unsupported-${caseIdx++}`),importFile:mockImportFile(),transport:transport.transport});
  const src=await svc2.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json'});
  const result=await svc2.test(src.id);
  assert.equal(result.status,'unsupported',JSON.stringify(result));
  assert.ok(result.error.includes('不支持此来源'),result.error);
  assert.equal(result.simulated,false);
  const listed=await svc2.list();
  assert.equal(listed[0].status,'unsupported');
 }
});

test('清单内单个文件 URL 违规：该文件失败，其余正常导入',async()=>{
 const dir=tempDir('remote-fileurl'),importFile=mockImportFile();
 const transport=fakeTransport(url=>{
  const u=url.toString();
  if(u==='https://files.example.com/v1/manifest.json')return jsonResponse(manifest({files:[
   fileEntry({id:'bad-http',url:'http://cdn.example.com/a.wav'}),
   fileEntry({id:'bad-lan',url:'https://10.0.0.5/a.wav'}),
   fileEntry({id:'bad-port',url:'https://cdn.example.com:8443/a.wav'}),
   fileEntry({id:'good',url:'https://cdn.example.com/ok.wav',size:128}),
  ]}));
  if(u==='https://cdn.example.com/ok.wav')return bodyRes(demo(Buffer.alloc(128,1)));
  return statusRes(404);
 });
 const svc=createConnectorService({dataDir:dir,importFile,transport:transport.transport});
 const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json'});
 const result=await svc.sync(src.id);
 assert.equal(result.discovered,4);
 assert.equal(result.imported,1);
 assert.equal(result.failed,3);
 const bad=result.files.filter(f=>f.status==='failed');
 assert.ok(bad.every(f=>/https|内网|端口/i.test(f.error)),JSON.stringify(bad));
 assert.equal(transport.requests.length,2,'违规文件不应发起下载');
});

test('重定向：跟随合法 HTTPS 跳转且不转发令牌；降级/内网/过多跳转被拒绝',async()=>{
 const dir=tempDir('redirect');
 const manifestBody=manifest({files:[fileEntry({size:16})]});
 // 合法重定向 + 令牌不转发
 {
  const importFile=mockImportFile();
  const transport=fakeTransport(url=>{
   const u=url.toString();
   if(u==='https://files.example.com/v1/manifest.json')return redirectRes('https://cdn.example.com/v1/manifest.json');
   if(u==='https://cdn.example.com/v1/manifest.json')return jsonResponse(manifestBody);
   return statusRes(404);
  });
  const svc=createConnectorService({dataDir:tempDir('redirect-ok'),importFile,transport:transport.transport});
  const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json',bearerToken:'演示占位令牌-redirect'});
  const result=await svc.test(src.id);
  assert.equal(result.status,'reachable');
  assert.equal(transport.requests[0].headers.authorization,'Bearer 演示占位令牌-redirect');
  assert.equal(transport.requests[1].headers.authorization,undefined,'令牌不得转发到重定向目标');
 }
 // 重定向到 http → 拒绝
 {
  const svc=createConnectorService({dataDir:dir,importFile:mockImportFile(),transport:fakeTransport(()=>redirectRes('http://cdn.example.com/m.json')).transport});
  const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json'});
  const result=await svc.test(src.id);
  assert.equal(result.status,'error');
  assert.ok(result.error.includes('https'),result.error);
 }
 // 重定向到内网 IP → 拒绝
 {
  const transport=fakeTransport(()=>redirectRes('https://192.168.1.10/m.json'));
  const svc=createConnectorService({dataDir:dir,importFile:mockImportFile(),transport:transport.transport});
  const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json'});
  const result=await svc.test(src.id);
  assert.equal(result.status,'error');
  assert.ok(result.error.includes('内网')||result.error.includes('保留'),result.error);
  assert.equal(transport.requests.length,1,'违规目标不应发起第二次请求');
 }
 // 超过 3 跳 → 拒绝
 {
  const svc=createConnectorService({dataDir:dir,importFile:mockImportFile(),transport:fakeTransport(()=>redirectRes('https://files.example.com/next.json')).transport});
  const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json'});
  const result=await svc.test(src.id);
  assert.equal(result.status,'error');
  assert.ok(result.error.includes('重定向'),result.error);
 }
});

test('大小与类型限制：超限声明不下载、未知类型失败、流式超限中断',async()=>{
 const dir=tempDir('limits'),importFile=mockImportFile();
 const bigWav=150*1024*1024,bigTxt=6*1024*1024,okWav=demo(Buffer.alloc(64,9));
 const transport=fakeTransport(url=>{
  const u=url.toString();
  if(u==='https://files.example.com/v1/manifest.json')return jsonResponse(manifest({files:[
   fileEntry({id:'big-audio',size:bigWav}),
   fileEntry({id:'big-text',name:'big.txt',url:'https://cdn.example.com/big.txt',size:bigTxt}),
   fileEntry({id:'exe',name:'tool.exe',url:'https://cdn.example.com/tool.exe',size:10}),
   fileEntry({id:'ok',url:'https://cdn.example.com/ok.wav',size:64}),
  ]}));
  if(u==='https://cdn.example.com/ok.wav')return bodyRes(okWav);
  return statusRes(500);
 });
 const svc=createConnectorService({dataDir:dir,importFile,transport:transport.transport});
 const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json'});
 const result=await svc.sync(src.id);
 assert.equal(result.imported,1);
 assert.equal(result.failed,3);
 const byId=Object.fromEntries(result.files.map(f=>[f.id,f]));
 assert.ok(byId['big-audio'].error.includes('100 MB'),byId['big-audio'].error);
 assert.ok(byId['big-text'].error.includes('5 MB'),byId['big-text'].error);
 assert.ok(byId['exe'].error.includes('不支持的文件类型'),byId['exe'].error);
 assert.equal(transport.requests.length,2,'超限与未知类型文件不应发起下载');
 // 流式超限：Content-Length 撒谎或缺失时按实际字节中断
 const dir2=tempDir('limits-stream'),importFile2=mockImportFile();
 const chunk=[Buffer.alloc(3*1024*1024,1),Buffer.alloc(2*1024*1024,2),Buffer.from('x')];
 const transport2=fakeTransport(url=>{
  const u=url.toString();
  if(u==='https://files.example.com/v1/manifest.json')return jsonResponse(manifest({files:[fileEntry({id:'liar',name:'liar.txt',url:'https://cdn.example.com/liar.txt',size:1024})]}));
  return {status:200,headers:{},stream:Readable.from(chunk)};
 });
 const svc2=createConnectorService({dataDir:dir2,importFile:importFile2,transport:transport2.transport});
 const src2=await svc2.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json'});
 const result2=await svc2.sync(src2.id);
 assert.equal(result2.failed,1);
 assert.ok(result2.files[0].error.includes('5 MB'),result2.files[0].error);
 assert.equal(importFile2.calls.length,0,'超限数据不得进入导入');
});

test('HTTP 状态映射与令牌内存态：401 提示重新输入，重启后需重新添加',async()=>{
 const dir=tempDir('http-status');
 const manifestBody=manifest({files:[fileEntry({size:16})]});
 const okTransport=()=>fakeTransport(url=>url.toString().endsWith('manifest.json')?jsonResponse(manifestBody):statusRes(404));
 // 无令牌 → 401
 {
  const svc=createConnectorService({dataDir:tempDir('auth-1'),importFile:mockImportFile(),transport:fakeTransport(()=>statusRes(401)).transport});
  const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json'});
  const result=await svc.test(src.id);
  assert.equal(result.status,'error');
  assert.ok(result.error.includes('令牌'),result.error);
  assert.equal(result.error.includes('401'),true);
 }
 // 带令牌 → 成功
 {
  const transport=okTransport();
  const svc=createConnectorService({dataDir:dir,importFile:mockImportFile(),transport:transport.transport});
  const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json',bearerToken:'演示占位令牌-auth'});
  const result=await svc.test(src.id);
  assert.equal(result.status,'reachable');
 }
 // 重启（新实例内存无令牌）→ 明确提示重新填写
 {
  const transport=fakeTransport(()=>statusRes(401));
  const svc=createConnectorService({dataDir:dir,importFile:mockImportFile(),transport:transport.transport});
  const listed=await svc.list();
  assert.equal(listed[0].hasToken,false);
  const src=listed[0].id;
  const result=await svc.test(src);
  assert.equal(result.status,'error');
  assert.ok(result.error.includes('重新'),result.error);
 }
 // 403 / 404 / 5xx
 for(const [status,expect] of [[403,'拒绝'],[404,'不存在'],[503,'HTTP 503']]){
  const svc=createConnectorService({dataDir:tempDir(`auth-${status}`),importFile:mockImportFile(),transport:fakeTransport(()=>statusRes(status)).transport});
  const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json'});
  const result=await svc.test(src.id);
  assert.equal(result.status,'error');
  assert.ok(result.error.includes(expect),`${status}: ${result.error}`);
 }
});

test('错误消息永不包含令牌字面量',async()=>{
 const dir=tempDir('token-leak'),token='演示占位令牌-SECRET-abcdef';
 const svc=createConnectorService({dataDir:dir,importFile:mockImportFile(),transport:fakeTransport(()=>statusRes(401)).transport});
 const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json',bearerToken:token});
 const result=await svc.test(src.id);
 assert.ok(!JSON.stringify(result).includes(token));
 const listed=await svc.list();
 assert.ok(!JSON.stringify(listed).includes(token));
 // importFile 抛错的消息同样被过滤
 const leakyImport=async()=>{throw new Error(`导入失败：令牌 ${token} 校验未通过`)};
 const svc2=createConnectorService({dataDir:tempDir('token-leak-2'),importFile:leakyImport,transport:fakeTransport(url=>{
  const u=url.toString();
  if(u==='https://files.example.com/v1/manifest.json')return jsonResponse(manifest({files:[fileEntry({size:8})]}));
  return bodyRes(demo(Buffer.alloc(8)));
 }).transport});
 const src2=await svc2.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json',bearerToken:token});
 const result2=await svc2.sync(src2.id);
 assert.equal(result2.failed,1);
 assert.ok(!JSON.stringify(result2).includes(token));
 assert.ok(result2.files[0].error.includes('〔已隐藏〕'));
});

test('未注入 importFile：test 可用，sync 文件失败并给出接入提示',async()=>{
 const dir=tempDir('no-import'),svc=createConnectorService({dataDir:dir});
 const src=await svc.add({kind:'simulator'});
 const tested=await svc.test(src.id);
 assert.equal(tested.status,'reachable');
 const result=await svc.sync(src.id);
 assert.equal(result.failed,3);
 assert.ok(result.files.every(f=>f.error.includes('导入通道未接入')));
 const listed=await svc.list();
 assert.equal(listed[0].status,'error');
 assert.throws(()=>createConnectorService({dataDir:dir,importFile:'nope'}),/importFile 必须是函数/);
});

test('importFile 抛错或返回非对象：分别记为失败/导入',async()=>{
 const dir=tempDir('import-err');
 {
  const svc=createConnectorService({dataDir:tempDir('import-throw'),importFile:async()=>{throw new Error('模拟导入失败：磁盘已满')}});
  const src=await svc.add({kind:'simulator'});
  const result=await svc.sync(src.id);
  assert.equal(result.failed,3);
  assert.ok(result.files.every(f=>f.error.includes('磁盘已满')));
 }
 {
  const importFile=mockImportFile();
  let n=0;
  const raw=async()=>{n++;return 'ok'};
  const svc=createConnectorService({dataDir:dir,importFile:raw});
  const src=await svc.add({kind:'simulator'});
  const result=await svc.sync(src.id);
  assert.equal(result.imported,3);
  assert.equal(n,3);
  // 未记录哈希 → 下次仍会调用导入（由服务端内容去重兜底），且结果仍是导入
  const second=await svc.sync(src.id);
  assert.equal(second.imported,3,'非对象返回不记录哈希，下次由服务端去重兜底');
  assert.equal(n,6);
 }
});

test('损坏的 connectors.json：服务可启动，损坏文件留档',async()=>{
 const dir=tempDir('corrupt');
 fs.writeFileSync(path.join(dir,'connectors.json'),'not json {{{');
 const svc=createConnectorService({dataDir:dir,importFile:mockImportFile()});
 assert.deepEqual(await svc.list(),[]);
 assert.ok(fs.readdirSync(dir).some(f=>f.startsWith('connectors.json.corrupt-')));
 // 新配置正常写入
 const src=await svc.add({kind:'simulator'});
 assert.equal((await svc.list()).length,1);
 assert.ok(!fs.readFileSync(path.join(dir,'connectors.json'),'utf8').includes('not json'));
});

test('URL 策略：仅公网 HTTPS，拒绝本地/内网/保留地址与可疑写法',async()=>{
 const pub={lookup:async()=>[{address:'93.184.216.34',family:4}]};
 const privateLookup={lookup:async()=>[{address:'192.168.1.1',family:4}]};
 const loopbackLookup={lookup:async()=>[{address:'127.0.0.1',family:4}]};
 const rejects=async(url,ctx=pub,expect)=>{
  await assert.rejects(()=>assertPublicHttpsUrl(url,ctx),e=>{
   if(expect)assert.match(e.message,expect);
   return e.code==='EPOLICY'||/HTTPS|端口|账号|本地|内网|保留|解析/.test(e.message);
  },`${url} 应被拒绝`);
 };
 await rejects('http://example.com/m.json',pub,/https/i);
 await rejects('ftp://example.com/m.json',pub,/https/i);
 await rejects('https://example.com:8443/m.json',pub,/端口/);
 await rejects('https://user:pass@example.com/m.json',pub,/账号密码/);
 await rejects('https://localhost/m.json',pub,/本地/);
 await rejects('https://box.lan/m.json',pub,/本地/);
 await rejects('https://svc.internal/m.json',pub,/本地|内网/);
 await rejects('https://127.0.0.1/m.json',pub,/内网|本地|保留/);
 await rejects('https://[::1]/m.json',pub,/内网|本地|保留/);
 await rejects('https://169.254.169.254/latest/meta-data/',pub,/内网|本地|保留/);
 await rejects('https://10.0.0.1/m.json',pub,/内网|本地|保留/);
 await rejects('https://192.168.0.1/m.json',pub,/内网|本地|保留/);
 await rejects('https://172.16.0.1/m.json',pub,/内网|本地|保留/);
 await rejects('https://100.64.0.1/m.json',pub,/内网|本地|保留/);
 await rejects('https://224.0.0.1/m.json',pub,/内网|本地|保留/);
 await rejects('https://240.0.0.1/m.json',pub,/内网|本地|保留/);
 await rejects('https://0.0.0.0/m.json',pub,/内网|本地|保留/);
 await rejects('https://2130706433/m.json',loopbackLookup,/内网|本地|保留/,'十进制 IPv4 写法解析到环回');
 await rejects('https://files.example.com/m.json',privateLookup,/内网|保留/,'域名解析到内网');
 await rejects('https://definitely-not-a-host.example/m.json',{lookup:async()=>{const e=new Error('getaddrinfo EAI_AGAIN');e.code='EAI_AGAIN';throw e}},/解析/,'DNS 失败');
 const ok=await assertPublicHttpsUrl('https://files.example.com/v1/manifest.json',pub);
 assert.equal(ok.address,'93.184.216.34');
 assert.equal(ok.host,'files.example.com');
});

test('isForbiddenIp：IPv4/IPv6 私有与保留段判定',()=>{
 const forbidden=['0.0.0.0','10.1.2.3','127.0.0.1','169.254.1.1','172.16.0.1','172.31.255.255','192.0.0.1','192.0.2.9','192.88.99.1','192.168.1.1','198.18.0.1','198.51.100.5','203.0.113.9','224.0.0.1','240.0.0.1','255.255.255.255','100.64.0.1','::','::1','::ffff:127.0.0.1','fe80::1','fc00::1','fd12:3456::1','ff02::1','2001:db8::1','64:ff9b::7f00:1','2002:7f00:1::'];
 const allowed=['8.8.8.8','11.0.0.1','172.32.0.1','93.184.216.34','2606:4700::1111','::ffff:8.8.8.8'];
 for(const ip of forbidden)assert.equal(isForbiddenIp(ip),true,ip);
 for(const ip of allowed)assert.equal(isForbiddenIp(ip),false,ip);
 assert.equal(isForbiddenIp('not-an-ip'),true);
});

test('manifest 文件名清洗与 mtime 归一：路径分隔符、控制字符、epoch 时间戳',async()=>{
 const dir=tempDir('sanitize'),importFile=mockImportFile();
 const transport=fakeTransport(url=>{
  const u=url.toString();
  if(u==='https://files.example.com/v1/manifest.json')return jsonResponse(manifest({files:[
   fileEntry({id:'n1',name:'../../etc/演示录音\u0000隐藏.wav',url:'https://cdn.example.com/n1.wav',size:32,mtime:1727400000}),
   fileEntry({id:'n2',name:'x'.repeat(400)+'.txt',url:'https://cdn.example.com/n2.txt',size:32,mtime:'2026-09-27T10:00:00Z'}),
  ]}));
  if(u.endsWith('n1.wav'))return bodyRes(demo(Buffer.alloc(32,5)));
  return bodyRes(demo(Buffer.alloc(32,6)));
 });
 const svc=createConnectorService({dataDir:dir,importFile,transport:transport.transport});
 const src=await svc.add({kind:'remote-manifest',manifestUrl:'https://files.example.com/v1/manifest.json'});
 const result=await svc.sync(src.id);
 assert.equal(result.imported,2);
 const [a,b]=importFile.calls;
 assert.ok(!a.name.includes('/')&&!a.name.includes('\\')&&!a.name.includes('\u0000'),a.name);
 assert.ok(a.name.includes('演示录音'));
 assert.ok(b.name.length<=200,b.name.length);
 assert.equal(a.mtime,new Date(1727400000*1000).toISOString());
 assert.equal(b.mtime,'2026-09-27T10:00:00.000Z');
});

test('同一来源并发 test/sync 被拒绝；未知 id 报错清晰',async()=>{
 const dir=tempDir('concurrency'),importFile=mockImportFile();
 let release;
 const gate=new Promise(r=>{release=r});
 const slowImport=async input=>{await gate;return importFile(input)};
 const svc=createConnectorService({dataDir:dir,importFile:slowImport});
 const src=await svc.add({kind:'simulator'});
 const pending=svc.sync(src.id);
 await assert.rejects(()=>svc.sync(src.id),/正在同步/);
 await assert.rejects(()=>svc.test(src.id),/正在同步/);
 release();
 const result=await pending;
 assert.equal(result.imported,3);
 await assert.rejects(()=>svc.test('missing-id'),/来源不存在或已移除/);
 await assert.rejects(()=>svc.sync('missing-id'),/来源不存在或已移除/);
});
