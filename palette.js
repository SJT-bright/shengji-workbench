let deps=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pages=[['home','我的工作台','grid'],['all','全部记录','folder'],['timeline','每日足迹','clock'],['review','复盘与学习','book'],['recaps','回顾档案','calendar'],['favorites','我的收藏','star'],['queue','处理队列','list'],['ask','问录音','spark'],['connections','应用关联','link']];
const rowOf=(id,attrs,ic,label,small)=>`<button type="button" class="palette-row" id="${id}" role="option" aria-selected="false" ${attrs}>${ic}<span>${esc(label)}</span>${small?`<small>${esc(small)}</small>`:''}</button>`;
function draw(results,input){
 const icon=deps.icon||(()=>' '),q=input.value.trim().toLowerCase(),hit=s=>String(s??'').toLowerCase().includes(q);
 const cats=deps.getCategories?deps.getCategories():[];
 const go=[...pages.map(([id,label,ic])=>({attrs:`data-palette-page="${esc(id)}"`,ic:icon(ic),label})),...cats.map(c=>({attrs:`data-palette-page="${esc(c.id)}"`,ic:icon(c.icon||'folder'),label:c.name}))].filter(p=>!q||hit(p.label));
 const acts=(deps.actions||[]).map((a,i)=>({attrs:`data-palette-action="${i}"`,ic:icon(a.icon||'spark'),label:a.label})).filter(a=>!q||hit(a.label));
 const recs=(deps.getRecords?deps.getRecords():[]).slice().sort((a,b)=>String(b.date+b.time).localeCompare(String(a.date+a.time))).filter(r=>!q||hit(r.title)||hit(r.summary)||hit(r.transcript)).slice(0,q?8:5);
 let html='',n=0;const nextId=()=>`palette-opt-${n++}`;
 if(go.length)html+=`<div class="palette-section">前往</div>`+go.map(p=>rowOf(nextId(),p.attrs,p.ic,p.label)).join('');
 if(acts.length)html+=`<div class="palette-section">操作</div>`+acts.map(a=>rowOf(nextId(),a.attrs,a.ic,a.label)).join('');
 if(recs.length)html+=`<div class="palette-section">记录</div>`+recs.map(r=>{const c=cats.find(c=>c.id===r.category);return rowOf(nextId(),`data-palette-record="${esc(r.id)}"`,icon(c?c.icon:'file'),r.title,`${r.date||''}${r.date?' · ':''}${String(r.summary||r.transcript||'').slice(0,40)}`)}).join('');
 results.innerHTML=html||`<div class="palette-empty">${icon('search')}<p>没有匹配的结果</p></div>`;
}
export function bindPalette(d){deps=d}
export function openPalette(){
 if(!deps||!deps.dialog)return;
 const dialog=deps.dialog,icon=deps.icon||(()=>' ');
 dialog.innerHTML=`<div class="palette-panel"><div class="palette-head">${icon('search')}<input id="palette-input" type="text" role="combobox" aria-expanded="true" aria-controls="palette-results" aria-autocomplete="list" placeholder="搜索记录，或跳转到任意页面" autocomplete="off"><button type="button" class="icon-btn" data-palette-close aria-label="关闭">${icon('close')}</button></div><div class="palette-body" id="palette-results" role="listbox" aria-label="查找结果"></div></div><div class="palette-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>esc</kbd> 关闭</span><span class="palette-foot-spacer"></span><span><kbd>⌘P</kbd> 随时呼出</span></div>`;
 const input=dialog.querySelector('#palette-input'),results=dialog.querySelector('#palette-results');
 const rows=()=>[...results.querySelectorAll('.palette-row')];
 let active=-1;
 const setActive=(i,scroll=true)=>{
  const rs=rows();
  if(!rs.length){active=-1;input.removeAttribute('aria-activedescendant');return}
  active=((i%rs.length)+rs.length)%rs.length;
  rs.forEach((r,j)=>{const on=j===active;r.classList.toggle('active',on);r.setAttribute('aria-selected',on?'true':'false')});
  input.setAttribute('aria-activedescendant',rs[active].id);
  if(scroll)rs[active].scrollIntoView({block:'nearest'});
 };
 const activate=row=>{
  if(row.dataset.palettePage){deps.goto&&deps.goto(row.dataset.palettePage)}
  else if(row.dataset.paletteRecord){deps.openRecord&&deps.openRecord(row.dataset.paletteRecord)}
  else{const a=(deps.actions||[])[+row.dataset.paletteAction];a&&a.run&&a.run()}
  dialog.close();
 };
 dialog.onclick=e=>{if(e.target===dialog)return dialog.close();const row=e.target.closest('[data-palette-page],[data-palette-record],[data-palette-action]');if(row)return activate(row);if(e.target.closest('[data-palette-close]'))dialog.close()};
 dialog.onkeydown=e=>{
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setActive(active<0?0:active+(e.key==='ArrowDown'?1:-1))}
  else if(e.target!==input&&e.key==='Home'){e.preventDefault();setActive(0)}
  else if(e.target!==input&&e.key==='End'){e.preventDefault();setActive(-1)}
  else if(e.key==='Enter'){
   if(e.target.closest?.('.palette-row'))return;
   const rs=rows();if(!rs.length)return;
   e.preventDefault();activate(rs[active>=0?active:0]);
  }
 };
 results.onmouseover=e=>{const row=e.target.closest('.palette-row');if(row){const i=rows().indexOf(row);if(i!==active)setActive(i,false)}};
 input.oninput=()=>{draw(results,input);setActive(0,false)};
 draw(results,input);
 setActive(0,false);
 if(!dialog.open)dialog.showModal();
 input.focus();input.select();
}
