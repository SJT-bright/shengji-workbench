export const categories = [
 {id:'work',name:'工作沟通',color:'#607646',icon:'work'},
 {id:'learn',name:'学习成长',color:'#7a6490',icon:'learn'},
 {id:'life',name:'生活记录',color:'#936535',icon:'life'},
 {id:'idea',name:'灵感随想',color:'#527778',icon:'idea'},
 {id:'meeting',name:'会议纪要',color:'#607646',icon:'work'},
 {id:'project',name:'项目推进',color:'#607646',icon:'folder'},
 {id:'reading',name:'读书笔记',color:'#7a6490',icon:'book'},
 {id:'course',name:'课程学习',color:'#7a6490',icon:'learn'},
 {id:'interview',name:'访谈交流',color:'#527778',icon:'mic'},
 {id:'reflection',name:'个人复盘',color:'#936535',icon:'clock'},
 {id:'inbox',name:'待确认',color:'#817b70',icon:'folder'},
];
export function localDate(date=new Date()){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`}
export function parseTranscript(text,filename=''){
 if(typeof text!=='string')throw new Error('转写内容必须是文字');
 const source=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
 if(!/(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->/.test(source)&&! /\.(srt|vtt)$/i.test(filename)&&!/^WEBVTT(?:\s|$)/.test(source))return source.trim();
 return source.split('\n').filter((line,i,lines)=>!/^WEBVTT(?:\s|$)/.test(line.trim())&&!/^\s*(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->/.test(line)&&!(/^\s*\d+\s*$/.test(line)&&/-->/.test(lines[i+1]||''))).join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function validateRecord(r,catalog=categories){
 if(!r||typeof r!=='object'||Array.isArray(r))throw new Error('记录格式无效');
 for(const k of ['id','title','category','date','time','transcript','summary'])if(typeof r[k]!=='string')throw new Error(`记录字段 ${k} 必须是文字`);
 if(!r.id.trim()||r.id.length>200||!r.title.trim()||r.title.length>200)throw new Error('记录标题或标识无效');
 if(r.transcript.length>500000||r.summary.length>50000)throw new Error('单条记录内容过长');
 if(!catalog.some(c=>c.id===r.category))throw new Error('记录分类无效');
 const date=new Date(`${r.date}T12:00:00`);if(!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||Number.isNaN(+date)||localDate(date)!==r.date||!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time))throw new Error('记录日期或时间无效');
 if(typeof r.duration!=='number'||!Number.isFinite(r.duration)||r.duration<0||r.duration>100000)throw new Error('录音时长无效');
 for(const k of ['highlights','learnings','actions'])if(!Array.isArray(r[k])||r[k].length>500||r[k].some(x=>typeof x!=='string'||x.length>20000))throw new Error(`记录字段 ${k} 必须是文字列表`);
 for(const k of ['reviewed','favorite','demo'])if(typeof r[k]!=='boolean')throw new Error(`记录字段 ${k} 无效`);
 if(r.cleanedTranscript!==undefined&&(typeof r.cleanedTranscript!=='string'||r.cleanedTranscript.length>500000))throw new Error('Invalid cleaned transcript');
 if(r.audio!==undefined)validateAudio(r.audio);
 if(r.transcription!==undefined){const t=r.transcription;if(!r.audio||!t||!['none','queued','running','done','failed'].includes(t.status)||typeof t.error!=='string'||typeof t.engine!=='string'||(t.autoAnalyze!==undefined&&typeof t.autoAnalyze!=='boolean'))throw new Error('语音转写状态无效')}
 if(r.categoryManual!==undefined&&typeof r.categoryManual!=='boolean')throw new Error('手动分类状态无效');
 if(r.ai!==undefined){const a=r.ai;if(!a||typeof a!=='object'||!['none','queued','running','done','failed'].includes(a.status))throw new Error('AI 整理状态无效');for(const k of ['reason','error','model','analyzedAt'])if(a[k]!==undefined&&typeof a[k]!=='string')throw new Error('AI 整理信息无效');if(a.confidence!==undefined&&(!Number.isFinite(a.confidence)||a.confidence<0||a.confidence>1))throw new Error('AI 置信度无效');}
 if(r.source!==undefined){if(!r.source||typeof r.source!=='object')throw new Error('来源格式无效');for(const k of ['name','path','hash','importedAt','kind','dateBasis'])if(r.source[k]!==undefined&&typeof r.source[k]!=='string')throw new Error('来源字段无效');}
 if(r.revision!==undefined&&(!Number.isInteger(r.revision)||r.revision<0))throw new Error('记录版本无效');
 return r;
}
export function validateBackup(input){
 const obj=typeof input==='string'?JSON.parse(input):input;
 if(!obj||![1,2].includes(obj.version)||!Array.isArray(obj.records)||obj.records.length>50000)throw new Error('不支持的备份格式或版本');
 const catalog=validateCategories(obj.categories??categories);const ids=new Set();for(const r of obj.records){validateRecord(r,catalog);if(ids.has(r.id))throw new Error('备份中存在重复标识');ids.add(r.id)}
 return obj.records;
}

export function backupHistory(input,records=input.records){
 const history={};
 for(const field of ['digests','weeklies','monthlies','yearlies'])history[field]=structuredClone(input[field]??{});
 const recordActions=new Map(records.map(record=>[record.id,new Set(record.actions)])),seen=new Set();
 history.doneActions=[];
 for(const item of input.doneActions??[]){
  const key=JSON.stringify([item?.recordId,item?.text]);
  if(recordActions.get(item?.recordId)?.has(item?.text)&&!seen.has(key)){
   history.doneActions.push({recordId:item.recordId,text:item.text,at:item.at});seen.add(key);
  }
 }
 return history;
}

// Validate incoming portable history without changing how older local databases
// load or export. Missing fields in v1/v2 backups mean no saved history.
export function validateBackupHistory(input,records=input.records){
 const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const isDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&localDate(new Date(`${value}T12:00:00`))===value;
 const history={};
 for(const field of ['digests','weeklies','monthlies','yearlies']){
  const entries=input[field]===undefined?{}:input[field];
  if(!isObject(entries)||Object.keys(entries).length>50000)throw new Error(`备份中的 ${field} 格式无效`);
  history[field]={};
  for(const [key,item] of Object.entries(entries)){
   const fail=()=>{throw new Error(`备份中的 ${field} 回顾内容无效（${key.slice(0,20)}）`)};
   if(!isObject(item)||typeof item.text!=='string'||!item.text.trim()||item.text.length>10000000||typeof item.generatedAt!=='string'||item.generatedAt.length>100||!Number.isFinite(Date.parse(item.generatedAt))||!['qwen','fallback'].includes(item.model)||!Number.isInteger(item.recordCount)||item.recordCount<1||item.recordCount>50000)fail();
   if(field==='digests'){
    if(!isDay(key)||item.date!==key)fail();
   }else{
    if(!isDay(item.start)||!isDay(item.end)||item.start>item.end||!Number.isInteger(item.dayCount)||item.dayCount<1||item.dayCount>item.recordCount)fail();
    if(field==='weeklies'){
     const start=new Date(`${item.start}T12:00:00`),end=new Date(start);end.setDate(end.getDate()+6);
     if(key!==item.start||start.getDay()!==1||localDate(end)!==item.end||item.dayCount>7)fail();
    }else if(field==='monthlies'){
     if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)||item.month!==key||item.start!==`${key}-01`)fail();
     const last=new Date(`${key}-01T12:00:00`);last.setMonth(last.getMonth()+1);last.setDate(0);
     if(item.end!==localDate(last)||item.dayCount>last.getDate())fail();
    }else if(!/^\d{4}$/.test(key)||item.year!==key||item.start!==`${key}-01-01`||item.end!==`${key}-12-31`||item.dayCount>366)fail();
   }
   history[field][key]=structuredClone(item);
  }
 }
 const actions=input.doneActions===undefined?[]:input.doneActions;
 if(!Array.isArray(actions)||actions.length>500000)throw new Error('备份中的待办完成状态格式无效');
 for(const item of actions){
  if(!isObject(item)||typeof item.recordId!=='string'||!item.recordId.trim()||item.recordId.length>200||typeof item.text!=='string'||!item.text.trim()||item.text.length>20000||!isDay(item.at))throw new Error('备份中的待办完成状态内容无效');
 }
 // Deleted records and rewritten actions can leave historical completion
 // markers locally; they must not attach to unrelated content on restore.
 return backupHistory({...history,doneActions:actions},records);
}

export function validateCategories(list){
 if(!Array.isArray(list)||list.length<1||list.length>60)throw new Error('分类数量应为 1–60 个');
 const ids=new Set(),names=new Set();for(const c of list){
 if(!c||typeof c.id!=='string'||!/^[a-z][a-z0-9-]{0,60}$/.test(c.id)||['home','all','timeline','review','favorites','queue','connections','ask'].includes(c.id)||ids.has(c.id))throw new Error('分类标识无效或重复');
 if(typeof c.name!=='string'||!c.name.trim()||c.name!==c.name.trim()||c.name.length>30||names.has(c.name.toLocaleLowerCase()))throw new Error('分类名称须为 1–30 字且不能重复');
 if(typeof c.color!=='string'||!/^#[a-f0-9]{6}$/i.test(c.color)||!['work','learn','life','idea','folder','book','mic','clock','star'].includes(c.icon))throw new Error('分类样式无效');
 ids.add(c.id);names.add(c.name.toLocaleLowerCase());}
 if(!ids.has('inbox'))throw new Error('必须保留待确认分类');return list;
}
export function validateAudio(a){
 if(!a||! /^[a-f0-9]{64}$/.test(a.hash)||typeof a.name!=='string'||a.name.length>255||!['audio/mpeg','audio/wav','audio/mp4'].includes(a.mime)||!Number.isInteger(a.size)||a.size<12||a.size>100*1024*1024)throw new Error('音频信息无效');return a;
}
