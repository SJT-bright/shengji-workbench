// 声迹 · 连接器服务端路由（XF-20260927-C，契约：verification/xunfei-connector-20260927/contract.md）
// 独立路由层：仅处理 /api/connectors 空间的五个契约端点；返回 true 表示本层已响应，false 表示非本层路由（调用方继续处理）。
// 鉴权不在本层：整合者应在 server.mjs 完成 session token 与 Host/Origin 校验之后再调用本函数，例如在
// x-shengji-token 校验行之后插入 `if(await handleConnectorApi(req,res,{service:connectorService,readBody,json}))return;`。
// service 来自 connectors/index.mjs 的 createConnectorService({dataDir,importFile})，由调用方注入；本层不读写文件、不持久化配置。
const BASE='/api/connectors';
const MISSING_SOURCE=/来源不存在或已移除/;
const SECRET_MASK='〔已隐藏〕';
// 本进程见过的访问令牌（仅内存、上限 64、先进先出），用于兜底过滤错误消息中的明文令牌。
// 正常脱敏由 service 层负责（长度不足 8 的令牌 service 不保证过滤），这里保证任何意外回显路径不会把令牌带进响应。
const recentSecrets=new Set();
function rememberSecrets(list){
 for(const s of list){recentSecrets.add(s);if(recentSecrets.size>64)recentSecrets.delete(recentSecrets.values().next().value)}
}
function redact(text){
 let out=String(text??'');
 for(const s of recentSecrets)if(out.includes(s))out=out.split(s).join(SECRET_MASK);
 return out.slice(0,700);
}
async function readJsonBody(req,readBody){
 let input;
 try{input=await readBody(req)}catch(e){throw new Error(/json/i.test(String(e?.message))?'请求不是有效的 JSON 数据':String(e?.message||'请求内容无效'))}
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('请求格式无效：应为 JSON 对象');
 return input;
}
export async function handleConnectorApi(req,res,{service,readBody,json}={}){
 const p=new URL(req.url,'http://127.0.0.1').pathname;
 if(p!==BASE&&!p.startsWith(`${BASE}/`))return false;
 if(!service||typeof service.list!=='function'||typeof service.add!=='function'||typeof service.remove!=='function'||typeof service.test!=='function'||typeof service.sync!=='function'||typeof readBody!=='function'||typeof json!=='function')
  throw new Error('连接器路由依赖注入不完整：需要 createConnectorService 返回的 service，以及 server 现有的 readBody 与 json');
 try{
  if(p===BASE){
   if(req.method==='GET'){json(res,200,{sources:await service.list()});return true}
   if(req.method==='POST'){
    const input=await readJsonBody(req,readBody);
    if(typeof input.bearerToken==='string'&&input.bearerToken.length>=8)rememberSecrets([input.bearerToken]);
    json(res,200,await service.add(input));return true;
   }
   json(res,405,{error:'方法不支持：查看来源用 GET，新建来源用 POST'});return true;
  }
  const parts=p.slice(BASE.length+1).split('/').map(seg=>{try{return decodeURIComponent(seg)}catch{return seg}});
  if(parts.length===1&&parts[0]){
   if(req.method!=='DELETE'){json(res,405,{error:'方法不支持：移除来源配置请使用 DELETE（已导入记录不会删除）'});return true}
   json(res,200,await service.remove(parts[0]));return true;
  }
  if(parts.length===2&&parts[0]&&(parts[1]==='test'||parts[1]==='sync')){
   if(req.method!=='POST'){json(res,405,{error:`方法不支持：来源${parts[1]==='test'?'连接测试':'同步'}请使用 POST`});return true}
   // 连接测试/同步的业务失败（断线、不支持此来源等）按契约在 200 响应体内以 status/files[].error 表达
   json(res,200,parts[1]==='test'?await service.test(parts[0]):await service.sync(parts[0]));return true;
  }
  json(res,404,{error:'接口不存在'});return true;
 }catch(e){
  const message=redact(e?.message||'操作失败');
  json(res,MISSING_SOURCE.test(message)?404:400,{error:message});return true;
 }
}
