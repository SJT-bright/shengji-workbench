/* 设备连接模块测试（XF-20260927-B）。
   运行：node --test tests/device-connections.test.mjs
   单元部分直接 import 模块；浏览器部分用 Playwright 库 API + 空白页面注入模块与假 api，
   不依赖 server.mjs 的 /api/connectors（C 未实现也能跑）。 */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {createDeviceConnections,validateManifestUrl,normalizeSourceList,normalizeCapabilities,formatTime} from '../device-connections.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const moduleCode=fs.readFileSync(path.join(here,'..','device-connections.js'),'utf8');
const cssCode=fs.readFileSync(path.join(here,'..','device-connections.css'),'utf8');

/* ---------- 单元：manifest URL 校验 ---------- */
test('manifest URL 校验：放行 HTTPS 公网地址',()=>{
  for(const url of ['https://example.com/manifest.json','https://GW.Example.CN:8443/m.json','https://example.com./m.json','https://8.8.8.8/m.json','https://1.1.1.1:9443/m','https://[2606:4700::1111]/m.json','https://93.184.216.34/m']){
    assert.equal(validateManifestUrl(url),'',`应放行 ${url}`);
  }
});
test('manifest URL 校验：拒绝非 HTTPS、凭证与本机/内网/保留地址',()=>{
  const cases=[
    ['','请填写'],
    ['   ','请填写'],
    ['notaurl','格式无效'],
    ['http://example.com/manifest.json','只允许 HTTPS'],
    ['ftp://example.com/m.json','只允许 HTTPS'],
    ['https://user:pass@example.com/m.json','账号密码'],
    ['https://localhost/m.json','本机'],
    ['https://LOCALHOST./m.json','本机'],
    ['https://127.0.0.1/manifest.json','内网'],
    ['https://10.1.2.3/m.json','内网'],
    ['https://172.16.1.1/m.json','内网'],
    ['https://192.168.1.1/manifest.json','内网'],
    ['https://169.254.3.4/m.json','内网'],
    ['https://100.100.1.2/m.json','内网'],
    ['https://0.0.0.0/m.json','内网'],
    ['https://224.0.0.1/m.json','内网'],
    ['https://[::1]/m.json','内网'],
    ['https://[::]/m.json','内网'],
    ['https://[fe80::1]/m.json','内网'],
    ['https://[fdab::15]/m.json','内网'],
    ['https://[::ffff:192.168.1.1]/m.json','内网'],
    ['https://nas.internal/m.json','保留主机名'],
    ['https://printer.local/m.json','保留主机名'],
    ['https://demo.test/m.json','保留主机名'],
    ['https://box.home.arpa/m.json','保留主机名'],
    ['https://256.1.1.1/m.json','无效']
  ];
  for(const [url,needle] of cases){
    const problem=validateManifestUrl(url);
    assert.ok(problem.includes(needle),`${url} 应被拒绝且提示包含「${needle}」，实际：${problem}`);
  }
});

/* ---------- 单元：来源列表归一化 ---------- */
test('来源列表归一化：兼容数组与 {sources}/{list} 包裹、过滤脏数据',()=>{
  const raw={sources:[
    {id:'a',name:'演示设备',kind:'simulator',status:'reachable',lastSyncAt:'2026-09-27T10:00:00Z',capabilities:['files.list']},
    {id:'b',name:'网关',kind:'remote-manifest',status:'configured',manifestUrl:'https://gw.example.com/m.json',simulated:false},
    {id:'c',name:'未来适配器',kind:'iflytek-adapter'},
    null,'junk',{name:'缺 id'}
  ]};
  const list=normalizeSourceList(raw);
  assert.equal(list.length,4);
  assert.equal(list[0].simulated,true);
  assert.equal(list[1].kind,'remote-manifest');
  assert.equal(list[1].manifestUrl,'https://gw.example.com/m.json');
  assert.equal(list[2].kind,'iflytek-adapter');
  assert.equal(list[2].simulated,false);
  assert.ok(list[3].id.startsWith('source-'));
  assert.equal(normalizeSourceList([raw.sources[0]]).length,1);
  assert.equal(normalizeSourceList({list:raw.sources.filter(Boolean)}).length,4);
  assert.deepEqual(normalizeSourceList(undefined),[]);
  assert.deepEqual(normalizeSourceList({}),[]);
});
test('能力字段归一化：数组/对象/字符串',()=>{
  assert.deepEqual(normalizeCapabilities(['files.list',{name:'audio.download'},'']),['files.list','audio.download']);
  assert.deepEqual(normalizeCapabilities({files:true,audioDownload:'已支持',broken:false}),['files','audioDownload: 已支持']);
  assert.deepEqual(normalizeCapabilities('files.list'),['files.list']);
  assert.deepEqual(normalizeCapabilities(null),[]);
});
test('时间格式化：空值、无效值与今天/固定日期',()=>{
  assert.equal(formatTime(''),'从未同步');
  assert.equal(formatTime('','暂无'),'暂无');
  assert.equal(formatTime('not-a-date'),'not-a-date');
  assert.ok(formatTime(new Date()).includes('今天'));
  const fixed=formatTime(new Date(2020,0,5,3,4));
  assert.ok(fixed.includes('1月5日')&&fixed.includes('03:04'),`实际：${fixed}`);
});

/* ---------- 浏览器交互（假 api 注入，不依赖后端） ---------- */
let browser;
before(async()=>{
  browser=await chromium.launch({headless:true}).catch(e=>{
    console.warn('内置 chromium 启动失败，改用系统 Chrome：',e.message);
    return chromium.launch({headless:true,channel:'chrome'});
  });
});
after(async()=>{await browser?.close()});

const SIM_SOURCE={id:'sim-1',name:'演示设备',kind:'simulator',status:'configured',lastSyncAt:'',lastError:'',capabilities:[]};
const REMOTE_SOURCE={id:'rem-1',name:'我的网关',kind:'remote-manifest',status:'configured',lastSyncAt:'',lastError:'',capabilities:['files.list'],manifestUrl:'https://gw.example.com/manifest.json'};

async function mount(page,{sources=[],behavior={}}={}){
  await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><main id="host"></main></body></html>');
  await page.addStyleTag({content:cssCode});
  await page.addScriptTag({type:'module',content:moduleCode+'\nwindow.__dc={createDeviceConnections};'});
  await page.evaluate(({sources,behavior})=>{
    window.__calls=[];window.__toasts=[];window.__sleep=ms=>new Promise(r=>setTimeout(r,ms));
    window.__behavior={list:{sources},...behavior};
    window.__api=async(endpoint,{method='GET',body}={})=>{
      window.__calls.push({endpoint,method,body});
      const b=window.__behavior;
      if(endpoint==='connectors'&&method==='GET'){
        if(b.listError)throw new Error(b.listError);
        const data=typeof b.list==='function'?await b.list():b.list;
        return data;
      }
      if(endpoint==='connectors'&&method==='POST'){
        if(b.addError){await window.__sleep(60);throw new Error(b.addError)}
        const src={id:'src-'+(b._n=(b._n||0)+1),name:body.name,kind:body.kind,status:'configured',lastSyncAt:'',lastError:'',capabilities:[],...(body.manifestUrl?{manifestUrl:body.manifestUrl}:{})};
        const arr=Array.isArray(b.list)?b.list:(b.list?.sources||[]);
        b.list={sources:[...arr,src]};
        return src;
      }
      if(endpoint.startsWith('connectors/')&&endpoint.endsWith('/test')){
        if(b.testError)throw new Error(b.testError);
        return typeof b.test==='function'?await b.test():(b.test||{sourceId:'x',status:'reachable',simulated:false,capabilities:['files.list']});
      }
      if(endpoint.startsWith('connectors/')&&endpoint.endsWith('/sync')){
        if(b.syncError)throw new Error(b.syncError);
        return typeof b.sync==='function'?await b.sync():(b.sync||{sourceId:'x',simulated:false,discovered:0,imported:0,duplicates:0,failed:0,files:[]});
      }
      if(endpoint.startsWith('connectors/')&&method==='DELETE'){
        if(b.removeError)throw new Error(b.removeError);
        const id=endpoint.slice('connectors/'.length);
        const arr=Array.isArray(b.list)?b.list:(b.list?.sources||[]);
        b.list={sources:arr.filter(s=>s.id!==id)};
        return {ok:true};
      }
      throw new Error('接口不存在');
    };
    window.__dcInstance=window.__dc.createDeviceConnections({api:window.__api,toast:m=>window.__toasts.push(String(m))});
    const host=document.querySelector('#host');
    host.innerHTML=window.__dcInstance.render();
    window.__dcInstance.bind(host);
  },{sources,behavior});
}
const bodyText=page=>page.evaluate(()=>document.body.innerText);
const waitText=(page,needle,timeout=4000)=>page.waitForFunction(n=>document.body.innerText.includes(n),needle,{timeout});
const calls=page=>page.evaluate(()=>window.__calls);

test('初始渲染：加载态、诚实边界说明与空态',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    await mount(page);
    assert.ok((await bodyText(page)).includes('正在读取连接来源'),'首帧应为加载态');
    await page.evaluate(()=>window.__dcInstance.refresh());
    const text=await bodyText(page);
    assert.ok(text.includes('还没有连接来源'),'空库应显示空态');
    assert.ok(text.includes('不声称已连接讯飞官方云'),'必须包含官方云诚实边界说明');
    assert.ok(text.includes('演示设备')&&text.includes('远程 manifest'),'说明区应区分两类来源');
    assert.ok(text.includes('你自己的'),'远程说明必须强调是用户自建网关');
  }finally{await page.context().close()}
});
test('接口不可用：显示可解释横幅，恢复后自动消失',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    await mount(page,{behavior:{listError:'接口不存在'}});
    await page.evaluate(()=>window.__dcInstance.refresh());
    await waitText(page,'设备连接接口暂不可用');
    await waitText(page,'接口不存在');
    await page.evaluate(src=>{window.__behavior.listError='';window.__behavior.list={sources:[src]};return window.__dcInstance.refresh()},SIM_SOURCE);
    await waitText(page,'演示设备');
    assert.equal(await page.locator('.dc-banner-error').count(),0,'恢复后横幅应消失');
  }finally{await page.context().close()}
});
test('添加演示设备：POST 内容正确，卡片带演示与模拟标记和下一步提示',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    await mount(page);
    await page.evaluate(()=>window.__dcInstance.refresh());
    await page.locator('.dc-head [data-dc-action="open-form"]').click();
    await page.waitForSelector('#dc-add-form');
    await page.locator('#dc-name').fill('演示设备');
    await page.locator('#dc-add-form button[type="submit"]').click();
    await waitText(page,'演示设备');
    const posted=(await calls(page)).find(c=>c.method==='POST');
    assert.deepEqual(posted.body,{kind:'simulator',name:'演示设备'});
    assert.ok(await page.locator('.dc-kind-badge--simulator').count()>=1,'应有演示设备徽标');
    assert.ok(await page.locator('.dc-card .dc-simulated-flag').count()>=1,'演示卡片应有「模拟」标记');
    assert.ok((await bodyText(page)).includes('先「测试连接」确认来源可用，再「手动同步」'),'应有下一步提示');
  }finally{await page.context().close()}
});
test('添加远程来源：URL 前端校验拦下非法地址（不发请求），合法时携带令牌提交且令牌不回显',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    await mount(page);
    await page.evaluate(()=>window.__dcInstance.refresh());
    await page.locator('.dc-head [data-dc-action="open-form"]').click();
    await page.waitForSelector('#dc-add-form');
    await page.locator('.dc-kind-option[data-dc-kind="remote-manifest"]').click();
    await page.waitForSelector('#dc-manifest-url');
    const before=(await calls(page)).filter(c=>c.method==='POST').length;
    for(const bad of ['http://example.com/m.json','https://127.0.0.1/m.json','https://printer.local/m.json','javascript:alert(1)']){
      await page.locator('#dc-manifest-url').fill(bad);
      await page.locator('#dc-add-form button[type="submit"]').click();
      await page.waitForSelector('.dc-form-error');
      const err=await page.locator('.dc-form-error').textContent();
      assert.ok(err.includes('HTTPS')||err.includes('内网')||err.includes('保留主机名')||err.includes('格式无效'),`非法地址 ${bad} 应被拦截，实际：${err}`);
      assert.equal((await calls(page)).filter(c=>c.method==='POST').length,before,`非法地址 ${bad} 不应发起 POST`);
    }
    await page.locator('#dc-manifest-url').fill('https://gw.example.com/manifest.json');
    await page.locator('#dc-token').fill('tok_secret_abc123');
    await page.locator('#dc-name').fill('我的网关');
    await page.locator('#dc-add-form button[type="submit"]').click();
    await waitText(page,'我的网关');
    const posted=(await calls(page)).find(c=>c.method==='POST'&&c.body?.kind==='remote-manifest');
    assert.equal(posted.body.manifestUrl,'https://gw.example.com/manifest.json');
    assert.equal(posted.body.bearerToken,'tok_secret_abc123','token 应随请求提交给本地服务');
    assert.equal(await page.locator('#dc-token').count(),0,'成功后表单应关闭');
    assert.ok(!(await page.content()).includes('tok_secret_abc123'),'令牌不得出现在页面 HTML 中');
    assert.ok(await page.locator('.dc-url').count()>=1,'卡片应显示网关地址');
    assert.ok((await page.locator('.dc-url').first().textContent()).includes('https://gw.example.com/manifest.json'));
  }finally{await page.context().close()}
});
test('切换来源类型保留已填草稿；表单错误对令牌脱敏',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    await mount(page,{behavior:{addError:'请求失败：Bearer tok_secret_abc123 已过期'}});
    await page.evaluate(()=>window.__dcInstance.refresh());
    await page.locator('.dc-head [data-dc-action="open-form"]').click();
    await page.waitForSelector('#dc-add-form');
    await page.locator('.dc-kind-option[data-dc-kind="remote-manifest"]').click();
    await page.waitForSelector('#dc-manifest-url');
    await page.locator('#dc-manifest-url').fill('https://gw.example.com/manifest.json');
    await page.locator('#dc-name').fill('草稿保留测试');
    await page.locator('.dc-kind-option[data-dc-kind="simulator"]').click();
    await page.waitForSelector('#dc-name');
    await page.locator('.dc-kind-option[data-dc-kind="remote-manifest"]').click();
    await page.waitForSelector('#dc-manifest-url');
    assert.equal(await page.locator('#dc-manifest-url').inputValue(),'https://gw.example.com/manifest.json','URL 草稿应在重渲染后保留');
    assert.equal(await page.locator('#dc-name').inputValue(),'草稿保留测试','名称草稿应在重渲染后保留');
    await page.locator('#dc-token').fill('tok_secret_abc123');
    await page.locator('#dc-add-form button[type="submit"]').click();
    await page.waitForSelector('.dc-form-error');
    const err=await page.locator('.dc-form-error').textContent();
    assert.ok(!err.includes('tok_secret_abc123'),'错误提示不得包含令牌原文');
    assert.ok(err.includes('***'),'错误提示应包含脱敏占位');
  }finally{await page.context().close()}
});
test('测试连接：busy 禁用态、成功结果与能力标签、失败可重试',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    await mount(page,{sources:[SIM_SOURCE]});
    await page.evaluate(()=>window.__dcInstance.refresh());
    await page.evaluate(()=>{
      window.__behavior.test=async()=>{await window.__sleep(400);return {sourceId:'sim-1',status:'reachable',simulated:true,capabilities:['files.list','audio.download']}};
    });
    const btn=page.locator('[data-dc-id="sim-1"] [data-dc-action="test"]');
    await btn.click();
    await page.waitForFunction(()=>{const b=document.querySelector('[data-dc-id="sim-1"] [data-dc-action="test"]');return b?.disabled&&b.getAttribute('aria-busy')==='true'&&b.textContent.includes('测试中…')},null,{timeout:1500});
    assert.ok(await page.locator('[data-dc-id="sim-1"] [data-dc-action="sync"]').isDisabled(),'同一来源其它按钮在忙碌时应禁用');
    await waitText(page,'最近测试');
    assert.ok((await bodyText(page)).includes('可连接'));
    assert.ok(await page.locator('.dc-cap').filter({hasText:'audio.download'}).count()===1,'能力应渲染为标签');
    assert.ok(await page.locator('.dc-result--test .dc-simulated-flag').count()===1,'模拟来源的测试结果应带模拟标记');
    assert.ok((await bodyText(page)).includes('连接正常，可以「手动同步」。'),'成功后应给下一步提示');
    // 失败路径：错误进结果块，按钮恢复可重试
    await page.evaluate(()=>{window.__behavior.test=async()=>{await window.__sleep(60);throw new Error('网关无法访问')}});
    await page.locator('[data-dc-id="sim-1"] [data-dc-action="test"]').click();
    await waitText(page,'网关无法访问');
    assert.ok((await bodyText(page)).includes('刚才的操作没有完成，可以直接重试'),'失败后应提示可重试');
    assert.ok(await page.locator('[data-dc-id="sim-1"] [data-dc-action="test"]').isEnabled(),'失败后测试按钮应可重试');
    assert.ok((await page.evaluate(()=>window.__toasts)).some(t=>t.includes('连接测试')),'应有 toast 反馈');
  }finally{await page.context().close()}
});
test('手动同步：按契约渲染计数与文件状态，失败可重试且不产生伪成功',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    await mount(page,{sources:[REMOTE_SOURCE]});
    await page.evaluate(()=>window.__dcInstance.refresh());
    await page.evaluate(()=>{
      window.__behavior.sync=async()=>{await window.__sleep(80);return {sourceId:'rem-1',simulated:false,discovered:3,imported:2,duplicates:1,failed:1,files:[
        {id:'f1',name:'演示录音-晨间想法.mp3',status:'imported'},
        {id:'f2',name:'演示录音-周会要点.mp3',status:'duplicate'},
        {id:'f3',name:'损坏的文件.mp3',status:'failed',error:'超过大小限制'}
      ]}};
    });
    await page.locator('[data-dc-id="rem-1"] [data-dc-action="sync"]').click();
    await waitText(page,'发现 3 · 新导入 2 · 重复跳过 1 · 失败 1');
    assert.ok((await bodyText(page)).includes('发现 3 · 新导入 2 · 重复跳过 1 · 失败 1'),'计数行应按契约字段渲染');
    assert.ok((await bodyText(page)).includes('已导入')&&(await bodyText(page)).includes('重复，已跳过')&&(await bodyText(page)).includes('失败'));
    assert.ok((await bodyText(page)).includes('损坏的文件.mp3')&&(await bodyText(page)).includes('超过大小限制'),'失败文件应带错误详情');
    assert.ok((await bodyText(page)).includes('转写与整理队列'),'应提示导入后的去向');
    await page.evaluate(()=>{window.__behavior.sync=async()=>{await window.__sleep(60);throw new Error('连接中断')}});
    await page.locator('[data-dc-id="rem-1"] [data-dc-action="sync"]').click();
    await waitText(page,'连接中断');
    assert.ok((await bodyText(page)).includes('刚才的操作没有完成，可以直接重试'));
    assert.ok(await page.locator('[data-dc-id="rem-1"] [data-dc-action="sync"]').isEnabled(),'同步失败后应可重试');
    const toasts=await page.evaluate(()=>window.__toasts);
    assert.ok(toasts.some(t=>t.includes('同步完成，但有 1 个文件失败')),'同步部分失败时 toast 应如实说明');
    assert.ok(toasts.some(t=>t.includes('同步失败：连接中断')),'整体失败时 toast 应给出原因');
  }finally{await page.context().close()}
});
test('移除配置：确认文案说明记录保留；取消则不发请求；确认后配置消失',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    await mount(page,{sources:[SIM_SOURCE,REMOTE_SOURCE]});
    await page.evaluate(()=>window.__dcInstance.refresh());
    let dialogText='';
    page.once('dialog',async d=>{dialogText=d.message();await d.accept()});
    await page.locator('[data-dc-id="sim-1"] [data-dc-action="remove"]').click();
    await page.waitForFunction(()=>window.__calls.some(c=>c.method==='DELETE'),null,{timeout:3000});
    assert.ok(dialogText.includes('sim-1')||dialogText.includes('演示设备'),'确认框应指明来源');
    assert.ok(dialogText.includes('已导入的记录')&&dialogText.includes('保留'),'确认框必须说明已导入记录保留');
    await page.waitForFunction(()=>!document.querySelector('.dc-card[data-dc-id="sim-1"]'),null,{timeout:3000});
    assert.ok(await page.locator('.dc-card[data-dc-id="sim-1"]').count()===0,'确认后卡片应消失');
    assert.ok(await page.locator('.dc-card[data-dc-id="rem-1"]').count()===1,'其它来源不受影响');
    const del=(await calls(page)).find(c=>c.method==='DELETE');
    assert.equal(del.endpoint,'connectors/sim-1');
    // 取消路径
    page.once('dialog',async d=>{await d.dismiss()});
    await page.locator('[data-dc-id="rem-1"] [data-dc-action="remove"]').click();
    await page.waitForTimeout(300);
    assert.ok(!(await calls(page)).some(c=>c.method==='DELETE'&&c.endpoint==='connectors/rem-1'),'取消后不应发起 DELETE');
    assert.ok(await page.locator('.dc-card[data-dc-id="rem-1"]').count()===1,'取消后卡片保留');
  }finally{await page.context().close()}
});
test('XSS 防护：来源名称与错误信息按文本渲染',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    const evil={id:'evil-1',name:'<img src=x onerror="window.__pwned=1">',kind:'remote-manifest',status:'error',lastError:'<script>window.__hacked=1</script>',capabilities:[],manifestUrl:'https://gw.example.com/m.json'};
    await mount(page,{sources:[evil]});
    await page.evaluate(()=>window.__dcInstance.refresh());
    await waitText(page,'<img src=x');
    assert.equal(await page.locator('.dc-name img').count(),0,'名称不得产生 img 节点');
    assert.ok((await page.evaluate(()=>window.__pwned))===undefined,'onerror 不应执行');
    assert.ok((await page.evaluate(()=>window.__hacked))===undefined,'script 注入不应执行');
    assert.ok((await bodyText(page)).includes('<img src=x onerror="window.__pwned=1">'),'恶意输入应按纯文本可见');
  }finally{await page.context().close()}
});
test('未知类型来源与数组形态列表：仍渲染可用操作',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    await mount(page,{sources:[{id:'adp-1',name:'厂商适配器占位',kind:'iflytek-adapter',status:'configured',lastSyncAt:'',lastError:'',capabilities:[]}]});
    await page.evaluate(()=>{window.__behavior.list=[{id:'adp-1',name:'厂商适配器占位',kind:'iflytek-adapter',status:'configured',capabilities:[]}];return window.__dcInstance.refresh()});
    await waitText(page,'厂商适配器占位');
    assert.ok(await page.locator('.dc-card--other').count()===1,'未知类型应有中性样式');
    assert.ok(await page.locator('[data-dc-id="adp-1"] [data-dc-action="test"]').isEnabled());
    assert.ok(await page.locator('[data-dc-id="adp-1"] .dc-simulated-flag').count()===0,'未知类型不得被标记为模拟');
  }finally{await page.context().close()}
});
test('窄屏 375px：不横向溢出，操作按钮纵向堆叠',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    await page.setViewportSize({width:375,height:812});
    await mount(page,{sources:[SIM_SOURCE,REMOTE_SOURCE]});
    await page.evaluate(()=>window.__dcInstance.refresh());
    await waitText(page,'演示设备');
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
    assert.ok(overflow<=1,`窄屏不应横向溢出，超出 ${overflow}px`);
    const stack=await page.evaluate(()=>{
      const actions=document.querySelector('.dc-actions');
      return actions&&getComputedStyle(actions).flexDirection==='column';
    });
    assert.ok(stack,'窄屏下操作按钮应纵向堆叠');
  }finally{await page.context().close()}
});
test('render/bind/refresh 可重复调用：宿主重渲染后委托仍生效',async()=>{
  const page=await browser.newContext().then(c=>c.newPage());
  try{
    await mount(page,{sources:[SIM_SOURCE]});
    await page.evaluate(()=>window.__dcInstance.refresh());
    await waitText(page,'演示设备');
    // 模拟宿主整页重渲染：innerHTML 换新后重新 bind，委托事件必须仍然生效
    await page.evaluate(()=>{const host=document.querySelector('#host');const dc=window.__dcInstance;host.innerHTML=dc.render();dc.bind(host)});
    await page.locator('.dc-head [data-dc-action="open-form"]').click();
    await page.waitForSelector('#dc-add-form');
    await page.locator('[data-dc-action="close-form"]').click();
    await page.waitForFunction(()=>!document.querySelector('#dc-add-form'));
    assert.ok(await page.locator('.dc-card[data-dc-id="sim-1"]').count()===1,'重渲染+重绑定后列表仍正常');
  }finally{await page.context().close()}
});
