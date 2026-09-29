import test from 'node:test';
import assert from 'node:assert/strict';
import {answerFromRecords,extractRetrievalTerms,findRelevantRecords,selectRecordContext} from '../record-qa.mjs';
const records=[{id:'one',title:'排期',date:'2026-09-26',transcript:'不是周五，是下周一交付，预算三千元。'}];
const modelResponse=items=>({ok:true,json:async()=>({done:true,message:{content:JSON.stringify({items})}})});
function assertRanges(context,originals){
 assert.ok(context.length<=6);
 assert.ok(context.reduce((sum,r)=>sum+r.characters,0)<=24000);
 for(const record of context){
  const original=originals.find(r=>r.id===record.id).transcript;
  assert.ok(record.characters<=10000);
  assert.equal(record.totalCharacters,original.length);
  assert.equal(record.characters,record.segments.reduce((sum,s)=>sum+s.transcript.length,0));
  assert.equal(record.truncated,record.characters<original.length);
  let lastEnd=-1;
  for(const segment of record.segments){
   assert.ok(segment.start>=0&&segment.end<=original.length&&segment.end>segment.start);
   assert.ok(segment.start>=lastEnd);
   assert.equal(segment.transcript,original.slice(segment.start,segment.end));
   lastEnd=segment.end;
  }
 }
}
test('retrieval answer retains only quotes present in the selected original',async t=>{
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  assert.equal(url,'http://127.0.0.1:11434/api/chat');
  const request=JSON.parse(opts.body);assert.equal(request.stream,false);
  assert.equal(JSON.parse(request.messages[1].content).records[0].segments[0].transcript,records[0].transcript);
  return modelResponse([{text:'交付在下周一',recordId:'one',quote:'是下周一交付'},{text:'虚构',recordId:'missing',quote:'下周一'}]);
 });
 const result=await answerFromRecords('什么时候交付',records);
 assert.equal(result.items.length,1);
 assert.equal(result.sources[0].truncated,false);
 assert.equal(result.sources[0].characters,records[0].transcript.length);
 assert.equal(result.sources[0].selection,'full');
 assert.deepEqual(result.sources[0].ranges,[{start:0,end:records[0].transcript.length}]);
});
test('empty retrieval does not call model and unsupported models fail',async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw Error('unexpected')});
 assert.equal((await answerFromRecords('内容',[])).items.length,0);
 await assert.rejects(answerFromRecords('内容',records,{model:'cloud'}));
});
test('fabricated quotes do not produce a successful answer',async t=>{
 t.mock.method(globalThis,'fetch',async()=>modelResponse([{text:'已经交付',recordId:'one',quote:'已经交付'}]));
 await assert.rejects(answerFromRecords('进度',records),/校验/);
});
test('short Chinese questions recall literal keywords and rank transcript matches above title matches',()=>{
 const question='预算多少',library=[{id:'title-only',title:'预算讨论',transcript:'会议已经结束。'},{id:'budget',title:'会议',transcript:'预算是200元。'},{id:'unrelated',title:'数量',transcript:'需要多少苹果？'}],queries=[];
 assert.ok(extractRetrievalTerms(question).includes('预算'));
 const found=findRelevantRecords(question,(term,limit)=>{
  queries.push(term);assert.equal(limit,50);
  return library.filter(r=>`${r.title}\n${r.transcript}`.toLowerCase().includes(term));
 });
 assert.ok(queries.includes('预算'));
 assert.deepEqual(found.map(r=>r.id),['budget','title-only']);
});
test('long transcripts can answer from a keyword match near the end',async t=>{
 const transcript='这是会议前段的其他内容。'.repeat(4000)+'最终确认预算是200元。',library=[{id:'long',title:'会议',transcript}];
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  const context=JSON.parse(JSON.parse(opts.body).messages[1].content).records;
  assertRanges(context,library);
  assert.ok(context[0].segments.some(s=>s.start>10000&&s.transcript.includes('预算是200元')));
  return modelResponse([{text:'预算是200元。',recordId:'long',quote:'预算是200元。'}]);
 });
 const answer=await answerFromRecords('预算多少',library);
 assert.equal(answer.items.length,1);
 assert.equal(answer.sources[0].selection,'keywords');
 assert.equal(answer.sources[0].truncated,true);
 assert.ok(answer.sources[0].ranges.some(r=>r.end===transcript.length));
});
test('quotes assembled across separate passages are rejected even if all pieces were provided',async t=>{
 const transcript='预算开头确认。'+Array.from({length:6000},(_,i)=>`原始编号${String(i).padStart(6,'0')}；`).join('')+'末尾预算是200元。',library=[{id:'long',title:'会议',transcript}];
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  const context=JSON.parse(JSON.parse(opts.body).messages[1].content).records;
  assertRanges(context,library);
  const segments=context[0].segments;assert.ok(segments.length>=2);
  assert.ok(segments[0].end<segments[1].start);
  const quote=segments[0].transcript.slice(-20)+segments[1].transcript.slice(0,20);
  assert.equal(segments.some(s=>s.transcript.includes(quote)),false);
  return modelResponse([{text:'伪拼接结论',recordId:'long',quote}]);
 });
 await assert.rejects(answerFromRecords('预算多少',library),/校验/);
});
test('a genuine quote from an omitted passage is not accepted as model evidence',async t=>{
 const transcript='预算开头确认。'+'甲'.repeat(5000)+'未提供片段中的真实文字。'+'乙'.repeat(20000)+'末尾预算是200元。',library=[{id:'long',title:'会议',transcript}];
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  const context=JSON.parse(JSON.parse(opts.body).messages[1].content).records;
  assert.equal(context[0].segments.some(s=>s.transcript.includes('未提供片段中的真实文字。')),false);
  return modelResponse([{text:'不应引用未读部分',recordId:'long',quote:'未提供片段中的真实文字。'}]);
 });
 await assert.rejects(answerFromRecords('预算多少',library),/校验/);
});
test('record and global character budgets preserve short originals and report exact disjoint ranges',()=>{
 const library=Array.from({length:8},(_,i)=>({id:String(i),title:'预算',transcript:i===1?'预算很少。😀'.repeat(100):'预算。😀'.repeat(7000)}));
 const context=selectRecordContext('预算多少',library);
 assert.equal(context.length,6);
 assertRanges(context,library);
 const short=context.find(r=>r.id==='1');
 assert.equal(short.truncated,false);
 assert.equal(short.segments[0].transcript,library[1].transcript);
 assert.ok(context.reduce((sum,r)=>sum+r.characters,0)>=18000);
});
test('long originals without literal hits explicitly fall back to a bounded prefix',()=>{
 const library=Array.from({length:6},(_,i)=>({id:String(i),title:'预算',transcript:'其他内容。'.repeat(6000)}));
 const context=selectRecordContext('预算多少',library);
 assertRanges(context,library);
 assert.equal(context.reduce((sum,r)=>sum+r.characters,0),24000);
 assert.ok(context.every(r=>r.selection==='prefix'&&r.truncated&&r.segments[0].start===0&&r.segments[0].end===4000));
});
test('repeated search hits and input records consume one source slot per record',()=>{
 const found=findRelevantRecords('预算多少',()=>[records[0],records[0]]);
 assert.equal(found.length,1);
 assert.equal(selectRecordContext('预算多少',[records[0],records[0]]).length,1);
});
