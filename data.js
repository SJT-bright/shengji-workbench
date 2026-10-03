import {categories as defaults,parseTranscript} from './shared.mjs';
export {parseTranscript};
export let categories=defaults;
let cache={records:[],settings:{},revision:0,watch:{}};
let token=window.__SHENGJI_TOKEN||'';
export async function api(endpoint,{method='GET',body,signal}={},retry=true){
 if(!token){const response=await fetch('/api/session');if(!response.ok)throw new Error('本地服务未连接，请打开声迹 App');token=(await response.json()).token}
 let response;
 try{response=await fetch('/api/'+endpoint,{method,signal,headers:{'X-Shengji-Token':token,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})})}catch{throw new Error('本地服务已断开，请重新打开声迹 App')}
 const result=await response.json().catch(()=>({}));
 if(!response.ok){
  /* 服务重启会轮换会话令牌：401 时重取令牌并把当前请求重放一次 */
  if(response.status===401&&retry){token='';return api(endpoint,{method,body,signal},false)}
  const err=new Error(result.error||'操作失败');err.status=response.status;throw err
 }
 return result;
}
export async function initData(){await syncData();const legacy=localStorage.getItem('voice-workbench.records.v1');if(legacy&&!cache.records.length&&!localStorage.getItem('shengji.migrated.v2')){let records;try{records=JSON.parse(legacy)}catch{throw new Error('旧版浏览器数据格式异常，已保留。请手动备份后恢复')}
 if(records.length){await api('migrate',{method:'POST',body:{version:1,records,exportedAt:new Date().toISOString()}});await syncData()}
 localStorage.setItem('shengji.migrated.v2','true');}return cache;
}
export async function syncData(){cache=await api('state');categories=cache.categories||defaults;return cache}
export const getRecords=()=>structuredClone(cache.records);
export const getState=()=>structuredClone(cache);
export async function saveRecord(record){const result=await api('records',{method:'PUT',body:record});await syncData();return result}
export async function deleteRecord(id){await api('records',{method:'DELETE',body:{id}});await syncData()}
export async function importRecord(record){const result=await api('import',{method:'POST',body:record});await syncData();return result}
export async function exportData(){return api('backup')}
export async function importBackup(input){const backup=typeof input==='string'?JSON.parse(input):input;const result=await api('restore',{method:'POST',body:backup});await syncData();return result}

export async function audioURL(id){
 if(!token)await api('state');
 const response=await fetch('/api/audio/'+encodeURIComponent(id),{headers:{'X-Shengji-Token':token}});
 if(!response.ok)throw new Error((await response.json()).error||'音频读取失败');return URL.createObjectURL(await response.blob());
}
