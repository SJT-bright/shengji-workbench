import {test,expect} from '@playwright/test';
import fs from 'node:fs';
const headers={'X-Shengji-Token':'ui-test-token'};
const fixture={id:'fixture',title:'演示的学习记录',category:'learn',date:'2026-09-26',time:'10:00',duration:3,transcript:'今天学习了如何将复杂任务拆解成可以检查的小步骤。',summary:'任务拆解练习',highlights:[],learnings:[],actions:[],favorite:false,reviewed:false,demo:true};
const stateOf=async request=>(await request.get('/api/state',{headers})).json();
test('recording workspace keeps cleanup next to summary, queue state and local connections',async({page,request})=>{
 const state=await stateOf(request);expect(state.database.engine).toBe('SQLite');
 const r=state.records[0];await request.put('/api/records',{headers,data:{...r,cleanedTranscript:'学习如何将复杂任务拆解成可以检查的小步骤。'}});
 await page.goto('/');await page.locator('.record-main').click();await expect(page.locator('.cleaned-block')).toContainText('学习如何将复杂任务');await expect(page.locator('#edit-summary')).toHaveValue('任务拆解练习');await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator('[data-page="queue"]').click();await page.locator('#pause-queue').click();await expect(page.locator('#pause-queue')).toHaveText('继续处理');await page.reload();await page.locator('[data-page="queue"]').click();await expect(page.locator('#pause-queue')).toHaveText('继续处理');await page.locator('#pause-queue').click();
 await page.locator('[data-page="connections"]').click();await expect(page.getByRole('heading',{name:'本地数据库'})).toBeVisible();await expect(page.locator('.connections-grid')).toContainText('SQLite');
 await page.locator('[data-page="ask"]').click();await page.locator('#question-input').fill('火星海洋');await page.getByRole('button',{name:'检索并生成回答'}).click();await expect(page.locator('#answer-results')).toContainText('没有检索到相关');
});
test.beforeEach(async({request})=>{const state=await stateOf(request);expect((await request.put('/api/settings',{headers,data:{...state.settings,autoAnalyze:false,watchEnabled:false}})).ok()).toBeTruthy();expect((await request.post('/api/restore',{headers,data:{version:2,records:[fixture]}})).ok()).toBeTruthy()});
test('import, organize, favorite, persist, search and export',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');await expect(page.locator('.record-card')).toHaveCount(1);
 await page.getByRole('button',{name:'导入录音 / 文字',exact:true}).click();
 const raw='1\n00:00:00,000 --> 00:00:03,000\n今天学习如何把任务拆解到具体行动。';
 await page.locator('#file-input').setInputFiles({name:'一次学习.srt',mimeType:'text/plain',buffer:Buffer.from(raw)});
 await expect(page.locator('.import-queue-row')).toContainText('一次学习.srt');
 await page.locator('#title-input').fill('验收：一次值得回看的谈话');await page.locator('#category-input').selectOption('learn');
 await page.getByRole('button',{name:'保存并开始处理',exact:true}).click();await expect(page.locator('.import-queue-row.done')).toHaveCount(1);
 const imported=(await stateOf(request)).records.find(r=>r.title==='验收：一次值得回看的谈话');expect(imported.transcript).toBe('今天学习如何把任务拆解到具体行动。');expect(imported.source.name).toBe('一次学习.srt');
 const backup=await(await request.get('/api/backup',{headers})).json();expect(backup.originals[imported.source.hash]).toBe(raw);
 await page.getByRole('button',{name:'查看',exact:true}).click();await page.locator('#edit-summary').fill('一次关于任务拆解的学习记录');await page.locator('#edit-learnings').fill('把下一步写成一个可以检查的动作');await page.locator('#edit-reviewed').check();await page.getByRole('button',{name:'保存整理',exact:true}).click();
 await page.getByRole('button',{name:'收藏 验收：一次值得回看的谈话',exact:true}).click();await expect(page.getByRole('button',{name:'取消收藏 验收：一次值得回看的谈话',exact:true})).toBeVisible();
 await page.reload();await page.locator('[data-page="favorites"]').click();await expect(page.getByRole('heading',{name:'验收：一次值得回看的谈话',exact:true})).toBeVisible();await page.locator('#search').fill('可以检查的动作');await expect(page.locator('.record-card')).toHaveCount(1);await page.locator('.record-main').click();await page.getByRole('button',{name:'转写原文',exact:true}).click();await expect(page.locator('.transcript')).toContainText('今天学习');const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出记录',exact:true}).click();expect((await download).suggestedFilename()).toContain('.md');expect(errors).toEqual([]);
});
test('custom category is saved, scoped, renamed and safely deleted',async({page,request})=>{
 await page.goto('/');await page.getByRole('button',{name:'管理分类 / 添加分类',exact:true}).click();await page.getByRole('button',{name:'添加分类',exact:true}).click();await page.locator('[data-cat-name]').last().fill('家庭重要谈话');await page.locator('[data-cat-icon]').last().selectOption('mic');await page.getByRole('button',{name:'保存分类',exact:true}).click();
 await expect.poll(async()=> (await stateOf(request)).categories.some(c=>c.name==='家庭重要谈话')).toBeTruthy();const created=(await stateOf(request)).categories.find(c=>c.name==='家庭重要谈话');expect(created.id).toMatch(/^custom-/);expect(created.icon).toBe('mic');
 const added=await request.post('/api/import',{headers,data:{text:'讨论了家里的下一次共同出游安排。',title:'家庭出游安排',category:created.id,date:'2026-09-26',time:'11:30',autoAnalyze:false}});expect(added.ok()).toBeTruthy();
 await page.reload();await page.locator(`[data-page="${created.id}"]`).click();await expect(page.locator('.record-card')).toHaveCount(1);await expect(page.locator('.record-title')).toHaveText('家庭出游安排');await expect(page.locator('[data-filter]')).toHaveCount(0);
 await page.getByRole('button',{name:'管理分类 / 添加分类',exact:true}).click();await page.locator('[data-cat-name]').last().fill('家庭回忆');await page.getByRole('button',{name:'保存分类',exact:true}).click();await expect(page.locator(`[data-page="${created.id}"]`)).toContainText('家庭回忆');await expect(page.locator('.record-tags .tag')).toHaveText('家庭回忆');
 await page.getByRole('button',{name:'管理分类 / 添加分类',exact:true}).click();await expect(page.getByRole('button',{name:'删除 待确认',exact:true})).toBeDisabled();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除 家庭回忆',exact:true}).click();await page.getByRole('button',{name:'保存分类',exact:true}).click();await expect(page.locator(`[data-page="${created.id}"]`)).toHaveCount(0);await expect.poll(async()=> (await stateOf(request)).records.find(r=>r.title==='家庭出游安排')?.category).toBe('inbox');
});
test('global multi-file drop imports separately and retains rejected items',async({page,request})=>{
 await page.goto('/');await expect(page.locator('.record-card')).toHaveCount(1);const before=page.url();
 await page.evaluate(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['第一段：确认本周项目时间安排。'],'项目安排.txt',{type:'text/plain'}));transfer.items.add(new File(['第二段：读书后记得每天记录新想法。'],'读书记录.md',{type:'text/markdown'}));transfer.items.add(new File(['unsupported'],'不支持的文件.pdf',{type:'application/pdf'}));for(const type of ['dragenter','dragover','drop'])document.body.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer}))});
 await expect(page.getByRole('heading',{name:'导入录音与文字',exact:true})).toBeVisible();expect(page.url()).toBe(before);await expect(page.locator('.import-queue-row')).toHaveCount(3);await expect(page.locator('.import-queue-row.failed')).toContainText('不支持此格式');
 await page.getByRole('button',{name:'重试未成功的文件',exact:true}).click();await expect(page.locator('.import-queue-row.done')).toHaveCount(2);await expect(page.locator('.import-queue-row.failed')).toHaveCount(1);
 const imported=(await stateOf(request)).records.filter(r=>!r.demo);expect(imported).toHaveLength(2);expect(imported.map(r=>r.source.name).sort()).toEqual(['读书记录.md','项目安排.txt']);expect(imported.map(r=>r.transcript).sort()).toEqual(['第一段：确认本周项目时间安排。','第二段：读书后记得每天记录新想法。'].sort());
 await page.getByRole('button',{name:'移除 不支持的文件.pdf',exact:true}).click();await expect(page.locator('.import-queue-row.failed')).toHaveCount(0);await page.locator('.modal-footer').getByRole('button',{name:'关闭',exact:true}).click();await expect(page.locator('#modal')).not.toBeVisible();await expect(page.locator('.record-card')).toHaveCount(3);
});
test('mobile layout, empty library and settings',async({page})=>{await page.setViewportSize({width:390,height:844});await page.goto('/');await expect(page.locator('.record-card')).toHaveCount(1);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'移除演示'}).click();await expect(page.getByRole('heading',{name:'这里还没有留下声音'})).toBeVisible();await page.getByRole('button',{name:'自动整理设置',exact:true}).first().click();await expect(page.locator('#watch-folder')).toHaveValue(/shengji-ui/);expect(await page.locator('#modal').evaluate(el=>el.getBoundingClientRect().width<=innerWidth)).toBeTruthy();await page.getByRole('button',{name:'关闭',exact:true}).click()});
test('backup rejection leaves records intact and text stays inert',async({page,request})=>{const bad=await request.post('/api/restore',{headers,data:{version:2,records:[{id:'bad'}]}});expect(bad.status()).toBe(400);const state=await stateOf(request);expect(state.records[0].title).toBe(fixture.title);await request.post('/api/restore',{headers,data:{version:2,records:[{...fixture,id:'"><img src=x onerror=alert(1)>',title:'<script>window.hacked=true</script>'}]}});await page.goto('/');await expect(page.locator('.record-card')).toHaveCount(1);expect(await page.evaluate(()=>Boolean(window.hacked))).toBeFalsy();await expect(page.locator('.record-list img')).toHaveCount(0)});
test('optical reveal plays on click-driven renders only',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await expect(page.locator('.record-card')).toHaveCount(1);
 // 首次启动加载：不带 optical-reveal
 await expect(page.locator('main.main')).not.toHaveClass(/optical-reveal/);
 // 点击侧边栏导航：渲染带 optical-reveal，动画中间态应可见模糊半透明
 await page.locator('.sidebar [data-page="all"]').click();
 await expect(page.locator('main.main')).toHaveClass(/optical-reveal/);
 await page.evaluate(()=>document.getAnimations().filter(a=>a.animationName==='opticalReveal').forEach(a=>{a.pause();a.currentTime=150}));
 const midFilter=await page.evaluate(()=>getComputedStyle(document.querySelector('main.main')).filter);
 const midOpacity=await page.evaluate(()=>getComputedStyle(document.querySelector('main.main')).opacity);
 await page.screenshot({path:'verification/optical-reveal-mid.png'});
 await page.evaluate(()=>document.getAnimations().filter(a=>a.animationName==='opticalReveal').forEach(a=>{a.currentTime=50}));
 await page.screenshot({path:'verification/optical-reveal-mid-early.png'});
 await page.evaluate(()=>document.getAnimations().forEach(a=>{if(a.animationName==='opticalReveal')a.play()}));
 await page.waitForTimeout(700);
 await page.screenshot({path:'verification/optical-reveal-done.png'});
 expect(midFilter).toMatch(/blur\(([1-9])/);expect(Number(midOpacity)).toBeLessThan(1);
 // 点击记录打开详情：#modal 带 optical-reveal
 await page.locator('.record-main').click();
 await expect(page.locator('#modal')).toHaveClass(/optical-reveal/);
 await page.waitForTimeout(700);
 // 弹窗内切换标签页：每次点击都重放（先手动移除类，切换后必须重新加上）
 await page.locator('#modal').evaluate(el=>el.classList.remove('optical-reveal'));
 await page.locator('[data-tab="raw"]').click();
 await expect(page.locator('#modal')).toHaveClass(/optical-reveal/);
 // 关闭弹窗后向搜索框输入文字：打字不算点击，渲染不带 optical-reveal
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator('#search').fill('任务');
 await expect(page.locator('main.main')).not.toHaveClass(/optical-reveal/);
 expect(errors).toEqual([]);
});
test('search feedback and keyboard shortcuts',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');await expect(page.locator('.record-card')).toHaveCount(1);
 // 「找到 N 条」计数只在内容页 section-head 上出现，先进全部记录
 await page.locator('.sidebar [data-page="all"]').click();
 // `/` 聚焦搜索框
 await page.keyboard.press('/');expect(await page.evaluate(()=>document.activeElement&&document.activeElement.id)).toBe('search');
 // 输入命中词：清除按钮出现，计数文案出现
 await page.locator('#search').fill('任务');await expect(page.locator('.search-clear')).toBeVisible();await expect(page.locator('.section-head span')).toContainText('找到');await expect(page.locator('.section-head span')).toContainText('「任务」');
 await page.screenshot({path:'verification/search-clear-state.png'});
 // 点击清除：清空、焦点回到搜索框、按钮消失
 await page.locator('.search-clear').click();await expect(page.locator('#search')).toHaveValue('');expect(await page.evaluate(()=>document.activeElement&&document.activeElement.id)).toBe('search');await expect(page.locator('.search-clear')).toHaveCount(0);
 // Escape 第一次：清词且焦点仍在；第二次：失焦
 await page.locator('#search').fill('任务');await page.keyboard.press('Escape');await expect(page.locator('#search')).toHaveValue('');expect(await page.evaluate(()=>document.activeElement&&document.activeElement.id)).toBe('search');
 await page.keyboard.press('Escape');expect(await page.evaluate(()=>document.activeElement&&document.activeElement.id)).not.toBe('search');
 // ⌘K 聚焦
 await page.keyboard.press('Meta+k');expect(await page.evaluate(()=>document.activeElement&&document.activeElement.id)).toBe('search');
 // 无命中词：三态空状态之一 + 清除搜索按钮恢复列表
 await page.locator('#search').fill('zzzz不存在的词');await expect(page.locator('.empty-state h3')).toContainText('没有找到与');const clearBtn=page.locator('.empty-state [data-clear-search]');await expect(clearBtn).toBeVisible();
 await page.screenshot({path:'verification/search-empty-state.png'});
 await clearBtn.click();await expect(page.locator('.empty-state')).toHaveCount(0);await expect(page.locator('.record-card')).toHaveCount(1);
 expect(errors).toEqual([]);
});
test('quick find palette opens, searches, navigates and runs actions',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');await expect(page.locator('.record-card')).toHaveCount(1);
 // 顶栏入口打开面板：#palette[open] 且输入框自动聚焦
 await page.getByRole('button',{name:'快速查找',exact:true}).click();
 await expect(page.locator('#palette')).toHaveAttribute('open');await expect(page.locator('#palette-input')).toBeFocused();
 await page.keyboard.press('ArrowDown');
 await expect(page.locator('[data-palette-page="all"]')).toHaveAttribute('aria-selected','true');
 await page.keyboard.press('ArrowUp');
 await expect(page.locator('[data-palette-page="home"]')).toHaveAttribute('aria-selected','true');
 await page.locator('#palette-input').fill('演示文字');
 await page.keyboard.press('Home');
 expect(await page.locator('#palette-input').evaluate(el=>el.selectionStart)).toBe(0);
 await page.screenshot({path:'verification/palette-open.png'});
 // 输入关键词：记录段出现 fixture 行，点击打开详情弹窗
 await page.locator('#palette-input').fill('演示');
 const row=page.locator('[data-palette-record]');await expect(row).toHaveCount(1);await expect(row).toContainText('演示的学习记录');
 await row.click();await expect(page.locator('#modal')).toBeVisible();await expect(page.locator('#modal h2')).toHaveText('演示的学习记录');
 await page.locator('.modal-head').getByRole('button',{name:'关闭',exact:true}).click();await expect(page.locator('#modal')).not.toBeVisible();
 // 「前往」段：切到全部记录，面板自动收起
 await page.getByRole('button',{name:'快速查找',exact:true}).click();await expect(page.locator('#palette')).toHaveAttribute('open');
 await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
 await expect(page.locator('.breadcrumbs')).toContainText('全部记录');await expect(page.locator('#palette')).not.toBeVisible();
 // 「操作」段第一项：打开导入弹窗
 await page.getByRole('button',{name:'快速查找',exact:true}).click();
 await page.locator('[data-palette-action]').first().click();
 await expect(page.getByRole('heading',{name:'导入录音与文字',exact:true})).toBeVisible();
 await page.locator('.modal-footer').getByRole('button',{name:'关闭',exact:true}).click();await expect(page.locator('#modal')).not.toBeVisible();
 // 无命中：空态文案
 await page.getByRole('button',{name:'快速查找',exact:true}).click();
 await page.locator('#palette-input').fill('zzzz不存在的词');
 await expect(page.locator('.palette-empty')).toHaveText('没有匹配的结果');
 expect(errors).toEqual([]);
});
test('detail prev next navigates between adjacent records',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const newer={...fixture,id:'fixture-new',title:'较新的学习记录',date:'2026-09-26',time:'10:00'};
 const older={...fixture,id:'fixture-old',title:'较旧的学习记录',date:'2026-09-25',time:'09:00'};
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[newer,older]}})).ok()).toBeTruthy();
 await page.goto('/');await expect(page.locator('.record-card')).toHaveCount(2);
 // 打开较新一条：上一条禁用、下一条可用
 await page.locator('.record-main').first().click();
 await expect(page.locator('#modal h2')).toHaveText('较新的学习记录');
 const prev=page.getByRole('button',{name:'上一条记录'}),next=page.getByRole('button',{name:'下一条记录'});
 await expect(prev).toBeDisabled();await expect(next).toBeEnabled();
 await page.waitForTimeout(700);await page.screenshot({path:'verification/detail-nav.png'});
 // 下一条 → 较旧一条：此时下一条禁用；上一条 → 回到较新一条
 await next.click();await expect(page.locator('#modal h2')).toHaveText('较旧的学习记录');
 await expect(next).toBeDisabled();await expect(prev).toBeEnabled();
 await prev.click();await expect(page.locator('#modal h2')).toHaveText('较新的学习记录');
 expect(errors).toEqual([]);
});
test('delete is optimistic, cancellable within delay and final after timeout',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.goto('/');await expect(page.locator('.record-card')).toHaveCount(1);
 // 删除：弹窗关闭、列表乐观隐藏、toast 带撤销按钮
 await page.locator('.record-main').click();await expect(page.locator('#modal h2')).toHaveText(fixture.title);
 await page.locator('#delete-record').click();
 await expect(page.locator('#modal')).not.toBeVisible();await expect(page.locator('.record-card')).toHaveCount(0);
 const toast=page.locator('#toast');
 await expect(toast).toContainText('已删除');await expect(toast.locator('.toast-action')).toHaveText('撤销');
 await page.screenshot({path:'verification/delete-undo-toast.png'});
 // 撤销：记录回到列表，服务端仍在
 await page.locator('.toast-action').click();
 await expect(page.locator('.record-card')).toHaveCount(1);await expect(toast).toContainText('已撤销删除');
 await expect.poll(async()=>(await stateOf(request)).records.some(r=>r.id==='fixture')).toBeTruthy();
 // 再次删除不撤销：6 秒后真正删除，列表空态、服务端已删
 await page.locator('.record-main').click();await page.locator('#delete-record').click();
 await expect(page.locator('.record-card')).toHaveCount(0);
 await expect.poll(async()=>(await stateOf(request)).records.length,{timeout:10000}).toBe(0);
 await expect(page.getByRole('heading',{name:'这里还没有留下声音'})).toBeVisible();
 expect(errors).toEqual([]);
});
test('date filter chip, relative date label and reduced motion',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');await expect(page.locator('.record-card')).toHaveCount(1);
 // 与被测应用同款规则动态计算 2026-09-26 的相对标签，不硬编码
 const now=new Date(),pad=n=>String(n).padStart(2,'0'),todayStr=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
 const diff=Math.round((new Date(todayStr+'T00:00:00')-new Date('2026-09-26T00:00:00'))/864e5);
 const expected=diff===0?'今天':diff===1?'昨天':diff>1&&diff<=7?`${diff} 天前`:'9月26日';
 // 日历在工作台首页右栏：点 fixture 日期 → 出现带日期的清除 chip → 点 chip 消失
 await page.locator('.calendar-days [data-date="2026-09-26"]').click();const chip=page.locator('[data-clear-date]');await expect(chip).toBeVisible();await expect(chip).toContainText('2026-09-26');
 await chip.click();await expect(page.locator('[data-clear-date]')).toHaveCount(0);
 // 列表页卡片日期 = 动态相对标签（昨天 / N 天前 / M月D日）
 await page.locator('.sidebar [data-page="timeline"]').click();await expect(page.locator('.timeline-group h2').first()).toContainText('2026-09-26');
 // content-visibility:auto 会让刚重渲染的卡片 innerText 为空，改用不依赖布局的 textContent
 const meta=await page.locator('.record-card .record-meta').first().textContent();expect((meta||'').startsWith(expected),`meta=${meta} expected=${expected}`).toBeTruthy();
 // 点击导航：列表级联 listIn 在跑，.main 带 optical-reveal
 await page.locator('.sidebar [data-page="all"]').click();await expect(page.locator('.record-card').first()).toBeVisible();
 const reveal=await page.evaluate(()=>({names:document.querySelector('.record-card')?.getAnimations().map(a=>a.animationName)||[],cls:document.getElementById('main').classList.contains('optical-reveal')}));
 expect(reveal.cls).toBe(true);expect(reveal.names).toContain('listIn');
 // 减弱动态效果：动画全部不生成
 await page.emulateMedia({reducedMotion:'reduce'});await page.locator('.sidebar [data-page="timeline"]').click();await expect(page.locator('.record-card').first()).toBeVisible();
 expect(await page.evaluate(()=>document.querySelector('.record-card')?.getAnimations().length??-1)).toBe(0);
 expect(errors).toEqual([]);
});
test('daily digest falls back deterministically for a chosen day and for today',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const pad=n=>String(n).padStart(2,'0'),now=new Date(),todayStr=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
 const todayLabel=`${now.getMonth()+1}月${now.getDate()}日`;
 // 本周/本月/今年提炼卡复用 .digest-card 样式，今日卡的选择器需排除 .weekly-card、.monthly-card 与 .yearly-card
 const todayCard=page.locator('.digest-card:not(.weekly-card):not(.monthly-card):not(.yearly-card)');
 await page.goto('/');
 // 工作台今日提炼卡：今天（系统真实日期）无记录时只有引导文案、无按钮
 await expect(todayCard).toBeVisible();
 await expect(todayCard.locator('h2')).toContainText('今日提炼');
 await expect(todayCard.locator('h2')).toContainText(todayLabel);
 await expect(todayCard.locator('.digest-hint')).toContainText('今天还没有记录');
 await expect(todayCard.locator('button')).toHaveCount(0);
 // 每日足迹：对 2026-09-26 组「提炼这一天」→ 本地模型不可达时出现确定性 fallback 文本块
 await page.locator('[data-page="timeline"]').click();
 await page.locator('.day-digest-btn[data-digest-date="2026-09-26"]').click();
 await expect(page.locator('.day-digest')).toContainText('9月26日 · 共 1 段记录');
 await expect(page.locator('.day-digest')).toContainText('- 演示的学习记录 — 任务拆解练习');
 await page.screenshot({path:'verification/day-digest.png'});
 // 今日卡不受影响：提炼的是别的日子，今天仍无记录
 await page.locator('[data-page="home"]').click();
 await expect(todayCard.locator('.digest-hint')).toContainText('今天还没有记录');
 // 恢复一条今天的记录 → 「提炼今天」→ 提炼中… → fallback 文本 → 「重新提炼」
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[fixture,{...fixture,id:'fixture-today',title:'今天的谈话',date:todayStr,time:'20:00',transcript:'今天确认了验收节奏。'}]}})).ok()).toBeTruthy();
 await page.reload();
 await expect(todayCard.locator('button.btn-secondary')).toHaveText('提炼今天');
 await page.route('**/api/digest',async route=>{await new Promise(r=>setTimeout(r,800));await route.continue()});
 await todayCard.locator('button.btn-secondary').click();
 await expect(todayCard.locator('button.btn-secondary')).toHaveText('提炼中…');
 await expect(todayCard.locator('.digest-text')).toContainText(`${todayLabel} · 共 1 段记录`);
 await expect(todayCard.locator('.digest-text')).toContainText('- 今天的谈话 — 任务拆解练习');
 await expect(page.locator('#toast')).toContainText('今日提炼已生成');
 // 提炼完成后卡内出现「导出」按钮，主按钮需用 .btn-secondary 圈定
 await expect(todayCard.locator('button.btn-secondary')).toHaveText('重新提炼');
 await page.screenshot({path:'verification/digest-card.png'});
 expect(errors).toEqual([]);
});
test('value tagging saves instantly, marks the card as gem and switches back to daily',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');
 await page.locator('.record-main').click();
 await expect(page.locator('#modal h2')).toHaveText(fixture.title);
 await expect(page.locator('.value-chip.active')).toHaveCount(0);
 // 点「干货 · 值得复看」：即时保存，toast + chip active
 await page.locator('[data-set-value="gem"]').click();
 await expect(page.locator('#toast')).toContainText('已标记为干货，进入复看清单');
 await expect(page.locator('[data-set-value="gem"]')).toHaveClass(/active/);
 await page.locator('.modal-head').getByRole('button',{name:'关闭',exact:true}).click();
 // 列表卡片带 gem 标识；服务端字段为 value=gem、valueSource=user
 await expect(page.locator('.record-card')).toHaveClass(/gem/);
 await expect(page.locator('.record-card .gem-tag')).toContainText('干货');
 const saved=(await stateOf(request)).records.find(r=>r.id==='fixture');
 expect({value:saved.value,valueSource:saved.valueSource}).toEqual({value:'gem',valueSource:'user'});
 // 切回「日常琐碎」：chip 激活切换、卡片失去 gem 标识、服务端同步
 await page.locator('.record-main').click();
 await page.locator('[data-set-value="daily"]').click();
 await expect(page.locator('#toast')).toContainText('已归为日常琐碎');
 await expect(page.locator('[data-set-value="daily"]')).toHaveClass(/active/);
 await page.locator('.modal-head').getByRole('button',{name:'关闭',exact:true}).click();
 await expect(page.locator('.record-card')).not.toHaveClass(/gem/);
 await expect(page.locator('.gem-tag')).toHaveCount(0);
 const cleared=(await stateOf(request)).records.find(r=>r.id==='fixture');
 expect({value:cleared.value,valueSource:cleared.valueSource}).toEqual({value:'daily',valueSource:'user'});
 expect(errors).toEqual([]);
});
test('weekly digest runs with busy state, falls back deterministically and persists per week',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 // 与应用同款规则动态计算本周周一→周日（本地时区）
 const pad=n=>String(n).padStart(2,'0'),now=new Date(),todayStr=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
 const ws=new Date(todayStr+'T00:00:00');ws.setDate(ws.getDate()-(ws.getDay()+6)%7);
 const we=new Date(ws);we.setDate(we.getDate()+6);
 const fmt=d=>`${d.getMonth()+1}月${d.getDate()}日`,range=`${fmt(ws)}至${fmt(we)}`,wsStr=`${ws.getFullYear()}-${pad(ws.getMonth()+1)}-${pad(ws.getDate())}`;
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[{...fixture,date:todayStr}]}})).ok()).toBeTruthy();
 await page.goto('/');
 // 夹具放在本周，避免测试日期变化后周报卡消失。
 const card=page.locator('.weekly-card');await expect(card).toBeVisible();
 await expect(card.locator('h2')).toContainText(`本周提炼 ${range}`);
 // 卡内主按钮用 .btn-secondary 圈定：提炼完成后卡内会出现「导出」text-btn，getByRole('button') 会二义
 const mainBtn=card.locator('button.btn-secondary');
 await expect(mainBtn).toHaveText('提炼本周');
 // route 延迟 → 点击后出现「提炼中…」禁用中间态（refresh 重渲染后仍保持禁用）
 await page.route('**/api/weekly',async route=>{await new Promise(r=>setTimeout(r,800));await route.continue()});
 await mainBtn.click();
 await expect(mainBtn).toHaveText('提炼中…');
 await expect(mainBtn).toBeDisabled();
 // 完成：降级文本首行 = 周一至周日 + 记录数；随后按钮变「重新提炼本周」
 await expect(card.locator('.digest-text')).toContainText(`${range} · 共 1 段记录`);
 await expect(card.locator('.digest-text')).toContainText(`- ${fmt(now)} · 1 条：演示的学习记录`);
 await expect(page.locator('#toast')).toContainText('本周提炼已生成');
 await expect(mainBtn).toHaveText('重新提炼本周');
 const weekly=(await stateOf(request)).weeklies[wsStr];
 expect(weekly.model).toBe('fallback');expect(weekly.recordCount).toBe(1);expect(weekly.start).toBe(wsStr);
 await page.waitForTimeout(700);await page.screenshot({path:'verification/weekly-card.png'});
 // 按一次「重新提炼本周」：幂等，同周仍只有一份周报
 await mainBtn.click();
 await expect(card.locator('.digest-text')).toContainText(`${range} · 共 1 段记录`);
 expect(Object.keys((await stateOf(request)).weeklies)).toEqual([wsStr]);
 expect(errors).toEqual([]);
});
test('gem review reminder on workspace reviews from home and clears the overdue row',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const pad=n=>String(n).padStart(2,'0'),now=new Date(),todayStr=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
 const old=new Date(now);old.setDate(old.getDate()-14);
 const oldStr=`${old.getFullYear()}-${pad(old.getMonth()+1)}-${pad(old.getDate())}`;
 const stale={...fixture,id:'stale-gem',title:'压箱底的干货',date:oldStr,value:'gem',valueSource:'user'};
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[fixture,stale]}})).ok()).toBeTruthy();
 await page.goto('/');
 // 工作台出现「复看提醒」，逾期天数与应用同款公式动态计算
 const reminder=page.locator('.review-reminder');await expect(reminder).toBeVisible();
 const overdue=Math.round((new Date(todayStr+'T00:00:00')-new Date(oldStr+'T00:00:00'))/864e5);
 await expect(reminder).toContainText('「压箱底的干货」');
 await expect(reminder).toContainText(`${overdue} 天没复看`);
 await page.waitForTimeout(700);await page.screenshot({path:'verification/review-reminder.png'});
 // 行内「复看」在首页生效：详情打开、reviewCount/lastReviewedAt 持久化
 await reminder.locator('[data-review-gem="stale-gem"]').click();
 await expect(page.locator('#modal h2')).toHaveText('压箱底的干货');
 await expect(page.locator('#toast')).toContainText('已记一次复看');
 const saved=(await stateOf(request)).records.find(r=>r.id==='stale-gem');
 expect({reviewed:saved.reviewed,reviewCount:saved.reviewCount,lastReviewedAt:saved.lastReviewedAt}).toEqual({reviewed:true,reviewCount:1,lastReviewedAt:todayStr});
 // 关闭详情回到工作台：逾期清零，该条不再出现在提醒里
 await page.locator('.modal-head').getByRole('button',{name:'关闭',exact:true}).click();
 await expect(page.locator('.review-reminder')).toHaveCount(0);
 expect(errors).toEqual([]);
});
test('gem action checklist toggles done state, counts stay in sync and non-gem actions stay out',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const pad=n=>String(n).padStart(2,'0'),now=new Date(),todayStr=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
 const doneLabel=`${now.getMonth()+1}月${now.getDate()}日 完成`;
 const gem={...fixture,id:'gem-actions',title:'干货行动记录',date:'2026-09-25',time:'09:00',value:'gem',valueSource:'user',actions:['给妈妈打电话','整理会议纪要']};
 const plain={...fixture,id:'plain-actions',title:'普通流水带行动',date:'2026-09-25',time:'15:00',actions:['不该出现的行动']};
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[fixture,gem,plain]}})).ok()).toBeTruthy();
 await page.goto('/');
 await page.locator('.sidebar [data-page="review"]').click();
 // 清单只收 gem 的行动：2 条待办，非 gem 的行动不出现
 const head=page.locator('.section-head').filter({hasText:'接下来 · 干货行动清单'});
 await expect(head).toContainText('2 条待办');
 const list=page.locator('.action-list');
 await expect(list).toContainText('给妈妈打电话');await expect(list).toContainText('整理会议纪要');
 await expect(list).not.toContainText('不该出现的行动');
 await expect(list.locator('.action-row')).toHaveCount(2);
 // 勾选第一条：toast、服务端 doneActions 记录 at=今天、计数变 1、该行进 done 区显示完成日期
 await list.locator('.action-row').filter({hasText:'给妈妈打电话'}).locator('.action-check').click();
 await expect(page.locator('#toast')).toContainText('已标记完成');
 await expect(head).toContainText('1 条待办');
 const row=list.locator('.action-row').filter({hasText:'给妈妈打电话'});
 await expect(row).toHaveClass(/done/);await expect(row).toContainText(doneLabel);
 await expect(list.locator('.action-row').last()).toHaveClass(/done/);await expect(list.locator('.action-row').first()).not.toHaveClass(/done/);
 const entry=(await stateOf(request)).doneActions;
 expect(entry).toEqual([{recordId:'gem-actions',text:'给妈妈打电话',at:todayStr}]);
 await page.waitForTimeout(700);await page.screenshot({path:'verification/action-list.png'});
 // 再点一次：恢复待办、doneActions 清空该条、计数回到 2
 await row.locator('.action-check').click();
 await expect(page.locator('#toast')).toContainText('已恢复待办');
 await expect(head).toContainText('2 条待办');
 await expect(row).not.toHaveClass(/done/);await expect(row).toContainText('来自「干货行动记录」');
 expect((await stateOf(request)).doneActions).toEqual([]);
 expect(errors).toEqual([]);
});
test('compound section lists only gems and re-review bumps counters',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const pad=n=>String(n).padStart(2,'0'),now=new Date(),todayStr=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
 await page.goto('/');
 // 先在详情里把 fixture 标为干货（同 value tagging 用例）
 await page.locator('.record-main').click();
 await page.locator('[data-set-value="gem"]').click();
 await expect(page.locator('[data-set-value="gem"]')).toHaveClass(/active/);
 await page.locator('.modal-head').getByRole('button',{name:'关闭',exact:true}).click();
 // 另恢复一条 gem、一条非 gem（fixture 需一并带上 gem 标记）
 const extraGem={...fixture,id:'extra-gem',title:'另一条干货',date:'2026-09-25',time:'09:00',value:'gem',valueSource:'user'};
 const plain={...fixture,id:'extra-plain',title:'普通流水记录',date:'2026-09-25',time:'15:00'};
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[{...fixture,value:'gem',valueSource:'user'},extraGem,plain]}})).ok()).toBeTruthy();
 await page.goto('/');
 await page.locator('.sidebar [data-page="review"]').click();
 // 顶部「复利 · 值得复看」区只列 gem：两条干货、不含非 gem 记录
 await expect(page.locator('.section-head').filter({hasText:'复利 · 值得复看'})).toBeVisible();
 await expect(page.locator('.section-head').filter({hasText:'复利 · 值得复看'})).toContainText('2 条干货');
 const gemList=page.locator('.record-list').first();
 await expect(gemList.locator('.record-card')).toHaveCount(2);
 await expect(gemList).toContainText('演示的学习记录');await expect(gemList).toContainText('另一条干货');
 await expect(gemList).not.toContainText('普通流水记录');
 await expect(gemList.locator('.review-gem-btn')).toHaveCount(2);
 // 非 gem 记录不受影响：仍在待复盘区
 const pendingList=page.locator('.record-list').nth(1);
 await expect(pendingList).toContainText('普通流水记录');
 // 点「复看」：详情打开、reviewCount/lastReviewedAt/reviewed 持久化、卡片显示复看次数
 await page.locator('[data-review-gem="fixture"]').click();
 await expect(page.locator('#modal h2')).toHaveText(fixture.title);
 await page.locator('.modal-head').getByRole('button',{name:'关闭',exact:true}).click();
 const reviewed=(await stateOf(request)).records.find(r=>r.id==='fixture');
 expect({reviewed:reviewed.reviewed,reviewCount:reviewed.reviewCount,lastReviewedAt:reviewed.lastReviewedAt}).toEqual({reviewed:true,reviewCount:1,lastReviewedAt:todayStr});
 await expect(page.locator('.record-card').filter({hasText:'演示的学习记录'}).locator('.review-count')).toHaveText('复看 1 次');
 // 复盘后 gem 仍在复利区，非 gem 依旧在待复盘区
 await expect(page.locator('.record-list').first()).toContainText('演示的学习记录');
 await expect(page.locator('.record-list').nth(1)).toContainText('普通流水记录');
 await page.waitForTimeout(800); // 等复看触发的 optical-reveal 入场动画结束，截图不糊
 await page.screenshot({path:'verification/compound-section.png'});
 expect(errors).toEqual([]);
});
test('monthly digest falls back per week chunks and all three cards export markdown',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const pad=n=>String(n).padStart(2,'0'),now=new Date(),todayStr=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
 const monthISO=todayStr.slice(0,7),monthLabel=`${now.getMonth()+1}月`,dayLabel=`${now.getMonth()+1}月${now.getDate()}日`;
 const lastDay=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
 // 与应用同款规则动态计算本周一→周日，以及本月包含 26 日的周切块（fixture 固定在 2026-09-26）
 const ws=new Date(todayStr+'T00:00:00');ws.setDate(ws.getDate()-(ws.getDay()+6)%7);
 const we=new Date(ws);we.setDate(we.getDate()+6);
 const fmt=d=>`${d.getMonth()+1}月${d.getDate()}日`,range=`${fmt(ws)}至${fmt(we)}`;
 const wsStr=`${ws.getFullYear()}-${pad(ws.getMonth()+1)}-${pad(ws.getDate())}`,weStr=`${we.getFullYear()}-${pad(we.getMonth()+1)}-${pad(we.getDate())}`;
 const inWeek=['2026-09-26',todayStr].filter(d=>d>=wsStr&&d<=weStr).length;
 const d26=new Date(now.getFullYear(),now.getMonth(),26),chunkStart=26-((d26.getDay()+6)%7),chunkEnd=Math.min(lastDay,chunkStart+6);
 await page.goto('/');
 // 月度卡：本月（fixture 所在月）有记录 → 出现「本月提炼」卡与「提炼本月」按钮
 const card=page.locator('.monthly-card');await expect(card).toBeVisible();
 await expect(card.locator('h2')).toContainText(`本月提炼 ${monthLabel}`);
 await expect(card.locator('.digest-hint')).toContainText('本月已有 1 段记录');
 // route 延迟 → 「提炼中…」禁用中间态
 await page.route('**/api/monthly',async route=>{await new Promise(r=>setTimeout(r,800));await route.continue()});
 const mainBtn=card.locator('button.btn-secondary');
 await expect(mainBtn).toHaveText('提炼本月');
 await mainBtn.click();
 await expect(mainBtn).toHaveText('提炼中…');
 await expect(mainBtn).toBeDisabled();
 // 完成：降级文本首行「9月 · 共 1 段记录」+ 按周切块行；按钮变「重新提炼本月」
 await expect(card.locator('.digest-text')).toContainText(`${monthLabel} · 共 1 段记录`);
 expect((await card.locator('.digest-text').textContent()).startsWith(`${monthLabel} · 共 1 段记录`)).toBeTruthy();
 await expect(card.locator('.digest-text')).toContainText(`- ${monthLabel}${chunkStart}日至${monthLabel}${chunkEnd}日 · 1 条：演示的学习记录`);
 await expect(page.locator('#toast')).toContainText('本月提炼已生成');
 await expect(mainBtn).toHaveText('重新提炼本月');
 const monthly=(await stateOf(request)).monthlies[monthISO];
 expect(monthly.model).toBe('fallback');expect(monthly.recordCount).toBe(1);expect(monthly.month).toBe(monthISO);
 expect(monthly.start).toBe(`${monthISO}-01`);expect(monthly.end).toBe(`${monthISO}-${pad(lastDay)}`);
 await page.waitForTimeout(700);await page.screenshot({path:'verification/monthly-card.png'});
 // 导出月报：文件名 声迹月报-9月.md，内容以「# 本月提炼 9月」开头
 let dl=page.waitForEvent('download');
 await card.locator('[data-export="monthly"]').click();
 let download=await dl;
 expect(download.suggestedFilename()).toBe(`声迹月报-${monthLabel}.md`);
 let text=fs.readFileSync(await download.path(),'utf8');
 expect(text.startsWith(`# 本月提炼 ${monthLabel}\n\n`),'monthly export head').toBeTruthy();
 expect(text).toContain(`${monthLabel} · 共 1 段记录`);
 // 今日卡：先补一条今天、带摘要的记录（降级行格式为「- 标题 — 摘要」）→ 提炼今天 → 导出。之前用例可能已生成今日提炼，按钮文案两种都接受
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[fixture,{...fixture,id:'fixture-today2',title:'今天的收尾',date:todayStr,time:'21:00',transcript:'今天完成了月度验证的收尾。',summary:'月度验证收尾完成'}]}})).ok()).toBeTruthy();
 await page.reload();
 const todayCard=page.locator('.digest-card:not(.weekly-card):not(.monthly-card):not(.yearly-card)');
 const todayBtn=todayCard.locator('button.btn-secondary');
 await expect(todayBtn).toHaveText(/^(重新提炼|提炼今天)$/);
 await todayBtn.click();
 await expect(todayCard.locator('.digest-text')).toContainText(`${dayLabel} · 共 1 段记录`);
 await expect(todayCard.locator('.digest-text')).toContainText('- 今天的收尾 — 月度验证收尾完成');
 dl=page.waitForEvent('download');
 await todayCard.locator('[data-export="digest"]').click();
 download=await dl;
 expect(download.suggestedFilename()).toBe(`声迹今日提炼-${dayLabel}.md`);
 text=fs.readFileSync(await download.path(),'utf8');
 expect(text.startsWith(`# 今日提炼 ${dayLabel}\n\n`),'daily export head').toBeTruthy();
 // 本周卡：先「提炼本周」（此前用例可能已生成周报），记录数按本周实际条数动态计算
 const weeklyCard=page.locator('.weekly-card');
 await expect(weeklyCard.locator('h2')).toContainText(`本周提炼 ${range}`);
 const weeklyBtn=weeklyCard.locator('button.btn-secondary');
 await expect(weeklyBtn).toHaveText(/^(重新)?提炼本周$/);
 await weeklyBtn.click();
 await expect.poll(async()=>((await stateOf(request)).weeklies[wsStr]||{}).recordCount).toBe(inWeek);
 await expect(weeklyCard.locator('.digest-text')).toContainText(`${range} · 共 ${inWeek} 段记录`);
 dl=page.waitForEvent('download');
 await weeklyCard.locator('[data-export="weekly"]').click();
 download=await dl;
 expect(download.suggestedFilename()).toBe(`声迹周报-${range}.md`);
 text=fs.readFileSync(await download.path(),'utf8');
 expect(text.startsWith(`# 本周提炼 ${range}\n\n`),'weekly export head').toBeTruthy();
 expect(errors).toEqual([]);
});
test('gem tags round-trip through PUT, re-render active state and card mini tag',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');
 await page.locator('.record-main').click();
 await expect(page.locator('#modal h2')).toHaveText(fixture.title);
 // 先标为干货：gem 标签行出现，五枚固定 chip
 await page.locator('[data-set-value="gem"]').click();
 await expect(page.locator('[data-set-value="gem"]')).toHaveClass(/active/);
 const row=page.locator('.gem-tag-row');
 await expect(row).toBeVisible();
 await expect(row).toContainText('干货标签');
 await expect(row.locator('.gem-tag-chip')).toHaveText(['方法论','人脉','决策','知识点','金句']);
 // 点「方法论」：toast、chip active、PUT 往返后服务端 gemTags=['方法论']
 await row.locator('[data-gem-tag="方法论"]').click();
 await expect(page.locator('#toast')).toContainText('已加上「方法论」标签');
 await expect(page.locator('[data-gem-tag="方法论"]')).toHaveClass(/active/);
 await page.waitForTimeout(700);
 await page.screenshot({path:'verification/gem-tags.png'});
 const saved=(await stateOf(request)).records.find(r=>r.id==='fixture');
 expect(saved.gemTags).toEqual(['方法论']);
 // 关闭详情：列表卡片显示 gem-mini-tag「方法论」
 await page.locator('.modal-head').getByRole('button',{name:'关闭',exact:true}).click();
 await expect(page.locator('.record-card').first()).toHaveClass(/gem/);
 await expect(page.locator('.record-card .gem-mini-tag')).toHaveText('方法论');
 // 重新打开详情：renderDetail 从服务端状态恢复 active 态；再点同 chip → 移除
 await page.locator('.record-main').click();
 await expect(page.locator('#modal h2')).toHaveText(fixture.title);
 await expect(page.locator('[data-gem-tag="方法论"]')).toHaveClass(/active/);
 await page.locator('[data-gem-tag="方法论"]').click();
 await expect(page.locator('#toast')).toContainText('已移除「方法论」标签');
 await expect(page.locator('[data-gem-tag="方法论"]')).not.toHaveClass(/active/);
 const cleared=(await stateOf(request)).records.find(r=>r.id==='fixture');
 expect(cleared.gemTags).toEqual([]);
 expect(errors).toEqual([]);
});
test('compound gem tag filter narrows gem list and count but keeps action list intact',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const gemA={...fixture,id:'gem-method',title:'方法干货',date:'2026-09-25',time:'09:00',value:'gem',valueSource:'user',gemTags:['方法论'],actions:['把方法沉淀成检查清单']};
 const gemB={...fixture,id:'gem-network',title:'人脉干货',date:'2026-09-24',time:'14:00',value:'gem',valueSource:'user',gemTags:['人脉'],actions:['给贵人发感谢信息']};
 const plain={...fixture,id:'gem-plain',title:'普通流水记录',date:'2026-09-23',time:'20:00'};
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[gemA,gemB,plain]}})).ok()).toBeTruthy();
 await page.goto('/');
 await page.locator('.sidebar [data-page="review"]').click();
 const compoundHead=page.locator('.section-head').filter({hasText:'复利 · 值得复看'});
 const filterRow=page.locator('.tag-filter-row');
 const gemList=page.locator('.record-list').first();
 // 筛选行只列已用标签：全部/方法论/人脉，没有「决策」；默认全部 2 条
 await expect(compoundHead).toContainText('2 条干货');
 await expect(filterRow.locator('.chip')).toHaveText(['全部','方法论','人脉']);
 await expect(filterRow.locator('[data-gem-filter=""]')).toHaveClass(/active/);
 await expect(gemList.locator('.record-card')).toHaveCount(2);
 await expect(gemList).toContainText('方法干货');await expect(gemList).toContainText('人脉干货');
 await expect(gemList).not.toContainText('普通流水记录');
 // 点「方法论」：列表 1 条、计数变「1 条干货」
 await filterRow.locator('[data-gem-filter="方法论"]').click();
 await expect(filterRow.locator('[data-gem-filter="方法论"]')).toHaveClass(/active/);
 await expect(compoundHead).toContainText('1 条干货');
 await expect(gemList.locator('.record-card')).toHaveCount(1);
 await expect(gemList).toContainText('方法干货');
 await expect(gemList).not.toContainText('人脉干货');
 // 行动清单不受筛选影响：两条 gem 的 actions 仍全部显示
 const actionHead=page.locator('.section-head').filter({hasText:'接下来 · 干货行动清单'});
 await expect(actionHead).toContainText('2 条待办');
 const actionList=page.locator('.action-list');
 await expect(actionList).toContainText('把方法沉淀成检查清单');
 await expect(actionList).toContainText('给贵人发感谢信息');
 await expect(actionList.locator('.action-row')).toHaveCount(2);
 await page.waitForTimeout(700);await page.screenshot({path:'verification/compound-filter.png'});
 // 点「全部」恢复 2 条
 await filterRow.locator('[data-gem-filter=""]').click();
 await expect(filterRow.locator('[data-gem-filter=""]')).toHaveClass(/active/);
 await expect(compoundHead).toContainText('2 条干货');
 await expect(gemList.locator('.record-card')).toHaveCount(2);
 expect(errors).toEqual([]);
});
test('yearly digest runs with busy state, falls back deterministically and exports the year report',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const yearStr=String(new Date().getFullYear());
 await page.goto('/');
 // 工作台出现「年度回顾」卡（fixture 在今年）：提示今年已有 1 段记录，按钮「提炼今年」
 const card=page.locator('.yearly-card');await expect(card).toBeVisible();
 await expect(card.locator('h2')).toContainText(`年度回顾 ${yearStr}年`);
 await expect(card.locator('.digest-hint')).toContainText('今年已有 1 段记录');
 // route 延迟 → 点击后出现「提炼中…」禁用中间态（refresh 重渲染后仍保持禁用）
 await page.route('**/api/yearly',async route=>{await new Promise(r=>setTimeout(r,800));await route.continue()});
 const mainBtn=card.locator('button.btn-secondary');
 await expect(mainBtn).toHaveText('提炼今年');
 await mainBtn.click();
 await expect(mainBtn).toHaveText('提炼中…');
 await expect(mainBtn).toBeDisabled();
 // 完成：降级文本首行「2026年 · 共 1 段记录」+ 逐月行；按钮变「重新提炼今年」
 await expect(card.locator('.digest-text')).toContainText(`${yearStr}年 · 共 1 段记录`);
 expect((await card.locator('.digest-text').textContent()).startsWith(`${yearStr}年 · 共 1 段记录`),'yearly first line').toBeTruthy();
 await expect(card.locator('.digest-text')).toContainText('- 9月 · 1 条：演示的学习记录');
 await expect(page.locator('#toast')).toContainText('年度回顾已生成');
 await expect(mainBtn).toHaveText('重新提炼今年');
 const yearly=(await stateOf(request)).yearlies[yearStr];
 expect(yearly.model).toBe('fallback');expect(yearly.recordCount).toBe(1);expect(yearly.year).toBe(yearStr);
 expect(yearly.start).toBe(`${yearStr}-01-01`);expect(yearly.end).toBe(`${yearStr}-12-31`);
 await page.waitForTimeout(700);await page.screenshot({path:'verification/yearly-card.png'});
 // 导出年报：文件名 声迹年报-2026年.md，内容以「# 年度回顾 2026年」开头
 const dl=page.waitForEvent('download');
 await card.locator('[data-export="yearly"]').click();
 const download=await dl;
 expect(download.suggestedFilename()).toBe(`声迹年报-${yearStr}年.md`);
 const text=fs.readFileSync(await download.path(),'utf8');
 expect(text.startsWith(`# 年度回顾 ${yearStr}年\n\n`),'yearly export head').toBeTruthy();
 expect(text).toContain(`${yearStr}年 · 共 1 段记录`);
 expect(errors).toEqual([]);
});
for(const day of [29,30])test(`month heatmap colors, filters and future-day boundary on September ${day}`,async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const pad=n=>String(n).padStart(2,'0'),now=new Date(2026,8,day,12),todayStr=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
 const tm=new Date(now);tm.setDate(tm.getDate()+1);
 const tomorrow=`${tm.getFullYear()}-${pad(tm.getMonth()+1)}-${pad(tm.getDate())}`;
 await page.clock.setFixedTime(now);
 await page.goto('/');
 await page.locator('[data-page="timeline"]').click();
 // 每日足迹页面顶部出现「本月足迹」热力卡，统计行含本月段数
 const card=page.locator('.heatmap-card');await expect(card).toBeVisible();
 await expect(card.locator('h2')).toHaveText('本月足迹');
 await expect(card.locator('.heat-head span')).toContainText('本月 1 段 · 1 天有声');
 // 9 月 30 天 + 起始偏移 → 至少 28 个格子
 expect(await card.locator('.heat-cell').count()).toBeGreaterThanOrEqual(28);
 // fixture 所在 9-26 有 1 条记录 → h1；今天无记录 → h0
 const cell=card.locator('[data-date="2026-09-26"]');
 await expect(cell).toHaveClass(/h1/);
 await expect(card.locator(`[data-date="${todayStr}"]`)).toHaveClass(/h0/);
 // 等导航触发的入场动画结束并滚到热力卡，截图才能看清着色格子
 await page.waitForTimeout(700);
 await page.locator('.heatmap-card').scrollIntoViewIfNeeded();
 await page.screenshot({path:'verification/heatmap.png'});
 // 点 9-26 格子：出现带日期的清除 chip（复用 selectedDate 机制）且列表过滤到该日
 await cell.click();
 const chip=page.locator('[data-clear-date]');await expect(chip).toBeVisible();
 await expect(chip).toContainText('2026-09-26');
 await expect(page.locator('.timeline-group')).toHaveCount(1);
 await expect(page.locator('.timeline-group h2').first()).toContainText('2026-09-26');
 await expect(page.locator('.record-title')).toHaveText('演示的学习记录');
 // 点清除 chip：恢复完整列表
 await chip.click();await expect(page.locator('[data-clear-date]')).toHaveCount(0);
 await expect(page.locator('.timeline-group')).toHaveCount(1);
 // 同月的明天禁用；月末的明天属于下个月，不应出现在本月热力图。
 const tomorrowCell=card.locator(`[data-date="${tomorrow}"]`);
 if(tm.getMonth()===now.getMonth())await expect(tomorrowCell).toBeDisabled();else await expect(tomorrowCell).toHaveCount(0);
 expect(errors).toEqual([]);
});
test('gem flash card stays stable across re-renders, swaps on demand and reviews in place',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const pad=n=>String(n).padStart(2,'0'),now=new Date(),todayStr=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
 const gemA={...fixture,id:'flash-gem-a',title:'方法论干货甲',date:'2026-09-25',time:'09:00',value:'gem',valueSource:'user',gemTags:['方法论'],summary:'拆解任务的方法论'};
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[fixture,gemA]}})).ok()).toBeTruthy();
 await page.goto('/');
 // 工作台出现「随机回顾」卡，展示该干货的标题与方法论标签
 const flash=page.locator('.gem-flash');await expect(flash).toBeVisible();
 await expect(flash.locator('h2')).toHaveText('随机回顾');
 const flashTitle=flash.locator('.gem-flash-title');
 await expect(flashTitle).toHaveText('方法论干货甲');
 await expect(flash.locator('.gem-mini-tag')).toHaveText('方法论');
 // 3 秒内经历一次重渲染（导航回工作台触发 render）＋轮询 tick：标题必须稳定不变（10 分钟窗口）
 const firstTitle=await flashTitle.textContent();
 await page.waitForTimeout(1500);
 await page.locator('.sidebar [data-page="home"]').click();
 await page.waitForTimeout(1500);
 await expect(flash.locator('.gem-flash-title')).toHaveText(firstTitle);
 // 单条干货点「换一条」：池子里只有它，标题可以不变，卡片仍稳定渲染
 await flash.locator('[data-flash-another]').click();
 await expect(flash.locator('.gem-flash-title')).toHaveText('方法论干货甲');
 // 恢复第二条干货 → 点「换一条」必须换成另一条
 const gemB={...fixture,id:'flash-gem-b',title:'决策干货乙',date:'2026-09-24',time:'14:00',value:'gem',valueSource:'user',gemTags:['决策'],summary:'一次关于优先级的决策'};
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[fixture,gemA,gemB]}})).ok()).toBeTruthy();
 await page.reload();
 const flashed=page.locator('.gem-flash .gem-flash-title');
 await expect(flashed).toHaveText(/干货/);
 const before=await flashed.textContent();
 await page.locator('[data-flash-another]').click();
 await expect(flashed).not.toHaveText(before);
 const after=await flashed.textContent();
 await page.waitForTimeout(700);await page.screenshot({path:'verification/gem-flash.png'});
 // 点「复看」：详情打开被闪卡的那条，reviewCount/lastReviewedAt 持久化为 1 / 今天
 await page.locator('.gem-flash [data-review-gem]').click();
 await expect(page.locator('#modal h2')).toHaveText(after);
 const reviewed=(await stateOf(request)).records.find(r=>r.title===after);
 expect(reviewed.reviewCount).toBe(1);expect(reviewed.lastReviewedAt).toBe(todayStr);expect(reviewed.reviewed).toBe(true);
 expect(errors).toEqual([]);
});


test('detail navigation asks before discarding a draft and cancellation keeps its fields',async({page,request})=>{
 const older={...fixture,id:'draft-older',title:'下一段记录',date:'2026-09-25'};
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[fixture,older]}})).ok()).toBeTruthy();
 await page.goto('/');await page.locator('.record-main').first().click();
 await page.locator('#edit-title').fill('还没保存的标题');await page.locator('#edit-summary').fill('还没保存的摘要');
 let canceled=0;const dismiss=async dialog=>{canceled++;await dialog.dismiss()};page.on('dialog',dismiss);
 await page.getByRole('button',{name:'下一条记录',exact:true}).click();
 await expect(page.locator('#edit-title')).toHaveValue('还没保存的标题');await expect(page.locator('#edit-summary')).toHaveValue('还没保存的摘要');expect(canceled).toBe(1);
 page.off('dialog',dismiss);page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'下一条记录',exact:true}).click();await expect(page.locator('#modal h2')).toHaveText(older.title);
 await page.getByRole('button',{name:'上一条记录',exact:true}).click();await expect(page.locator('#edit-title')).toHaveValue(fixture.title);
 expect((await stateOf(request)).records.find(r=>r.id===fixture.id).summary).toBe(fixture.summary);
});

test('detail metadata updates preserve draft edits including typing during an in-flight tag save',async({page,request})=>{
 const dialogs=[];page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss()});
 await page.goto('/');await page.locator('.record-main').click();
 await page.locator('#edit-title').fill('保留这个草稿标题');await page.locator('#edit-summary').fill('先写的摘要');
 await page.locator('[data-set-value="gem"]').click();await expect(page.locator('[data-set-value="gem"]')).toHaveClass(/active/);
 await expect(page.locator('#edit-title')).toHaveValue('保留这个草稿标题');await expect(page.locator('#edit-summary')).toHaveValue('先写的摘要');
 const beforeTag=(await stateOf(request)).records.find(r=>r.id===fixture.id);expect(beforeTag.title).toBe(fixture.title);expect(beforeTag.summary).toBe(fixture.summary);
 let release;const gate=new Promise(resolve=>{release=resolve});
 await page.route('**/api/records',async route=>{if(route.request().method()==='PUT'){await gate}await route.continue()});
 await page.locator('[data-gem-tag="方法论"]').click();await expect(page.getByRole('button',{name:'保存整理',exact:true})).toBeDisabled();
 await page.locator('#edit-summary').fill('标签保存期间继续输入的摘要');await page.locator('#edit-summary').evaluate(el=>el.setSelectionRange(3,6));
 release();await expect(page.locator('[data-gem-tag="方法论"]')).toHaveClass(/active/);
 await expect(page.locator('#edit-title')).toHaveValue('保留这个草稿标题');await expect(page.locator('#edit-summary')).toHaveValue('标签保存期间继续输入的摘要');await expect(page.locator('#edit-summary')).toBeFocused();
 expect(await page.locator('#edit-summary').evaluate(el=>[el.selectionStart,el.selectionEnd])).toEqual([3,6]);expect(dialogs).toEqual([]);
 await page.getByRole('button',{name:'保存整理',exact:true}).click();await expect(page.locator('#modal')).not.toBeVisible();
 const saved=(await stateOf(request)).records.find(r=>r.id===fixture.id);expect(saved.title).toBe('保留这个草稿标题');expect(saved.summary).toBe('标签保存期间继续输入的摘要');expect(saved.gemTags).toEqual(['方法论']);expect(saved.value).toBe('gem');
});

test('detail drafts survive polling and canceled native record or import navigation',async({page,request})=>{
 const other={...fixture,id:'native-target',title:'外部打开的记录',date:'2026-09-25'};
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[fixture,other]}})).ok()).toBeTruthy();
 await page.goto('/');await page.locator('.record-main').first().click();await page.locator('#edit-summary').fill('后台刷新时保留的草稿');
 const latest=(await stateOf(request)).records.find(r=>r.id===other.id);
 expect((await request.put('/api/records',{headers,data:{...latest,title:'后台更新完成'}})).ok()).toBeTruthy();
 await expect(page.locator('.record-title').filter({hasText:'后台更新完成'})).toHaveCount(1,{timeout:6000});
 await expect(page.locator('#edit-summary')).toHaveValue('后台刷新时保留的草稿');expect(await page.evaluate(()=>window.__shengjiHasUnsavedChanges())).toBe(true);
 let canceled=0;page.on('dialog',async dialog=>{canceled++;await dialog.dismiss()});
 for(const name of ['shengji-open-record','shengji-import-result']){
  await page.evaluate(({name,id})=>window.dispatchEvent(new CustomEvent(name,{detail:{id}})),{name,id:other.id});
  await expect.poll(()=>canceled).toBe(name==='shengji-open-record'?1:2);
  await expect(page.locator('#modal h2')).toHaveText(fixture.title);await expect(page.locator('#edit-summary')).toHaveValue('后台刷新时保留的草稿');
 }
 await page.getByRole('button',{name:'保存整理',exact:true}).click();await expect(page.locator('#modal')).not.toBeVisible();
 expect((await stateOf(request)).records.find(r=>r.id===fixture.id).summary).toBe('后台刷新时保留的草稿');
});


test('completed audio leaves pairing mode so later pasted text saves as a separate record',async({page,request})=>{
 const bytes=Buffer.alloc(44);bytes.write('RIFF',0);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);
 let failFirst=true;
 await page.route('**/api/import-audio',async route=>{
  if(failFirst){failFirst=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试暂时不可用，请重试'})})}
  else await route.continue();
 });
 await page.goto('/');await page.getByRole('button',{name:'导入录音 / 文字',exact:true}).click();
 await page.locator('#file-input').setInputFiles({name:'配套录音.wav',mimeType:'audio/wav',buffer:bytes});
 await expect(page.locator('#pairing-note')).toContainText('配套文字稿');await page.locator('#import-submit').click();
 await expect(page.locator('.import-queue-row.failed')).toHaveCount(1);await expect(page.locator('#pairing-note')).toContainText('配套文字稿');
 await page.locator('#transcript-input').fill('这段文字是失败音频重试时补充的配套稿。');await page.locator('#import-submit').click();
 await expect(page.locator('.import-queue-row.done')).toHaveCount(1);await expect(page.locator('#transcript-input')).toHaveValue('');await expect(page.locator('#pairing-note')).toContainText('文字会单独保存');
 await page.locator('#transcript-input').fill('这是音频保存完成后单独追加的一段文字。');await page.locator('#import-submit').click();
 await expect(page.locator('#transcript-input')).toHaveValue('');
 const stored=(await stateOf(request)).records;const audio=stored.filter(r=>r.audio);expect(audio).toHaveLength(1);expect(audio[0].transcript).toBe('这段文字是失败音频重试时补充的配套稿。');
 expect(stored.filter(r=>r.transcript==='这是音频保存完成后单独追加的一段文字。')).toHaveLength(1);expect(stored).toHaveLength(3);
});


test('detail save locks editing and native navigation until failure or success, then restores the draft',async({page,request})=>{
 const other={...fixture,id:'saving-target',title:'保存期间不能打开的记录',date:'2026-09-25'};
 expect((await request.post('/api/restore',{headers,data:{version:2,records:[fixture,other]}})).ok()).toBeTruthy();
 let release;let pending=new Promise(resolve=>{release=resolve});let attempt=0;
 await page.route('**/api/records',async route=>{
  if(route.request().method()!=='PUT')return route.continue();
  attempt++;await pending;
  if(attempt===1)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'保存暂时失败，请重试'})});else await route.continue();
 });
 const dialogs=[];page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss()});
 await page.goto('/');await page.locator('.record-main').first().click();await page.locator('#edit-summary').fill('请求失败也必须保留的摘要');
 await page.getByRole('button',{name:'保存整理',exact:true}).click();
 await expect(page.locator('#edit-summary')).toBeDisabled();await expect(page.locator('[data-nav-record]')).toBeDisabled();await expect(page.locator('[data-close]')).toBeDisabled();await expect(page.locator('[data-set-value="gem"]')).toBeDisabled();
 await page.keyboard.type('保存期间误按的键');await page.keyboard.press('Escape');await expect(page.locator('#modal')).toBeVisible();await expect(page.locator('#edit-summary')).toHaveValue('请求失败也必须保留的摘要');
 await page.evaluate(id=>window.dispatchEvent(new CustomEvent('shengji-open-record',{detail:{id}})),other.id);await expect(page.locator('#toast')).toContainText('正在保存整理');await expect(page.locator('#modal h2')).toHaveText(fixture.title);
 release();await expect(page.locator('#toast')).toContainText('保存暂时失败');await expect(page.locator('#edit-summary')).toBeEnabled();await expect(page.locator('#edit-summary')).toHaveValue('请求失败也必须保留的摘要');await expect(page.getByRole('button',{name:'保存整理',exact:true})).toBeEnabled();await expect(page.locator('[data-nav-record]')).toBeEnabled();
 pending=new Promise(resolve=>{release=resolve});await page.locator('#edit-summary').fill('失败后继续修改并成功保存的摘要');await page.getByRole('button',{name:'保存整理',exact:true}).click();
 await expect(page.locator('#edit-summary')).toBeDisabled();await page.evaluate(id=>window.dispatchEvent(new CustomEvent('shengji-import-result',{detail:{id}})),other.id);await expect(page.locator('#toast')).toContainText('正在保存整理');await expect(page.locator('#modal h2')).toHaveText(fixture.title);
 release();await expect(page.locator('#modal')).not.toBeVisible();
 const saved=(await stateOf(request)).records;expect(saved.find(r=>r.id===fixture.id).summary).toBe('失败后继续修改并成功保存的摘要');expect(saved.find(r=>r.id===other.id).summary).toBe(fixture.summary);expect(dialogs).toEqual([]);
});
