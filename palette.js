let deps=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pages=[['home','我的工作台','grid'],['all','全部记录','folder'],['timeline','每日足迹','clock'],['review','复盘与学习','book'],['favorites','我的收藏','star'],['queue','处理队列','clock'],['ask','问录音','spark'],['connections','应用关联','grid']];
const rowOf=(attrs,ic,label,small)=>`<button type="button" class="palette-row" ${attrs}>${ic}<span>${esc(label)}</span>${small?`<small>${esc(small)}</small>`:''}</button>`;
function draw(results,input){
 const icon=deps.icon||(()=>' '),q=input.value.trim().toLowerCase(),hit=s=>String(s??'').toLowerCase().includes(q);
 const cats=deps.getCategories?deps.getCategories():[];
 const go=[...pages.map(([id,label,ic])=>({attrs:`data-palette-page="${esc(id)}"`,ic:icon(ic),label})),...cats.map(c=>({attrs:`data-palette-page="${esc(c.id)}"`,ic:icon(c.icon||'folder'),label:c.name}))].filter(p=>!q||hit(p.label));
 const acts=(deps.actions||[]).map((a,i)=>({attrs:`data-palette-action="${i}"`,ic:icon(a.icon||'spark'),label:a.label})).filter(a=>!q||hit(a.label));
 const recs=(deps.getRecords?deps.getRecords():[]).slice().sort((a,b)=>String(b.date+b.time).localeCompare(String(a.date+a.time))).filter(r=>!q||hit(r.title)||hit(r.summary)||hit(r.transcript)).slice(0,q?8:5);
 let html='';
 if(go.length)html+=`<div class="palette-section">前往</div>`+go.map(p=>rowOf(p.attrs,p.ic,p.label)).join('');
 if(acts.length)html+=`<div class="palette-section">操作</div>`+acts.map(a=>rowOf(a.attrs,a.ic,a.label)).join('');
 if(recs.length)html+=`<div class="palette-section">记录</div>`+recs.map(r=>{const c=cats.find(c=>c.id===r.category);return rowOf(`data-palette-record="${esc(r.id)}"`,icon(c?c.icon:'file'),r.title,`${r.date||''}${r.date?' · ':''}${String(r.summary||r.transcript||'').slice(0,40)}`)}).join('');
 results.innerHTML=html||`<p class="palette-empty">没有匹配的结果</p>`;
}
export function bindPalette(d){deps=d}
export function openPalette(){
 if(!deps||!deps.dialog)return;
 const dialog=deps.dialog,icon=deps.icon||(()=>' ');
 dialog.innerHTML=`<div class="palette-panel"><div class="palette-head">${icon('search')}<input id="palette-input" type="text" placeholder="搜索记录，或跳转到任意页面" autocomplete="off"><button type="button" class="icon-btn" data-palette-close aria-label="关闭">${icon('close')}</button></div><div class="palette-body" id="palette-results"></div></div>`;
 const input=dialog.querySelector('#palette-input'),results=dialog.querySelector('#palette-results');
 const activate=row=>{
  if(row.dataset.palettePage){deps.goto&&deps.goto(row.dataset.palettePage)}
  else if(row.dataset.paletteRecord){deps.openRecord&&deps.openRecord(row.dataset.paletteRecord)}
  else{const a=(deps.actions||[])[+row.dataset.paletteAction];a&&a.run&&a.run()}
  dialog.close();
 };
 dialog.onclick=e=>{if(e.target===dialog)return dialog.close();const row=e.target.closest('[data-palette-page],[data-palette-record],[data-palette-action]');if(row)return activate(row);if(e.target.closest('[data-palette-close]'))dialog.close()};
 input.oninput=()=>draw(results,input);
 draw(results,input);
 if(!dialog.open)dialog.showModal();
 input.focus();input.select();
}
