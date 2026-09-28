import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Readable} from 'node:stream';
import {handleConnectorApi} from '../connector-routes.mjs';
import {createConnectorService,sha256Hex} from '../connectors/index.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// 复刻 server.mjs 现有 readBody/json（只读参考实现），证明本路由签名与现有入口完全兼容
async function readBody(req){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>500*1024*1024)throw new Error('请求超过 500 MB，请分批导入');chunks.push(chunk)}return JSON.parse(Buffer.concat(chunks).toString()||'{}')}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value))}

// 隔离数据目录 + 仿真现有导入路径的 importFile：按内容哈希去重、留档到隔离目录，返回 {record,duplicate} 与 newAudioRecord/newRecord 相同
function stubImportFile(recordDir){
 const seen=new Set(),records=[];
 const fn=async({name,bytes,mtime,source})=>{
  const hash=sha256Hex(bytes);
  if(seen.has(hash))return {record:{id:`existing-${hash.slice(0,8)}`},duplicate:true};
  seen.add(hash);
  records.push({name,hash,mtime:mtime||'',source});
  await fs.writeFile(path.join(recordDir,`${hash}.bin`),bytes);
  return {record:{id:`rec-${records.length}`},duplicate:false};
 };
 fn.records=records;fn.seen=seen;
 return fn;
}

// 注入传输层模拟远程来源：不访问真实网络；lookup 固定解析到公网 IP 以通过地址策略校验
function fakeTransport(handler){
 const requests=[];
 return {transport:{request:async(urlObj,opts)=>{requests.push(urlObj.toString());return handler(urlObj,opts,requests.length)},lookup:async()=>[{address:'93.184.216.34',family:4}]},requests};
}
const bodyRes=(buffer,headers={})=>({status:200,headers,stream:Readable.from([buffer])});
const jsonResponse=(obj,headers={})=>bodyRes(Buffer.from(JSON.stringify(obj)),{'content-type':'application/json',...headers});
const manifestV1=files=>({version:1,device:{id:'dev-1',name:'测试设备（演示）',model:'测试型号'},files});

// 起一个最小 HTTP 服务复刻整合者的接线方式：既有 Host/Origin/token 校验之后调用 handleConnectorApi
async function fixture(t,{service,createService,token='isolated-connector-token'}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shengji-conn-routes-')),recordDir=path.join(dir,'records'),dataDir=path.join(dir,'connectors');
 await fs.mkdir(recordDir);
 const svc=service??(createService?createService({dataDir,recordDir}):createConnectorService({dataDir,importFile:stubImportFile(recordDir)}));
 const server=http.createServer(async(req,res)=>{try{
  const host=req.headers.host||'';
  if(!/^127\.0\.0\.1:\d+$/.test(host))return json(res,403,{error:'主机地址不受信任'});
  if(req.headers.origin&&!['http://127.0.0.1:5189','http://localhost:5189'].includes(req.headers.origin))return json(res,403,{error:'不允许外部网页访问本地记录'});
  if(req.headers['x-shengji-token']!==token)return json(res,401,{error:'请重新打开声迹以连接本地服务'});
  if(await handleConnectorApi(req,res,{service:svc,readBody,json}))return;
  return json(res,404,{error:'接口不存在'});
 }catch(e){json(res,400,{error:String(e.message||'操作失败').slice(0,700)})}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections?.();return new Promise(r=>server.close(r))});
 const base=`http://127.0.0.1:${server.address().port}`;
 const api=async(route,{method='GET',body,rawBody,headers={}}={})=>{
  const response=await fetch(base+route,{method,headers:{'x-shengji-token':token,'Content-Type':'application/json',...headers},body:rawBody??(body===undefined?undefined:JSON.stringify(body))});
  let parsed=null;try{parsed=await response.json()}catch{}
  return {status:response.status,body:parsed};
 };
 return {api,base,dir,recordDir,service:svc};
}
const addSimulator=(api,over={})=>api('/api/connectors',{method:'POST',body:{kind:'simulator',...over}});
const mockRes=()=>{const log=[];return {log,res:{writeHead(...a){log.push(a)},end(...a){log.push(a)}}}};
const mockServiceDeps={service:{list:async()=>[],add:async()=>({}),remove:async()=>({}),test:async()=>({}),sync:async()=>({})},readBody,json};

test('handleConnectorApi 只接管 /api/connectors 空间，其余路径返回 false 且不写响应',async()=>{
 for(const url of ['/api/state','/api/connectorsFOO','/api/connector','/','/api/connectors-x']){
  const {log,res}=mockRes();const matched=await handleConnectorApi({url,method:'GET',headers:{}},res,{...mockServiceDeps});
  assert.equal(matched,false,`${url} 不应由连接器路由接管`);assert.equal(log.length,0,`${url} 未匹配时不应写响应`);
 }
 const {log,res}=mockRes();const matched=await handleConnectorApi({url:'/api/connectors?brief=1',method:'GET',headers:{}},res,{...mockServiceDeps});
 assert.equal(matched,true);assert.equal(log[0][0],200);assert.deepEqual(JSON.parse(log[1][0]),{sources:[]});
});

test('依赖注入不完整时在匹配路径上明确报错，不匹配路径不做依赖检查',async()=>{
 const {res}=mockRes();
 await assert.rejects(()=>handleConnectorApi({url:'/api/connectors',method:'GET',headers:{}},res,{}),/依赖注入/);
 const {log,res:res2}=mockRes();
 assert.equal(await handleConnectorApi({url:'/api/state',method:'GET',headers:{}},res2,{}),false);
 assert.equal(log.length,0);
});

test('连接器路由在既有鉴权之后调用：token/Origin 校验先于本层，未匹配路径交给调用方兜底',async t=>{
 const {api}=await fixture(t);
 assert.equal((await api('/api/connectors',{headers:{'x-shengji-token':'wrong'}})).status,401);
 assert.equal((await api('/api/connectors',{method:'DELETE',headers:{'x-shengji-token':'wrong'}})).status,401);
 assert.equal((await api('/api/connectors',{headers:{Origin:'https://untrusted.invalid'}})).status,403);
 const other=await api('/api/state');
 assert.equal(other.status,404);assert.equal(other.body.error,'接口不存在');
});

test('列表与新增：模拟来源带演示标记；无效输入返回可解释错误且不产生半配置',async t=>{
 const {api}=await fixture(t);
 assert.deepEqual((await api('/api/connectors')).body,{sources:[]});
 const added=await addSimulator(api,{name:'  演示笔一号  '});
 assert.equal(added.status,200);
 const src=added.body;
 assert.equal(src.kind,'simulator');assert.equal(src.simulated,true);assert.equal(src.status,'configured');
 assert.equal(src.name,'演示笔一号');assert.ok(src.id);assert.ok(src.capabilities.includes('simulated'));
 assert.ok(!('bearerToken' in src)&&!('hasToken' in src),'模拟来源不应出现令牌相关字段');
 const list=(await api('/api/connectors')).body.sources;
 assert.equal(list.length,1);assert.equal(list[0].id,src.id);
 for(const [payload,pattern] of [
  [{},/来源类型无效/],
  [{kind:'iflytek-cloud'},/来源类型无效/],
  [{kind:'remote-manifest'},/清单地址/],
  [{kind:'remote-manifest',manifestUrl:'http://files.example.com/m.json'},/https/],
  [{kind:'remote-manifest',manifestUrl:'https://127.0.0.1/m.json'},/内网|本地/],
  [{kind:'remote-manifest',manifestUrl:'https://localhost/m.json'},/内网|本地/],
  [{kind:'remote-manifest',manifestUrl:'https://files.example.com/m.json',bearerToken:42},/令牌/],
 ]){
  const bad=await api('/api/connectors',{method:'POST',body:payload});
  assert.equal(bad.status,400,JSON.stringify(payload));
  assert.match(bad.body.error,pattern);
 }
 assert.equal((await api('/api/connectors')).body.sources.length,1,'无效请求不得新增来源');
 const raw=await api('/api/connectors',{method:'POST',rawBody:'{not-json'});
 assert.equal(raw.status,400);assert.match(raw.body.error,/JSON/);
 const arr=await api('/api/connectors',{method:'POST',rawBody:'[]'});
 assert.equal(arr.status,400);assert.match(arr.body.error,/请求格式无效/);
});

test('模拟来源：连接测试可达，同步导入并按内容去重，重复同步不产生重复记录',async t=>{
 const {api,recordDir}=await fixture(t);
 const src=(await addSimulator(api)).body;
 const tested=await api(`/api/connectors/${src.id}/test`,{method:'POST'});
 assert.equal(tested.status,200);
 assert.equal(tested.body.status,'reachable');assert.equal(tested.body.simulated,true);
 assert.equal(tested.body.fileCount,3);assert.equal(tested.body.device.model,'模拟器 · 非真实设备');
 const sync1=await api(`/api/connectors/${src.id}/sync`,{method:'POST'});
 assert.equal(sync1.status,200);
 assert.equal(sync1.body.simulated,true);assert.equal(sync1.body.discovered,3);
 assert.equal(sync1.body.imported,3);assert.equal(sync1.body.duplicates,0);assert.equal(sync1.body.failed,0);
 assert.deepEqual(sync1.body.files.map(f=>f.status),['imported','imported','imported']);
 assert.ok(sync1.body.files.every(f=>f.name.includes('演示')),'演示文件应显式标注演示，不冒充真实设备录音');
 assert.equal((await fs.readdir(recordDir)).length,3);
 const sync2=await api(`/api/connectors/${src.id}/sync`,{method:'POST'});
 assert.equal(sync2.body.imported,0);assert.equal(sync2.body.duplicates,3);assert.equal(sync2.body.failed,0);
 assert.equal((await fs.readdir(recordDir)).length,3,'重复同步不得重复导入文件');
 const listed=(await api('/api/connectors')).body.sources[0];
 assert.equal(listed.status,'reachable');assert.ok(listed.lastSyncAt);assert.equal(listed.lastError,'');
});

test('断线：连接与同步返回可解释的 error 状态，来源落为 error 且不产生伪记录',async t=>{
 const {transport}=fakeTransport(async()=>{const e=new Error('connect ECONNREFUSED 127.0.0.1:443');e.code='ECONNREFUSED';throw e});
 const {api,recordDir}=await fixture(t,{createService:({dataDir,recordDir:rd})=>createConnectorService({dataDir,importFile:stubImportFile(rd),transport})});
 const src=(await api('/api/connectors',{method:'POST',body:{kind:'remote-manifest',name:'断线来源',manifestUrl:'https://files.example.com/v1/manifest.json',bearerToken:'STANDIN-TOKEN-NOT-REAL-123456'}})).body;
 const tested=await api(`/api/connectors/${src.id}/test`,{method:'POST'});
 assert.equal(tested.status,200);
 assert.equal(tested.body.status,'error');assert.equal(tested.body.simulated,false);
 assert.match(tested.body.error,/拒绝连接/);assert.ok(!JSON.stringify(tested.body).includes('STANDIN-TOKEN'));
 const synced=await api(`/api/connectors/${src.id}/sync`,{method:'POST'});
 assert.equal(synced.status,200);assert.equal(synced.body.discovered,0);assert.equal(synced.body.imported,0);
 assert.match(synced.body.error,/拒绝连接/);
 assert.equal((await fs.readdir(recordDir)).length,0);
 const listed=(await api('/api/connectors')).body.sources[0];
 assert.equal(listed.status,'error');assert.match(listed.lastError,/拒绝连接/);assert.equal(listed.hasToken,true);
});

test('无效清单：版本不符与非法 JSON 返回 unsupported，可解释且不导入',async t=>{
 const payloads={v2:{version:2,files:[]},html:'<html>not json</html>'};
 for(const [label,payload] of Object.entries(payloads)){
  const {transport}=fakeTransport(async()=>typeof payload==='string'?bodyRes(Buffer.from(payload)):jsonResponse(payload));
  const {api,recordDir}=await fixture(t,{createService:({dataDir,recordDir:rd})=>createConnectorService({dataDir,importFile:stubImportFile(rd),transport})});
  const src=(await api('/api/connectors',{method:'POST',body:{kind:'remote-manifest',manifestUrl:'https://files.example.com/m.json'}})).body;
  const tested=await api(`/api/connectors/${src.id}/test`,{method:'POST'});
  assert.equal(tested.body.status,'unsupported',label);assert.match(tested.body.error,/不支持此来源/,label);
  const synced=await api(`/api/connectors/${src.id}/sync`,{method:'POST'});
  assert.equal(synced.body.discovered,0,label);assert.match(synced.body.error,/不支持此来源/,label);
  assert.equal((await fs.readdir(recordDir)).length,0,label);
 }
});

test('下载中断：清单可达但文件传输中断，同步按 failed 汇报且不产生记录',async t=>{
 const {transport}=fakeTransport(async urlObj=>{
  if(urlObj.pathname.endsWith('.json'))return jsonResponse(manifestV1([{id:'f1',name:'演示录音-中断.wav',url:'https://cdn.example.com/f1.wav',size:4}]));
  const stream=new Readable({read(){}});
  setTimeout(()=>{stream.push(Buffer.from('WAV'));stream.emit('aborted')},10);
  return {status:200,headers:{},stream};
 });
 const {api,recordDir}=await fixture(t,{createService:({dataDir,recordDir:rd})=>createConnectorService({dataDir,importFile:stubImportFile(rd),transport})});
 const src=(await api('/api/connectors',{method:'POST',body:{kind:'remote-manifest',manifestUrl:'https://files.example.com/m.json'}})).body;
 const synced=await api(`/api/connectors/${src.id}/sync`,{method:'POST'});
 assert.equal(synced.status,200);
 assert.equal(synced.body.discovered,1);assert.equal(synced.body.imported,0);assert.equal(synced.body.failed,1);
 assert.equal(synced.body.files[0].status,'failed');assert.match(synced.body.files[0].error,/中断/);
 assert.equal((await fs.readdir(recordDir)).length,0,'中断的文件不得产生记录');
 assert.equal((await api('/api/connectors')).body.sources[0].status,'error');
});

test('bearer token 只留内存：不进 connectors.json、不回显在响应，错误消息被兜底脱敏',async t=>{
 const {api,dir}=await fixture(t);
 const token='STANDIN-SECRET-abc123XYZ-9876543210';
 const src=(await api('/api/connectors',{method:'POST',body:{kind:'remote-manifest',manifestUrl:'https://files.example.com/m.json',bearerToken:token}})).body;
 assert.ok(!JSON.stringify(src).includes(token));assert.equal(src.hasToken,true);
 const stored=await fs.readFile(path.join(dir,'connectors','connectors.json'),'utf8');
 assert.ok(!stored.includes(token),'connectors.json 不得包含令牌');
 // 注入一个故意在错误里回显令牌的 service，验证路由层兜底脱敏
 const mock={list:async()=>[],add:async()=>({id:'mock-1',kind:'remote-manifest',simulated:false,status:'configured'}),remove:async()=>({ok:true}),test:async()=>{throw new Error(`连接失败：Bearer ${token} 无效`)},sync:async()=>{throw new Error(`同步失败：${token} 过期`)}};
 const m=await fixture(t,{service:mock});
 await m.api('/api/connectors',{method:'POST',body:{kind:'remote-manifest',manifestUrl:'https://files.example.com/m.json',bearerToken:token}});
 const t1=await m.api('/api/connectors/mock-1/test',{method:'POST'});
 assert.equal(t1.status,400);assert.ok(!JSON.stringify(t1.body).includes(token));assert.match(t1.body.error,/〔已隐藏〕/);
 const s1=await m.api('/api/connectors/mock-1/sync',{method:'POST'});
 assert.equal(s1.status,400);assert.ok(!JSON.stringify(s1.body).includes(token));assert.match(s1.body.error,/〔已隐藏〕/);
});

test('删除配置不删记录：DELETE 只移除来源，已导入记录与留档保持不动',async t=>{
 const {api,recordDir}=await fixture(t);
 const src=(await addSimulator(api)).body;
 await api(`/api/connectors/${src.id}/sync`,{method:'POST'});
 assert.equal((await fs.readdir(recordDir)).length,3);
 assert.equal((await api(`/api/connectors/${src.id}`,{method:'DELETE'})).status,200);
 assert.deepEqual((await api('/api/connectors')).body,{sources:[]});
 assert.equal((await api(`/api/connectors/${src.id}`,{method:'DELETE'})).status,404);
 assert.equal((await fs.readdir(recordDir)).length,3,'删除来源配置不得删除已导入记录');
 const again=(await addSimulator(api)).body;
 assert.notEqual(again.id,src.id);
 const resync=await api(`/api/connectors/${again.id}/sync`,{method:'POST'});
 assert.equal(resync.body.imported,0);assert.equal(resync.body.duplicates,3,'内容哈希去重兜底，不因配置重建产生重复记录');
 assert.equal((await fs.readdir(recordDir)).length,3);
});

test('未知来源返回 404，不支持的请求组合返回 405/404',async t=>{
 const {api}=await fixture(t);
 for(const route of ['/api/connectors/nope/test','/api/connectors/nope/sync']){
  const r=await api(route,{method:'POST'});assert.equal(r.status,404);assert.match(r.body.error,/来源不存在/);
 }
 const del=await api('/api/connectors/nope',{method:'DELETE'});
 assert.equal(del.status,404);assert.match(del.body.error,/来源不存在/);
 assert.equal((await api('/api/connectors',{method:'PUT'})).status,405);
 assert.equal((await api('/api/connectors/some-id')).status,405);
 assert.equal((await api('/api/connectors/some-id/test',{method:'PATCH'})).status,405);
 const unknown=await api('/api/connectors/some-id/unknown',{method:'POST'});
 assert.equal(unknown.status,404);assert.equal(unknown.body.error,'接口不存在');
});

test('并发同步：同一来源正在同步时再次请求得到可解释错误',async t=>{
 const {transport}=fakeTransport(async urlObj=>{
  if(urlObj.pathname.endsWith('.json')){await sleep(150);return jsonResponse(manifestV1([{id:'f1',name:'演示录音-并发.wav',url:'https://cdn.example.com/f1.wav',size:4}]))}
  return bodyRes(Buffer.from('WAV!'));
 });
 const {api}=await fixture(t,{createService:({dataDir,recordDir})=>createConnectorService({dataDir,importFile:stubImportFile(recordDir),transport})});
 const src=(await api('/api/connectors',{method:'POST',body:{kind:'remote-manifest',manifestUrl:'https://files.example.com/m.json'}})).body;
 const [a,b]=await Promise.all([
  api(`/api/connectors/${src.id}/sync`,{method:'POST'}),
  api(`/api/connectors/${src.id}/sync`,{method:'POST'}),
 ]);
 assert.deepEqual([a.status,b.status].sort(),[200,400]);
 const rejected=a.status===400?a:b;
 assert.match(rejected.body.error,/正在同步/);
});
