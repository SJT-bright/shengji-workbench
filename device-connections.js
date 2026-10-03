/* 设备连接（XF-20260927-B）：独立 UI 模块，对应 verification/xunfei-connector-20260927/contract.md。
   集成方（main.js）注入 api（与 data.js 的 api 同签名）与 toast：
     import {createDeviceConnections} from './device-connections.js';
     import './device-connections.css';
     const deviceConnections=createDeviceConnections({api,toast});
     // 渲染循环中：容器.innerHTML=deviceConnections.render(); deviceConnections.bind(容器);
     // 数据变化或本页轮询时：await deviceConnections.refresh();
   本文件不 import 任何模块（含 CSS），可在 node --test 中直接加载做单元测试。
   服务端接口由 C 按 contract.md 实现：GET/POST /api/connectors、POST /api/connectors/:id/test|sync、DELETE /api/connectors/:id。
   诚实边界：演示设备是内置夹具的模拟来源；远程来源只对接用户自建的兼容 HTTPS manifest 网关。
   声迹不能也不声称已连接讯飞官方云或厂商私有云。 */

const KINDS={
  'simulator':{label:'演示设备',badge:'演示设备',desc:'内置演示夹具（「演示录音」），无需任何设备。'},
  'remote-manifest':{label:'远程 manifest 来源',badge:'远程 manifest',desc:'连接你自建的兼容 HTTPS manifest 网关。'}
};
const STATUS_LABELS={configured:'已配置',reachable:'可连接',unsupported:'不支持此来源',error:'出错'};
const FILE_STATUS={imported:'已导入',duplicate:'重复，已跳过',failed:'失败',discovered:'已发现',pending:'等待导入'};
const FILE_RENDER_LIMIT=30;

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const redact=(text,secrets)=>{let out=String(text??'');for(const s of secrets)if(typeof s==='string'&&s.length>3)out=out.split(s).join('***');return out};

/* ---------- 纯函数（导出供测试与集成方复用） ---------- */

export function validateManifestUrl(raw){
  if(typeof raw!=='string'||!raw.trim())return '请填写 manifest 地址';
  if(raw.trim().length>2048)return 'manifest 地址过长';
  let url;try{url=new URL(raw.trim())}catch{return 'manifest 地址格式无效，请填写完整 HTTPS 地址'}
  if(url.protocol!=='https:')return '只允许 HTTPS 地址，请改用 https:// 开头的网关地址';
  if(url.username||url.password)return '不要把账号密码写进地址，请改用「访问令牌」';
  const host=url.hostname.toLowerCase().replace(/\.$/,'').replace(/^\[|\]$/g,'');
  if(!host)return 'manifest 地址缺少主机名';
  if(host==='localhost'||host.endsWith('.localhost'))return '不允许本机与环回地址：请填写公网网关地址';
  if(/\.(local|internal|test|example|invalid|home\.arpa)$/.test(host))return `「${host}」是保留主机名，公网无法访问，请填写真实网关地址`;
  if(host.includes(':')){
    if(isPrivateIPv6(host))return '不允许内网与保留 IPv6 地址：请填写公网网关地址';
  }else{
    const v4=host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if(v4){
      const octets=v4.slice(1).map(Number);
      if(octets.some(n=>n>255))return 'IPv4 地址无效';
      if(isPrivateIPv4(octets))return '不允许本机、内网与保留 IPv4 地址：请填写公网网关地址';
    }
  }
  return '';
}
function isPrivateIPv4([a,b,c]){
  if(a===0||a===10||a===127||a>=224)return true;
  if(a===100&&b>=64&&b<=127)return true;
  if(a===169&&b===254)return true;
  if(a===172&&b>=16&&b<=31)return true;
  if(a===192&&(b===0||b===168))return true;
  if(a===198&&(b===18||b===19||(b===51&&c===100)))return true;
  if(a===203&&b===0&&c===113)return true;
  return false;
}
function isPrivateIPv6(h){
  const low=h.toLowerCase();
  if(low==='::1'||low==='::'||low==='0:0:0:0:0:0:0:1')return true;
  // URL 解析会把 ::ffff:a.b.c.d 归一化为十六进制（如 ::ffff:c0a8:101），两种形态都要识别
  const dotted=low.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if(dotted)return isPrivateIPv4(dotted[1].split('.').map(Number));
  const hexMapped=low.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if(hexMapped){
    const v=(parseInt(hexMapped[1],16)<<16)|parseInt(hexMapped[2],16);
    return isPrivateIPv4([(v>>>24)&255,(v>>>16)&255,(v>>>8)&255,v&255]);
  }
  if(/^fe[89ab]/.test(low))return true;
  if(/^f[cd]/.test(low))return true;
  return false;
}

export function normalizeSourceList(data){
  const list=Array.isArray(data)?data:Array.isArray(data?.sources)?data.sources:Array.isArray(data?.list)?data.list:[];
  return list.filter(s=>s&&typeof s==='object').map((s,i)=>({
    id:String(s.id??`source-${i}`),
    name:String(s.name??'未命名来源'),
    kind:s.kind==='simulator'||s.kind==='remote-manifest'?s.kind:String(s.kind||'unknown'),
    status:String(s.status||'configured'),
    lastSyncAt:typeof s.lastSyncAt==='string'||s.lastSyncAt instanceof Date?s.lastSyncAt:'',
    lastError:s.lastError?String(s.lastError):'',
    capabilities:normalizeCapabilities(s.capabilities),
    simulated:s.simulated===true||s.kind==='simulator',
    manifestUrl:typeof s.manifestUrl==='string'?s.manifestUrl:''
  }));
}
export function normalizeCapabilities(caps){
  if(Array.isArray(caps))return caps.map(c=>typeof c==='string'?c.trim():(c&&typeof c==='object'?String(c.name||c.label||c.id||''):'')).filter(Boolean);
  if(caps&&typeof caps==='object')return Object.entries(caps).filter(([,v])=>v===true||(typeof v==='string'&&v)).map(([k,v])=>v===true?k:`${k}: ${v}`);
  if(typeof caps==='string'&&caps.trim())return [caps.trim()];
  return [];
}
export function formatTime(v,fallback='从未同步'){
  if(!v)return fallback;
  const d=v instanceof Date?v:new Date(v);
  if(Number.isNaN(d.getTime()))return String(v);
  const now=new Date();
  const hm=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  if(d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate())return `今天 ${hm}`;
  return `${d.getMonth()+1}月${d.getDate()}日 ${hm}`;
}

/* ---------- 组件 ---------- */

export function createDeviceConnections({api,toast}){
  if(typeof api!=='function')throw new Error('createDeviceConnections 需要注入 api（与 data.js 的 api 同签名）');
  const notify=typeof toast==='function'?toast:()=>{};
  const owner=Symbol('device-connections');

  let sources=null,loaded=false,loadError='';
  let formOpen=false,formKind='simulator',formError='',formBusy=false;
  const draft={name:'',manifestUrl:'',bearerToken:''};
  let lastFocusedField='';
  const busy=Object.create(null);
  const testResults=new Map();
  const syncResults=new Map();
  const tokenMemo=new Map();
  let root=null;

  function render(){
    const parts=[`<section class="device-connections" aria-label="设备连接">`];
    parts.push(`<header class="dc-head"><div class="dc-head-copy"><h2>设备连接</h2><p>把录音笔或自建网关里的文件同步进声迹。当前声迹尚未连接任何讯飞官方云服务。</p></div><button type="button" class="dc-btn dc-btn-primary" data-dc-action="open-form"${formOpen?' hidden':''}>${ICONS.plus}<span>添加连接来源</span></button></header>`);
    if(formOpen)parts.push(addForm());
    parts.push(explainerCard());
    if(loadError)parts.push(`<div class="dc-banner dc-banner-error" role="alert"><strong>设备连接接口暂不可用。</strong><span>${esc(loadError)}</span><span class="dc-banner-note">请确认本地服务已更新到包含 /api/connectors 的版本并重启声迹；已导入的记录不受影响。</span></div>`);
    if(!loaded)parts.push(`<div class="dc-loading" role="status">正在读取连接来源……</div>`);
    else if(!sources.length&&!loadError)parts.push(emptyState());
    else if(sources.length)parts.push(`<div class="dc-source-list">${sources.map(sourceCard).join('')}</div>`);
    parts.push(`</section>`);
    return parts.join('');
  }

  function bind(nextRoot){
    if(!nextRoot)return;
    if(nextRoot.__dcBound!==owner){
      nextRoot.__dcBound=owner;
      nextRoot.addEventListener('click',onRootClick);
      nextRoot.addEventListener('input',onRootInput);
      nextRoot.addEventListener('submit',onRootSubmit);
    }
    root=nextRoot;
    restoreDraft(nextRoot);
  }

  async function refresh(){
    try{
      sources=normalizeSourceList(await api('connectors'));
      loadError='';loaded=true;
    }catch(e){
      loadError=String(e?.message||e);loaded=true;
      if(!Array.isArray(sources))sources=[];
    }
    rerender();
    return sources;
  }

  function rerender(){
    if(!root||!root.isConnected)return;
    root.innerHTML=render();
    bind(root);
    if(lastFocusedField){
      const input=root.querySelector(`[data-dc-field="${lastFocusedField}"]`);
      if(input){input.focus();try{input.setSelectionRange(input.value.length,input.value.length)}catch{}}
    }
  }

  function onRootClick(e){
    const button=e.target.closest?.('[data-dc-action]');
    if(!button||button.disabled)return;
    const {dcAction:action,dcId:id,dcKind:kind}=button.dataset;
    if(action==='open-form'){formOpen=true;formError='';rerender()}
    else if(action==='close-form'){formOpen=false;formError='';rerender()}
    else if(action==='pick-kind'){if(formBusy)return;formKind=kind;formError='';rerender()}
    else if(id&&(action==='test'||action==='sync'||action==='remove'))runSourceAction(id,action).catch(()=>{});
  }
  function onRootInput(e){
    const field=e.target.closest?.('[data-dc-field]');
    if(!field)return;
    draft[field.dataset.dcField]=field.value;
    lastFocusedField=field.dataset.dcField;
  }
  function onRootSubmit(e){
    if(e.target.id!=='dc-add-form')return;
    e.preventDefault();
    addSource().catch(()=>{});
  }

  async function addSource(){
    if(formBusy)return;
    const kind=formKind;
    const name=draft.name.trim().slice(0,60);
    let manifestUrl='',token='';
    if(kind==='remote-manifest'){
      manifestUrl=draft.manifestUrl.trim();
      const problem=validateManifestUrl(manifestUrl);
      if(problem){formError=problem;notify(problem);rerender();return}
      token=draft.bearerToken.trim();
    }
    formBusy=true;formError='';rerender();
    try{
      const body=kind==='remote-manifest'
        ?{kind,name:name||'远程 manifest 来源',manifestUrl,...(token?{bearerToken:token}:{})}
        :{kind,name:name||'演示设备'};
      const created=await api('connectors',{method:'POST',body});
      if(token){
        const src=Array.isArray(created)?created[0]:created?.source||created;
        if(src?.id)tokenMemo.set(String(src.id),token);
      }
      formOpen=false;formError='';
      draft.name='';draft.manifestUrl='';draft.bearerToken='';lastFocusedField='';
      formBusy=false;
      await refresh();
      notify(`已添加来源「${body.name}」，先「测试连接」再同步`);
    }catch(e){
      formBusy=false;
      formError=redact(e?.message||String(e),[token]);
      notify(`添加来源失败：${formError}`);
      rerender();
    }
  }

  async function runSourceAction(id,action){
    if(busy[id])return;
    const source=(sources||[]).find(s=>s.id===id);
    if(!source)return;
    if(action==='remove'){
      const ok=window.confirm(`移除「${source.name}」的连接配置？\n\n只会移除连接配置本身；这个来源已导入的记录与音频会完整保留，不会被删除。`);
      if(!ok)return;
    }
    busy[id]=action;rerender();
    try{
      if(action==='test'){
        const result=await api(`connectors/${encodeURIComponent(id)}/test`,{method:'POST',body:{}});
        testResults.set(id,{...normalizeTestResult(result),at:new Date().toISOString()});
        const label={reachable:'连接测试通过：来源可用',configured:'连接测试完成：来源已配置',unsupported:'连接测试：此来源不受支持',error:'连接测试失败'}[result?.status]||'连接测试完成';
        notify(result?.status==='error'&&result?.error?`${label}：${redact(result.error,[tokenMemo.get(id)])}`:label);
      }else if(action==='sync'){
        const result=await api(`connectors/${encodeURIComponent(id)}/sync`,{method:'POST',body:{}});
        syncResults.set(id,{...normalizeSyncResult(result),at:new Date().toISOString()});
        notify(result?.failed?`同步完成，但有 ${result.failed} 个文件失败，详情见来源卡片`:`同步完成：新导入 ${Number(result?.imported)||0} 个文件`);
      }else if(action==='remove'){
        await api(`connectors/${encodeURIComponent(id)}`,{method:'DELETE'});
        testResults.delete(id);syncResults.delete(id);tokenMemo.delete(id);
        notify(`已移除「${source.name}」的连接配置；已导入的记录保留`);
      }
    }catch(e){
      const message=redact(e?.message||String(e),[tokenMemo.get(id)]);
      if(action==='test')testResults.set(id,{status:'error',simulated:source.simulated,capabilities:[],error:message,at:new Date().toISOString(),failed:true});
      if(action==='sync')syncResults.set(id,{simulated:source.simulated,discovered:0,imported:0,duplicates:0,failed:0,files:[],error:message,at:new Date().toISOString(),failed:true});
      notify(`${{test:'连接测试',sync:'同步',remove:'移除配置'}[action]}失败：${message}`);
    }finally{
      delete busy[id];
      await refresh();
    }
  }

  function normalizeTestResult(r){
    return {status:String(r?.status||'error'),simulated:r?.simulated===true,capabilities:normalizeCapabilities(r?.capabilities),error:r?.error?String(r.error):''};
  }
  function normalizeSyncResult(r){
    const files=Array.isArray(r?.files)?r.files.filter(f=>f&&typeof f==='object').map(f=>({id:String(f?.id??''),name:String(f?.name??''),status:String(f?.status||''),error:f?.error?String(f.error):''})):[];
    return {simulated:r?.simulated===true,discovered:Number(r?.discovered)||0,imported:Number(r?.imported)||0,duplicates:Number(r?.duplicates)||0,failed:Number(r?.failed)||0,files};
  }

  /* ---------- 渲染片段 ---------- */

  const ICONS={
    plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    sync:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>',
    trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>'
  };

  function explainerCard(){
    return `<div class="dc-explainer"><div class="dc-kind-intro-row">
      <div class="dc-kind-intro"><span class="dc-kind-badge dc-kind-badge--simulator">演示设备</span><p>内置演示夹具（「演示录音」），用来在没有录音笔时体验连接、测试与同步的完整流程。</p></div>
      <div class="dc-kind-intro"><span class="dc-kind-badge dc-kind-badge--remote">远程 manifest</span><p>连接<strong>你自己的</strong>兼容 HTTPS manifest 网关（v1 JSON：设备信息＋文件清单）。声迹不提供网关，也不会代你登录任何厂商账号。</p></div>
    </div><p class="dc-honesty">声迹当前不能、也不声称已连接讯飞官方云或厂商私有云；此页面只对接内置演示设备与你自建的兼容来源。演示设备的全部结果都是模拟数据。</p></div>`;
  }
  function emptyState(){
    return `<div class="dc-empty"><h3>还没有连接来源</h3><p>先添加「演示设备」看看同步怎么运作；有自建网关时，再添加远程 manifest 来源。</p><button type="button" class="dc-btn dc-btn-primary" data-dc-action="open-form">${ICONS.plus}<span>添加连接来源</span></button></div>`;
  }
  function addForm(){
    const remote=formKind==='remote-manifest';
    return `<form id="dc-add-form" class="dc-add-form" novalidate>
      <div class="dc-form-head"><h3>添加连接来源</h3><button type="button" class="dc-btn dc-btn-ghost" data-dc-action="close-form">关闭</button></div>
      <div class="dc-kind-options" role="radiogroup" aria-label="来源类型">${['simulator','remote-manifest'].map(k=>`<button type="button" class="dc-kind-option${formKind===k?' active':''}" role="radio" aria-checked="${formKind===k}" data-dc-action="pick-kind" data-dc-kind="${k}" ${formBusy?'disabled':''}><strong>${KINDS[k].label}</strong><span>${KINDS[k].desc}</span></button>`).join('')}</div>
      ${remote?`<div class="dc-field"><label for="dc-manifest-url">manifest 地址（HTTPS）</label><input id="dc-manifest-url" data-dc-field="manifestUrl" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://your-gateway.example.com/manifest.json"><small>网关需返回 v1 manifest（<code>{"version":1,"device":{…},"files":[…]}</code>），文件 URL 必须为 HTTPS。只做只读下载；本机、内网地址与重定向到非 HTTPS 会被服务端拒绝。</small></div>
      <div class="dc-field"><label for="dc-token">访问令牌（可选）</label><input id="dc-token" data-dc-field="bearerToken" type="password" autocomplete="new-password" placeholder="仅当你的网关需要鉴权时填写"><small>令牌只用于这个来源（Bearer），仅保存在本机内存，不会写入备份或日志；重启应用后需要重新输入。</small></div>`:''}
      <div class="dc-field"><label for="dc-name">名称</label><input id="dc-name" data-dc-field="name" maxlength="60" placeholder="${remote?'如：我的录音笔网关':'演示设备'}"></div>
      ${formError?`<p class="dc-form-error" role="alert">${esc(formError)}</p>`:''}
      <div class="dc-form-foot"><button type="submit" class="dc-btn dc-btn-primary" ${formBusy?'disabled aria-busy="true"':''}>${formBusy?'<span class="dc-spin" aria-hidden="true"></span><span>添加中…</span>':`${ICONS.plus}<span>添加来源</span>`}</button>
      <p class="dc-form-note">${remote?'只接受 HTTPS 公网地址；本机、局域网与保留地址会被拒绝。':'演示设备来自内置夹具，添加后即可测试与同步。'}</p></div>
    </form>`;
  }
  function capsTags(caps){
    const list=normalizeCapabilities(caps);
    return list.length?`<div class="dc-caps">${list.map(c=>`<span class="dc-cap">${esc(c)}</span>`).join('')}</div>`:'';
  }
  function sourceHint(s,testR,syncR){
    if(busy[s.id])return '';
    if(testR?.failed||syncR?.failed)return '刚才的操作没有完成，可以直接重试；已导入的记录不受影响。';
    if(testR){
      if(testR.status==='reachable')return syncR?(syncR.imported?`上次同步导入 ${syncR.imported} 个文件${syncR.duplicates?`、跳过重复 ${syncR.duplicates} 个`:''}；可随时再次手动同步获取新文件。`:'来源可用；点「手动同步」拉取文件。'):'连接正常，可以「手动同步」。';
      if(testR.status==='unsupported')return '该地址没有返回符合契约的 manifest（v1）。请核对你的网关实现，或先用演示设备体验流程。';
      if(testR.status==='error')return `连接失败：${testR.error}。修正后可重试。`;
      if(testR.status==='configured')return '来源已保存；点「测试连接」验证它是否可用。';
    }
    if(s.status==='unsupported')return '此来源当前不可用：网关未返回支持的 manifest。';
    if(s.status==='reachable')return '来源可用；点「手动同步」拉取文件。';
    if(s.lastSyncAt)return '已同步过，可随时再次手动同步。';
    return '先「测试连接」确认来源可用，再「手动同步」。';
  }
  function actionButton(id,action,b,label,busyLabel,icon,extraClass=''){
    return `<button type="button" class="dc-btn ${extraClass}" data-dc-action="${action}" data-dc-id="${esc(id)}"${b?' disabled':''}${b===action?' aria-busy="true"':''}>${b===action?`<span class="dc-spin" aria-hidden="true"></span><span>${busyLabel}</span>`:`${icon}<span>${label}</span>`}</button>`;
  }
  function sourceCard(s){
    const b=busy[s.id];
    const kindMeta=KINDS[s.kind];
    const badgeCls=s.kind==='simulator'?'dc-kind-badge--simulator':s.kind==='remote-manifest'?'dc-kind-badge--remote':'dc-kind-badge--other';
    const statusCls=STATUS_LABELS[s.status]?s.status:'unknown';
    const statusLabel=STATUS_LABELS[s.status]||(s.status||'未知状态');
    const testR=testResults.get(s.id),syncR=syncResults.get(s.id);
    const hint=sourceHint(s,testR,syncR);
    return `<article class="dc-card ${s.kind==='simulator'?'dc-card--simulator':s.kind==='remote-manifest'?'dc-card--remote':'dc-card--other'}" data-dc-id="${esc(s.id)}">
      <header class="dc-card-head"><div class="dc-card-title"><span class="dc-kind-badge ${badgeCls}">${esc(kindMeta?kindMeta.badge:(s.kind==='unknown'?'未知类型':s.kind))}</span>${s.simulated?'<span class="dc-simulated-flag">模拟</span>':''}<h3 class="dc-name">${esc(s.name)}</h3></div><span class="dc-status dc-status--${esc(statusCls)}">${esc(statusLabel)}</span></header>
      ${s.kind==='remote-manifest'&&s.manifestUrl?`<p class="dc-meta">网关地址：<span class="dc-url">${esc(s.manifestUrl)}</span></p>`:''}
      ${s.kind==='simulator'?`<p class="dc-meta">数据来自内置演示夹具（演示录音），不是真实设备录音。</p>`:''}
      ${s.lastError?`<p class="dc-error" role="alert">最近错误：${esc(redact(s.lastError,[tokenMemo.get(s.id)]))}</p>`:''}
      <p class="dc-meta dc-meta-line">最近同步：${esc(formatTime(s.lastSyncAt))}</p>
      ${capsTags(s.capabilities)}
      ${hint?`<p class="dc-hint">${esc(hint)}</p>`:''}
      <div class="dc-actions" role="group" aria-label="${esc(s.name)} 的操作">
        ${actionButton(s.id,'test',b,'测试连接','测试中…',ICONS.check)}
        ${actionButton(s.id,'sync',b,'手动同步','同步中…',ICONS.sync)}
        <button type="button" class="dc-btn dc-btn-danger" data-dc-action="remove" data-dc-id="${esc(s.id)}"${b?' disabled':''} title="只移除连接配置，已导入的记录会保留">${b==='remove'?'<span class="dc-spin" aria-hidden="true"></span><span>移除中…</span>':`${ICONS.trash}<span>移除配置</span>`}</button>
      </div>
      ${testR?testResultBlock(testR):''}
      ${syncR?syncResultBlock(syncR):''}
    </article>`;
  }
  function testResultBlock(r){
    const label=STATUS_LABELS[r.status]||r.status;
    return `<div class="dc-result dc-result--test${r.status==='error'||r.failed?' dc-result--error':''}" role="status"><h4>最近测试${r.simulated?' <span class="dc-simulated-flag">模拟</span>':''}<small>${esc(formatTime(r.at,''))}</small></h4><p><strong>${esc(label)}</strong>${r.error?`<span>：${esc(r.error)}</span>`:''}</p>${capsTags(r.capabilities)}</div>`;
  }
  function syncResultBlock(r){
    const files=Array.isArray(r.files)?r.files:[];
    const shown=files.slice(0,FILE_RENDER_LIMIT);
    return `<div class="dc-result dc-result--sync${r.failed?' dc-result--error':''}" role="status"><h4>最近同步${r.simulated?' <span class="dc-simulated-flag">模拟</span>':''}<small>${esc(formatTime(r.at,''))}</small></h4>
      <p class="dc-sync-counts">发现 ${r.discovered} · 新导入 ${r.imported} · 重复跳过 ${r.duplicates} · 失败 ${r.failed}</p>
      ${r.error?`<p class="dc-error" role="alert">${esc(r.error)}</p>`:''}
      ${shown.length?`<ul class="dc-file-list">${shown.map(f=>`<li class="dc-file dc-file--${esc(f.status||'unknown')}"><span class="dc-file-name">${esc(f.name||f.id||'未命名文件')}</span><span class="dc-file-status">${esc(FILE_STATUS[f.status]||f.status||'已处理')}</span>${f.error?`<span class="dc-file-error">${esc(f.error)}</span>`:''}</li>`).join('')}</ul>${files.length>FILE_RENDER_LIMIT?`<p class="dc-form-note">其余 ${files.length-FILE_RENDER_LIMIT} 个文件已略。</p>`:''}`:''}
      ${r.imported?`<p class="dc-form-note">已导入的文件进入正常的转写与整理队列，可在「处理队列」查看进度；同步失败不会删除已导入的记录。</p>`:''}
    </div>`;
  }

  function restoreDraft(el){
    const map={name:'dc-name',manifestUrl:'dc-manifest-url',bearerToken:'dc-token'};
    for(const [field,id] of Object.entries(map)){
      const input=el.querySelector('#'+id);
      if(input)input.value=draft[field];
    }
  }

  return {render,bind,refresh};
}
