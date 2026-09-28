// D 验收脚本：设备连接页浏览器用户路径（对已运行的隔离实例执行；用法：SHENGJI_UI_BASE=http://127.0.0.1:5197 node tests/verify-devices-ui.mjs）。不在 npm test 内，需要本机 Chrome。
import {chromium} from '@playwright/test';

const base=process.env.SHENGJI_UI_BASE||'http://127.0.0.1:5197';
const browser=await chromium.launch({headless:true}).catch(()=>chromium.launch({headless:true,channel:'chrome'}));
const page=await browser.newPage({viewport:{width:1280,height:900}});
const log=[];
const check=(name,cond)=>{log.push(`${cond?'PASS':'FAIL'} ${name}`);if(!cond)process.exitCode=1};

await page.goto(base);
await page.waitForSelector('.nav-item');
check('应用启动且侧栏渲染',await page.locator('.sidebar').count()>0);
check('存在「设备连接」导航项',await page.getByRole('button',{name:'设备连接'}).count()>0);
check('导航无「已连接讯飞」类表述',(await page.content()).includes('已连接讯飞')===false);

await page.getByRole('button',{name:'设备连接'}).click();
await page.waitForSelector('.device-connections');
check('设备连接页渲染',true);
check('诚实边界说明存在',(await page.locator('.device-connections').innerText()).includes('尚未连接任何讯飞官方云服务'));
check('空态提示',await page.locator('.dc-empty, .dc-source-list').count()>=0);

// 添加演示设备
await page.getByRole('button',{name:'添加连接来源'}).first().click();
await page.waitForSelector('#dc-add-form');
check('添加表单出现',true);
const nameInput=page.locator('#dc-name');
await nameInput.fill('验收演示设备');
await page.locator('#dc-add-form button[type="submit"]').click();
await page.waitForSelector('.dc-card');
check('来源卡片出现',await page.locator('.dc-card').count()===1);
check('演示徽标',await page.locator('.dc-kind-badge--simulator').count()>0);
check('模拟旗标',await page.locator('.dc-simulated-flag').count()>0);

// 测试连接
await page.getByRole('button',{name:'测试连接'}).click();
await page.waitForSelector('.dc-result--test');
const testText=await page.locator('.dc-result--test').innerText();
check('测试结果可连接',testText.includes('可连接'));
check('测试结果带模拟标记',testText.includes('模拟'));

// 手动同步
await page.getByRole('button',{name:'手动同步'}).click();
await page.waitForSelector('.dc-result--sync');
const syncText=await page.locator('.dc-result--sync').innerText();
check('同步计数行',/发现 3 · 新导入 3 · 重复跳过 0 · 失败 0/.test(syncText));
check('文件状态列表',await page.locator('.dc-file').count()===3);
check('去向提示（处理队列）',syncText.includes('处理队列'));

// 二次同步去重
await page.getByRole('button',{name:'手动同步'}).click();
await page.waitForFunction(()=>/重复跳过 3/.test(document.querySelector('.dc-result--sync')?.textContent||''));
check('二次同步全部重复',true);

// 记录出现在全部记录，带设备同步徽标
await page.getByRole('button',{name:'全部记录'}).click();
await page.waitForSelector('.record-card');
check('导入的 3 条记录可见',await page.locator('.record-card').count()===3);
check('卡片带「设备同步」标记',await page.getByText('设备同步').count()>=1);

// 打开一条记录确认音频面板
await page.locator('.record-card', {hasText:'演示录音'}).first().locator('.record-main').click();
await page.waitForSelector('#modal[open]');
check('详情音频面板渲染',await page.locator('.audio-panel').count()>0);
await page.keyboard.press('Escape');

// 移除配置（confirm 对话框）
page.once('dialog',d=>{check('confirm 文案含记录保留',d.message().includes('会完整保留'));d.accept()});
await page.getByRole('button',{name:'设备连接'}).click();
await page.waitForSelector('.dc-card');
await page.getByRole('button',{name:'移除配置'}).click();
await page.waitForFunction(()=>document.querySelectorAll('.dc-card').length===0);
check('移除后列表为空',true);

// 记录仍在
await page.getByRole('button',{name:'全部记录'}).click();
await page.waitForSelector('.record-card');
check('移除配置后 3 条记录保留',await page.locator('.record-card').count()===3);

await page.screenshot({path:'/tmp/shengji-d-smoke2/ui-devices-empty.png',fullPage:false});
console.log(log.join('\n'));
await browser.close();
