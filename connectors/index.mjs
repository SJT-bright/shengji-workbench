// 声迹 · 录音笔连接器（契约 XF-20260927-A，verification/xunfei-connector-20260927/contract.md）
// 职责：来源配置持久化（bearer token 只留内存）、simulator 演示来源、remote-manifest v1 HTTPS 来源；
// 导入通过注入的 importFile 走现有导入与哈希去重，本模块不直接写 SQLite，不碰正式数据库。
// 网络边界：仅 HTTPS（443），拒绝 loopback/内网/保留地址与降级重定向，解析域名并固定连接 IP。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import https from 'node:https';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';

const MODULE_DIR=path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR=path.join(MODULE_DIR,'fixtures');
const KINDS=new Set(['simulator','remote-manifest']);
const SIM_CAPS=['simulated','demo-audio','demo-text','import','dedupe'];
const REMOTE_CAPS=['manifest-v1','https-download','audio-import','text-import','dedupe'];
const TEXT_EXT={txt:5*1024*1024,md:5*1024*1024,srt:5*1024*1024,vtt:5*1024*1024};
const AUDIO_EXT={mp3:100*1024*1024,m4a:100*1024*1024,wav:100*1024*1024};
const MAX_MANIFEST_BYTES=2*1024*1024,MAX_MANIFEST_FILES=200,MAX_IMPORTS_PER_SOURCE=500;
const MANIFEST_TIMEOUT_MS=15000,FILE_TIMEOUT_MS=120000,MAX_REDIRECTS=3;
const UA='ShengJi-Connector/0.1 (local macOS app)';
const ERR={POLICY:'EPOLICY',NET:'ENET',HTTP:'EHTTP',SIZE:'ESIZE',TIMEOUT:'ETIMEOUT',UNSUPPORTED:'EUNSUPPORTED'};
export class ConnectorError extends Error{constructor(code,message){super(message);this.name='ConnectorError';this.code=code}}
const nowIso=()=>new Date().toISOString();
const fmtMB=n=>{const mb=n/1048576;return `${mb>=10?Math.round(mb):mb} MB`};
export const sha256Hex=b=>crypto.createHash('sha256').update(b).digest('hex');

// ---------- 地址策略：仅公网 HTTPS，拒绝本地/内网/保留地址 ----------
const v4num=(a,b=0,c=0,d=0)=>((a<<24)|(b<<16)|(c<<8)|d)>>>0;
const V4_FORBIDDEN=[[v4num(0),8],[v4num(10),8],[v4num(100,64),10],[v4num(127),8],[v4num(169,254),16],[v4num(172,16),12],[v4num(192,0),24],[v4num(192,0,2),24],[v4num(192,88,99),24],[v4num(192,168),16],[v4num(198,18),15],[v4num(198,51,100),24],[v4num(203,0,113),24],[v4num(224),4],[v4num(240),4]];
function ipv4Forbidden(n){for(const[base,bits]of V4_FORBIDDEN)if((((n^base)>>>0)>>>(32-bits))===0)return true;return false}
function ipv6ToBig(s){
 const m=s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
 if(m){const o=m[2].split('.').map(Number);if(o.length!==4||o.some(x=>x>255))return null;s=`${m[1]}${(o[0]<<8|o[1]).toString(16)}:${(o[2]<<8|o[3]).toString(16)}`}
 const parts=s.split('::');if(parts.length>2)return null;
 const head=parts[0]?parts[0].split(':'):[],tail=parts.length===2&&parts[1]?parts[1].split(':'):[];
 if(head.length+tail.length>8)return null;
 const groups=[...head,...Array(8-head.length-tail.length).fill('0'),...tail];
 let v=0n;for(const g of groups){if(!/^[0-9a-f]{1,4}$/i.test(g))return null;v=(v<<16n)|BigInt(parseInt(g,16))}
 return v;
}
export function isForbiddenIp(ip){
 if(net.isIPv4(ip))return ipv4Forbidden(ip.split('.').reduce((n,o)=>(n<<8|Number(o))>>>0,0));
 if(net.isIPv6(ip)){
  const v=ipv6ToBig(ip);if(v===null)return true;
  if(v===0n||v===1n)return true;
  if((v>>32n)===0xffffn)return ipv4Forbidden(Number(v&0xffffffffn)); // ::ffff:a.b.c.d IPv4 映射段
  if(v<(1n<<32n))return ipv4Forbidden(Number(v)); // ::a.b.c.d 兼容段
  const top=v>>96n;
  if(top===0x64ff9bn)return ipv4Forbidden(Number(v&0xffffffffn)); // NAT64
  const first=Number(v>>112n);
  if(first===0x2002&&ipv4Forbidden(Number((v>>80n)&0xffffffffn)))return true; // 6to4 内嵌 v4
  const b=Number((v>>120n)&0xffn);
  if(b===0xfc||b===0xfd||b===0xff)return true;
  if((first>=0xfe80&&first<=0xfebf)||first===0x100||top===0x20010db8n)return true;
  return false;
 }
 return true;
}
const LOCAL_NAME=/^(localhost|ip6-localhost|ip6-loopback|broadcasthost)$/i;
const LOCAL_SUFFIX=/\.(localhost|local|lan|internal|home|arpa)$/i;
// 字面校验（不做 DNS）：add() 时用于快速拦截明显违规地址
export function assertHttpsLiteral(urlStr){
 let u;try{u=new URL(urlStr)}catch{throw new ConnectorError(ERR.POLICY,'地址格式无效，请填写完整的 HTTPS 地址')}
 if(u.protocol!=='https:')throw new ConnectorError(ERR.POLICY,'清单地址必须以 https:// 开头');
 if(u.port&&u.port!=='443')throw new ConnectorError(ERR.POLICY,'仅支持标准 HTTPS 端口（443），请去掉地址中的端口号');
 if(u.username||u.password)throw new ConnectorError(ERR.POLICY,'地址中不应包含账号密码，请改用访问令牌');
 if(urlStr.length>2048)throw new ConnectorError(ERR.POLICY,'清单地址过长');
 const raw=u.hostname,host=raw.startsWith('[')?raw.slice(1,-1).toLowerCase():raw.toLowerCase();
 if(!host)throw new ConnectorError(ERR.POLICY,'地址缺少主机名');
 if(LOCAL_NAME.test(host)||LOCAL_SUFFIX.test(host))throw new ConnectorError(ERR.POLICY,'不允许本地地址，请填写公网 HTTPS 地址');
 const family=net.isIP(host);
 if(family&&isForbiddenIp(host))throw new ConnectorError(ERR.POLICY,'出于安全考虑，不允许内网、本地或保留地址');
 return {url:u,host,family};
}
const defaultLookup=host=>dns.promises.lookup(host,{all:true,verbatim:true});
// 完整校验（含 DNS，并返回用于固定连接的 IP）：test/sync 与每一跳重定向都会执行
export async function assertPublicHttpsUrl(urlStr,{lookup}={}){
 const lit=assertHttpsLiteral(urlStr);
 if(lit.family)return {host:lit.host,address:lit.host,family:lit.family};
 let addrs;
 try{addrs=await (lookup||defaultLookup)(lit.host)}
 catch(e){throw new ConnectorError(ERR.POLICY,`无法解析来源域名（${e?.code||e?.message||'DNS 失败'}），请检查地址或网络`)}
 if(!Array.isArray(addrs)||!addrs.length)throw new ConnectorError(ERR.POLICY,'无法解析来源域名，请检查地址');
 for(const a of addrs)if(isForbiddenIp(a.address))throw new ConnectorError(ERR.POLICY,'该域名解析到内网或保留地址，已拒绝连接');
 return {host:lit.host,address:addrs[0].address,family:addrs[0].family};
}

// ---------- 严格 HTTPS 请求：手动跟重定向、逐跳校验、大小与超时上限 ----------
function wrapNetError(e){
 if(e instanceof ConnectorError)return e;
 const map={ENOTFOUND:'无法解析来源域名，请检查地址或网络',ECONNREFUSED:'来源拒绝连接',ECONNRESET:'连接被来源重置',EHOSTUNREACH:'无法连接来源服务器',ENETUNREACH:'网络不可达',ETIMEDOUT:'连接超时，请检查网络',CERT_HAS_EXPIRED:'来源证书已过期',UNABLE_TO_VERIFY_LEAF_SIGNATURE:'来源证书无法验证',DEPTH_ZERO_SELF_SIGNED_CERT:'来源证书不受信任',SELF_SIGNED_CERT_IN_CHAIN:'来源证书链不受信任',EPROTO:'安全连接建立失败（TLS 错误）'};
 const code=e?.code||'';
 return new ConnectorError(ERR.NET,map[code]||`网络请求失败（${code||e?.message||'未知错误'}）`);
}
function defaultRequest(urlObj,{method='GET',headers={},timeoutMs=15000,lookupPin}={}){
 return new Promise((resolve,reject)=>{
  const opts={method,headers,agent:false,timeout:timeoutMs,hostname:urlObj.hostname,port:urlObj.port||443,path:urlObj.pathname+urlObj.search,servername:urlObj.hostname.replace(/^\[|\]$/g,'')};
  if(lookupPin)opts.lookup=(h,o,cb)=>cb(null,lookupPin.address,lookupPin.family||4); // 固定到已校验 IP，避免 DNS 重绑定
  const req=https.request(opts,res=>resolve({status:res.statusCode,headers:res.headers,stream:res}));
  req.on('timeout',()=>req.destroy(new ConnectorError(ERR.TIMEOUT,'连接超时，请检查网络')));
  req.on('error',reject);
  req.end();
 });
}
async function strictRequest(urlStr,{token='',maxBytes,timeoutMs,accept='*/*',transport}={}){
 const req=transport?.request||defaultRequest;
 let current=String(urlStr);
 for(let hop=0;;hop++){
  const pin=await assertPublicHttpsUrl(current,{lookup:transport?.lookup});
  const headers={accept,'user-agent':UA};
  if(token&&hop===0)headers.authorization=`Bearer ${token}`; // 令牌不随重定向转发到其他地址
  let res;
  try{res=await req(new URL(current),{method:'GET',headers,timeoutMs,lookupPin:pin})}
  catch(e){throw wrapNetError(e)}
  if([301,302,303,307,308].includes(res.status)){
   res.stream.on?.('error',()=>{});res.stream.resume?.();
   if(hop>=MAX_REDIRECTS)throw new ConnectorError(ERR.NET,'重定向次数过多，已中断');
   if(!res.headers?.location)throw new ConnectorError(ERR.NET,'来源返回的重定向缺少目标地址');
   let next;try{next=new URL(res.headers.location,current)}catch{throw new ConnectorError(ERR.NET,'重定向目标地址无效')}
   current=next.toString();continue;
  }
  if(res.status===401)throw new ConnectorError(ERR.HTTP,'来源需要访问令牌，或令牌已失效（401）。令牌不会保存，重启声迹后需重新添加来源并填写');
  if(res.status===403)throw new ConnectorError(ERR.HTTP,'来源拒绝了访问（403），请检查令牌或来源权限');
  if(res.status===404)throw new ConnectorError(ERR.HTTP,'来源地址不存在（404），请检查清单地址');
  if(res.status<200||res.status>=300)throw new ConnectorError(ERR.HTTP,`来源返回了无法处理的响应（HTTP ${res.status}）`);
  const cl=Number(res.headers?.['content-length']);
  if(Number.isFinite(cl)&&cl>=0&&cl>maxBytes){res.stream.resume?.();throw new ConnectorError(ERR.SIZE,`内容超过大小上限（${fmtMB(maxBytes)}），已停止下载`)}
  return {stream:res.stream,finalUrl:current};
 }
}
function readCapped(stream,{maxBytes,timeoutMs}){
 return new Promise((resolve,reject)=>{
  const hash=crypto.createHash('sha256'),chunks=[];let size=0,done=false;
  const finish=(err,data)=>{if(done)return;done=true;clearTimeout(timer);try{stream.destroy()}catch{}err?reject(err):resolve(data)};
  const timer=setTimeout(()=>finish(new ConnectorError(ERR.TIMEOUT,`下载超时（超过 ${Math.round(timeoutMs/1000)} 秒），已中断`)),timeoutMs);
  stream.on('data',c=>{if(done)return;size+=c.length;if(size>maxBytes){finish(new ConnectorError(ERR.SIZE,`内容超过大小上限（${fmtMB(maxBytes)}），已中断下载`));return}hash.update(c);chunks.push(c)});
  stream.on('aborted',()=>finish(new ConnectorError(ERR.NET,'连接中断，下载未完成')));
  stream.on('error',e=>finish(e instanceof ConnectorError?e:wrapNetError(e)));
  stream.on('end',()=>finish(null,{bytes:Buffer.concat(chunks),sha256:hash.digest('hex')}));
 });
}

// ---------- manifest v1 ----------
function str(v,cap){return typeof v==='string'?v.trim().slice(0,cap):''}
function sanitizeName(v){
 if(typeof v!=='string')return '未命名文件';
 let s=v.replace(/[\u0000-\u001f\u007f]/g,'').replace(/[\\\/]/g,'_').trim();
 if(!s)return '未命名文件';
 if(s.length<=200)return s;
 const ext=s.match(/\.[a-z0-9]{1,10}$/i)?.[0]||'';
 return s.slice(0,200-ext.length)+ext;
}
function normMtime(v){
 if(typeof v==='number'&&Number.isFinite(v)){const d=new Date(v<1e12?v*1000:v);return Number.isNaN(+d)?undefined:d.toISOString()}
 if(typeof v==='string'&&v.trim()){const d=new Date(v);return Number.isNaN(+d)?undefined:d.toISOString()}
 return undefined;
}
function normalizeSha(v){return typeof v==='string'&&/^[a-f0-9]{64}$/i.test(v)?v.toLowerCase():undefined}
export function normalizeManifest(json){
 if(!json||typeof json!=='object'||Array.isArray(json))throw new ConnectorError(ERR.UNSUPPORTED,'不支持此来源：返回内容不是声迹可识别的清单（manifest v1）');
 if(json.version===undefined)throw new ConnectorError(ERR.UNSUPPORTED,'不支持此来源：清单缺少 version 字段（需要 manifest v1）');
 if(json.version!==1)throw new ConnectorError(ERR.UNSUPPORTED,`不支持此来源：清单版本为 ${JSON.stringify(json.version).slice(0,40)}，声迹目前仅支持 manifest v1`);
 if(!Array.isArray(json.files))throw new ConnectorError(ERR.UNSUPPORTED,'不支持此来源：清单缺少文件列表（files）');
 const device={id:str(json.device?.id,120),name:str(json.device?.name,120),model:str(json.device?.model,120)};
 const truncated=json.files.length>MAX_MANIFEST_FILES;
 const files=json.files.slice(0,MAX_MANIFEST_FILES).map(normalizeFile);
 return {device,files,truncated};
}
function normalizeFile(raw){
 const name=sanitizeName(raw?.name),id=str(raw?.id,200),url=str(raw?.url,2048);
 if(!id)return {ok:false,id:'',name,error:'清单文件缺少有效 id'};
 if(!url)return {ok:false,id,name,error:'清单文件缺少下载地址（url）'};
 try{assertHttpsLiteral(url)}catch(e){return {ok:false,id,name,error:e.message}}
 if(typeof raw?.size!=='number'||!Number.isFinite(raw.size)||raw.size<0)return {ok:false,id,name,error:'清单文件缺少有效文件大小（size）'};
 const file={id,name,url,size:raw.size};
 const mtime=normMtime(raw?.mtime);if(mtime)file.mtime=mtime;
 const sha256=normalizeSha(raw?.sha256);if(sha256)file.sha256=sha256;
 return {ok:true,file};
}
async function fetchManifest(url,{token='',transport}={}){
 const {stream}=await strictRequest(url,{token,maxBytes:MAX_MANIFEST_BYTES,timeoutMs:MANIFEST_TIMEOUT_MS,accept:'application/json, text/json, */*',transport});
 const {bytes}=await readCapped(stream,{maxBytes:MAX_MANIFEST_BYTES,timeoutMs:MANIFEST_TIMEOUT_MS});
 let json;try{json=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''))}catch{throw new ConnectorError(ERR.UNSUPPORTED,'不支持此来源：返回内容不是有效的 JSON 清单')}
 return normalizeManifest(json);
}

// ---------- 演示 fixture（模拟来源，显式“演示录音”，不冒充真实设备录音） ----------
const SIM_FILES=[{name:'演示录音-001-会议速记.wav',wav:{seconds:3,freq:440}},{name:'演示录音-002-灵感速记.wav',wav:{seconds:2,freq:523.25}}];
const DEMO_TRANSCRIPT_NAME='演示转写-001-周会要点.txt';
const DEMO_TRANSCRIPT=`【演示数据 · 非真实录音】
本文件由声迹连接器的模拟来源生成，用于在未连接真实录音笔时演示导入、去重与转写排队链路。内容不来自任何真实会议或设备。

一、会议速记要点
1. 先用演示来源打通导入与去重流程，再接入真实设备。
2. 演示音频仅包含测试音，不代表任何真实会议内容。
3. 同步结果会区分导入、重复与失败，重复判定依据内容哈希。
`;
function demoWav({seconds,freq,amp=0.06,rate=8000}){
 const n=Math.floor(seconds*rate),data=Buffer.alloc(n*2);
 for(let i=0;i<n;i++){const t=i/rate,env=Math.min(1,t*4,(seconds-t)*4);data.writeInt16LE(Math.round(Math.sin(2*Math.PI*freq*t)*env*amp*32767),i*2)}
 const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+data.length,4);h.write('WAVE',8);h.write('fmt ',12);
 h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(rate,24);h.writeUInt32LE(rate*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);
 h.write('data',36);h.writeUInt32LE(data.length,40);
 return Buffer.concat([h,data]);
}
function ensureFixtures(){
 fs.mkdirSync(FIXTURE_DIR,{recursive:true,mode:0o755});
 for(const f of SIM_FILES){const p=path.join(FIXTURE_DIR,f.name);if(!fs.existsSync(p))fs.writeFileSync(p,demoWav(f.wav),{mode:0o644})}
 const tp=path.join(FIXTURE_DIR,DEMO_TRANSCRIPT_NAME);
 if(!fs.existsSync(tp))fs.writeFileSync(tp,DEMO_TRANSCRIPT,{mode:0o644});
}
function buildSimManifest(){
 ensureFixtures();
 const files=[...SIM_FILES.map(f=>f.name),DEMO_TRANSCRIPT_NAME].map(name=>{
  const p=path.join(FIXTURE_DIR,name),bytes=fs.readFileSync(p),st=fs.statSync(p);
  return {id:name,name,size:st.size,mtime:st.mtime.toISOString(),sha256:sha256Hex(bytes)};
 });
 return {device:{id:'sim-demo',name:'演示录音设备',model:'模拟器 · 非真实设备'},files};
}
function safeFixturePath(id){return path.join(FIXTURE_DIR,path.basename(String(id)))}

// ---------- 服务 ----------
export function createConnectorService({dataDir,importFile,transport}={}){
 if(typeof dataDir!=='string'||!dataDir)throw new Error('缺少连接器数据目录 dataDir');
 if(importFile!==undefined&&typeof importFile!=='function')throw new Error('importFile 必须是函数（由 server.mjs 注入现有导入路径）');
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const storeFile=path.join(dataDir,'connectors.json');
 const tokens=new Map(); // bearer token 只留内存，不写入 connectors.json、不进日志
 const busy=new Map();
 try{ensureFixtures()}catch{/* 打包只读环境下缺少演示文件时，test/sync 会明确报错 */}
 let doc=loadDoc();
 function loadDoc(){
  try{
   const parsed=JSON.parse(fs.readFileSync(storeFile,'utf8'));
   if(parsed&&typeof parsed==='object'&&Array.isArray(parsed.sources))
    return {version:1,sources:parsed.sources.filter(s=>s&&typeof s==='object'&&KINDS.has(s.kind)&&typeof s.id==='string').map(coerceSource)};
  }catch(e){
   if(e.code!=='ENOENT'){try{fs.copyFileSync(storeFile,`${storeFile}.corrupt-${Date.now()}`)}catch{}}
  }
  return {version:1,sources:[]};
 }
 function coerceSource(s){
  return {id:String(s.id),kind:s.kind,name:sanitizeName(s.name)||'未命名来源',
   ...(s.kind==='remote-manifest'&&typeof s.manifestUrl==='string'&&s.manifestUrl?{manifestUrl:s.manifestUrl}:{}),
   createdAt:typeof s.createdAt==='string'?s.createdAt:nowIso(),
   status:['configured','reachable','unsupported','error'].includes(s.status)?s.status:'configured',
   lastSyncAt:typeof s.lastSyncAt==='string'?s.lastSyncAt:'',lastError:typeof s.lastError==='string'?s.lastError:'',
   simulated:s.kind==='simulator',capabilities:Array.isArray(s.capabilities)?s.capabilities.slice(0,10).map(String):(s.kind==='simulator'?[...SIM_CAPS]:[...REMOTE_CAPS]),
   imported:s.imported&&typeof s.imported==='object'&&!Array.isArray(s.imported)?s.imported:{}};
 }
 function saveDoc(){
  for(const s of doc.sources){
   const entries=Object.entries(s.imported||{});
   if(entries.length>MAX_IMPORTS_PER_SOURCE){
    entries.sort((a,b)=>String(a[1]?.importedAt||'').localeCompare(String(b[1]?.importedAt||'')));
    s.imported=Object.fromEntries(entries.slice(-MAX_IMPORTS_PER_SOURCE));
   }
  }
  const tmp=`${storeFile}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(doc,null,1),{mode:0o600});
  fs.renameSync(tmp,storeFile);
 }
 function sourcePublic(s){
  const out={id:s.id,name:s.name,kind:s.kind,simulated:!!s.simulated,status:s.status,lastSyncAt:s.lastSyncAt||'',lastError:s.lastError||'',capabilities:[...s.capabilities],createdAt:s.createdAt};
  if(s.manifestUrl)out.manifestUrl=s.manifestUrl;
  if(s.kind==='remote-manifest')out.hasToken=tokens.has(s.id);
  return out;
 }
 const findSource=id=>{const s=doc.sources.find(x=>x.id===id);if(!s)throw new Error('来源不存在或已移除');return s};
 const guardBusy=(id,label)=>{if(busy.has(id))throw new Error(`该来源正在${busy.get(id)==='test'?'测试':'同步'}，请稍后再试`);busy.set(id,label)};
 const san=(id,msg)=>{const t=tokens.get(id);let out=String(msg??'');if(t&&out.includes(t))out=out.split(t).join('〔已隐藏〕');return out.slice(0,400)};
 const markStatus=(s,status,err)=>{s.status=status;s.lastError=err||''};
 const mapStatus=e=>e instanceof ConnectorError&&e.code===ERR.UNSUPPORTED?'unsupported':'error';

 async function list(){return doc.sources.map(sourcePublic)}

 async function add(input){
  const kind=input?.kind;
  if(!KINDS.has(kind))throw new Error('来源类型无效：仅支持 simulator（模拟演示）或 remote-manifest（远程清单）');
  let name=typeof input?.name==='string'&&input.name.trim()?sanitizeName(input.name).slice(0,60):'';
  if(!name)name=kind==='simulator'?'演示录音笔（模拟）':'远程文件来源';
  let manifestUrl='';
  if(kind==='remote-manifest'){
   manifestUrl=String(input?.manifestUrl||'').trim();
   if(!manifestUrl)throw new Error('请填写远程清单地址（HTTPS）');
   assertHttpsLiteral(manifestUrl); // 添加时做字面校验拦截明显违规；完整 DNS 校验在测试/同步时进行
  }
  const token=kind==='remote-manifest'?input?.bearerToken:undefined;
  if(token!==undefined&&token!==null&&(typeof token!=='string'||token.length>4096))throw new Error('访问令牌格式无效（应为不超过 4096 字符的字符串）');
  const s={id:crypto.randomUUID(),kind,name,createdAt:nowIso(),status:'configured',lastSyncAt:'',lastError:'',
   simulated:kind==='simulator',capabilities:kind==='simulator'?[...SIM_CAPS]:[...REMOTE_CAPS],imported:{}};
  if(manifestUrl)s.manifestUrl=manifestUrl;
  doc.sources.push(s);saveDoc();
  if(kind==='remote-manifest'&&typeof token==='string'&&token)tokens.set(s.id,token);
  return sourcePublic(s);
 }

 async function remove(id){
  const i=doc.sources.findIndex(x=>x.id===id);
  if(i<0)throw new Error('来源不存在或已移除');
  doc.sources.splice(i,1);tokens.delete(id);saveDoc(); // 只移除配置，已导入记录一律不动
  return {ok:true};
 }

 async function importOne(s,entry,{token,transport,device}){
  const ext=(entry.name.match(/\.([a-z0-9]{1,10})$/i)?.[1]||'').toLowerCase();
  const limit=TEXT_EXT[ext]??AUDIO_EXT[ext];
  if(!limit)return {status:'failed',error:`不支持的文件类型：${ext?`.${ext}`:'缺少扩展名'}。声迹支持 MP3/M4A/WAV 音频与 TXT/MD/SRT/VTT 文字稿`};
  if(entry.size>limit)return {status:'failed',error:`文件超过大小上限（${fmtMB(limit)}），未下载`};
  const remembered=s.imported?.[entry.id];
  if(entry.sha256&&remembered?.sha256===entry.sha256)return {status:'duplicate'};
  if(!importFile)return {status:'failed',error:'导入通道未接入：当前版本尚未连接导入功能，请更新声迹后重试'};
  let bytes,sha256;
  if(s.kind==='simulator'){bytes=fs.readFileSync(safeFixturePath(entry.id));sha256=sha256Hex(bytes)}
  else{
   const {stream}=await strictRequest(entry.url,{token,maxBytes:limit,timeoutMs:FILE_TIMEOUT_MS,transport});
   ({bytes,sha256}=await readCapped(stream,{maxBytes:limit,timeoutMs:FILE_TIMEOUT_MS}));
  }
  if(bytes.length!==entry.size)return {status:'failed',error:'下载文件大小与清单不一致，未导入'};
  if(entry.sha256&&sha256!==entry.sha256)return {status:'failed',error:'下载文件校验值与清单不一致，未导入'};
  if(remembered?.sha256===sha256)return {status:'duplicate'};
  let result;
  try{result=await importFile({name:entry.name,bytes,mtime:entry.mtime,source:{connectorId:s.id,connectorKind:s.kind,connectorName:s.name,simulated:!!s.simulated,deviceId:device?.id||'',deviceName:device?.name||'',deviceModel:device?.model||'',fileId:entry.id}})}
  catch(e){return {status:'failed',error:san(s.id,String(e?.message||'导入失败'))}}
  if(result&&typeof result==='object'){
   s.imported??={};s.imported[entry.id]={sha256,importedAt:nowIso()};
   return {status:result.duplicate===true?'duplicate':'imported'};
  }
  return {status:'imported'}; // importFile 返回非对象时不记录哈希，下次由服务端内容去重兜底
 }

 async function test(id){
  const s=findSource(id);guardBusy(id,'test');
  try{
   if(s.kind==='simulator'){
    let count=0;
    try{count=buildSimManifest().files.length}
    catch(e){const msg=`演示数据不可用：${e.message}`;markStatus(s,'error',msg);saveDoc();return {sourceId:id,status:'error',simulated:true,capabilities:[...s.capabilities],error:msg}}
    markStatus(s,'reachable','');saveDoc();
    return {sourceId:id,status:'reachable',simulated:true,capabilities:[...s.capabilities],device:{id:'sim-demo',name:'演示录音设备',model:'模拟器 · 非真实设备'},fileCount:count};
   }
   try{
    const m=await fetchManifest(s.manifestUrl,{token:tokens.get(id)||'',transport});
    markStatus(s,'reachable','');saveDoc();
    return {sourceId:id,status:'reachable',simulated:false,capabilities:[...s.capabilities],device:m.device,fileCount:m.files.length};
   }catch(e){
    const status=mapStatus(e),msg=san(id,e.message);
    markStatus(s,status,msg);saveDoc();
    return {sourceId:id,status,simulated:false,capabilities:[...s.capabilities],error:msg};
   }
  }finally{busy.delete(id)}
 }

 async function sync(id){
  const s=findSource(id);guardBusy(id,'sync');
  try{
   const token=tokens.get(id)||'';
   let entries=[],device={id:'',name:'',model:''},simulated=!!s.simulated,notice='';
   if(s.kind==='simulator'){
    try{const m=buildSimManifest();device=m.device;entries=m.files.map(f=>({ok:true,file:f}))}
    catch(e){
     const msg=san(id,`演示数据不可用：${e.message}`);
     markStatus(s,'error',msg);s.lastSyncAt=nowIso();saveDoc();
     return {sourceId:id,simulated,discovered:0,imported:0,duplicates:0,failed:0,files:[],error:msg};
    }
   }else{
    try{const m=await fetchManifest(s.manifestUrl,{token,transport});device=m.device;entries=m.files;if(m.truncated)notice=`清单包含大量文件，本次仅处理前 ${MAX_MANIFEST_FILES} 个`}
    catch(e){
     const msg=san(id,e.message);
     markStatus(s,mapStatus(e),msg);s.lastSyncAt=nowIso();saveDoc();
     return {sourceId:id,simulated:false,discovered:0,imported:0,duplicates:0,failed:0,files:[],error:msg};
    }
   }
   const files=[];let imported=0,duplicates=0,failed=0;
   for(const entry of entries){
    if(entry.ok===false){failed++;files.push({id:entry.id||'',name:entry.name||'（未命名）',status:'failed',error:san(id,entry.error)});continue}
    const f=entry.file;
    try{
     const out=await importOne(s,f,{token,transport,device});
     files.push({id:f.id,name:f.name,status:out.status,...(out.error?{error:san(id,out.error)}:{})});
     if(out.status==='imported')imported++;else if(out.status==='duplicate')duplicates++;else failed++;
    }catch(e){failed++;files.push({id:f.id,name:f.name,status:'failed',error:san(id,e.message)})}
   }
   markStatus(s,entries.length&&failed===entries.length?'error':'reachable',failed?`${failed} 个文件未能导入，其余已处理`:'');
   s.lastSyncAt=nowIso();saveDoc();
   const result={sourceId:id,simulated,discovered:entries.length,imported,duplicates,failed,files};
   if(notice)result.notice=notice;else if(!entries.length)result.notice='来源清单暂无文件';
   return result;
  }finally{busy.delete(id)}
 }

 return {list,add,remove,test,sync};
}
