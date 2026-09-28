import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTranscript, summarizeWeek, summarizeMonth, summarizeYear } from '../ai.mjs';
const result = overrides => ({title:'项目排期讨论',category:'work',summary:'讨论了下一阶段的交付安排。',highlights:['周五确认交付时间。'],learnings:[],actions:['确认交付时间'],reason:'主要围绕项目协作与交付安排。',confidence:0.9,...overrides});
const response = value => ({ok:true,status:200,json:async()=>({done:true,done_reason:'stop',message:{content:typeof value==='string'?value:JSON.stringify(value)}})});
function mock(t, fn) { t.mock.method(globalThis, 'fetch', fn); }
test('local schema request; only literal quotes survive; metadata is real coverage',async t=>{
  mock(t,async(url,options)=>{assert.equal(url,'http://127.0.0.1:11434/api/chat'); assert.equal(options.redirect,'error');const body=JSON.parse(options.body);assert.equal(body.format.type,'object');assert.equal(body.stream,false);assert.equal(body.options.temperature,0);return response(result({highlights:['周五确认交付时间。','编造的引文']}));});
  const text='大家讨论项目排期。周五确认交付时间。';const output=await analyzeTranscript(text);assert.deepEqual(output.highlights,['周五确认交付时间。']);assert.deepEqual(output.coverage,{characters:text.length,chunks:1});assert.equal(output.model,'qwen2.5:7b');assert(Number.isFinite(Date.parse(output.analyzedAt)));
});
test('low confidence and unclear classification go to inbox',async t=>{
  mock(t,async()=>response(result({confidence:0.4})));assert.equal((await analyzeTranscript('嗯，那个再说吧')).category,'inbox');
});
test('all characters across multiple chunks are processed, then synthesized',async t=>{
  const received=[];let syntheses=0;const text='甲'.repeat(4999)+'😀'+'乙'.repeat(16003);
  mock(t,async(_url,options)=>{const payload=JSON.parse(JSON.parse(options.body).messages[1].content);if(payload.transcript!==undefined){received.push(payload.transcript);assert(payload.transcript.length<=5000);}else{assert(payload.analyses.length<=3);syntheses++;}return response(result({highlights:[]}));});
  const output=await analyzeTranscript(text);assert.equal(received.join(''),text);assert.equal(received.length,5);assert.equal(syntheses,3);assert.equal(output.coverage.characters,text.length);assert.equal(output.coverage.chunks,5);
});
test('invalid JSON and invalid output fields are rejected, no fallback',async t=>{
  mock(t,async()=>response('not json'));await assert.rejects(analyzeTranscript('项目沟通'),/JSON/);
  globalThis.fetch=async()=>response(result({summary:33}));await assert.rejects(analyzeTranscript('项目沟通'),/summary/);
  globalThis.fetch=async()=>response(result({actions:['a'.repeat(181)]}));await assert.rejects(analyzeTranscript('项目沟通'),/actions/);
  globalThis.fetch=async()=>response(result({confidence:3}));await assert.rejects(analyzeTranscript('项目沟通'),/置信度/);
  globalThis.fetch=async()=>response(result({extra:'bad'}));await assert.rejects(analyzeTranscript('项目沟通'),/字段/);
});
test('connection, model missing, timeout, cancellation and incomplete output fail visibly',async t=>{
  mock(t,async()=>{throw new TypeError('network')});await assert.rejects(analyzeTranscript('讨论'),/无法连接/);
  globalThis.fetch=async()=>({ok:false,status:404});await assert.rejects(analyzeTranscript('讨论'),/不可用/);
  globalThis.fetch=async()=>{throw Object.assign(new Error('timeout'),{name:'TimeoutError'})};await assert.rejects(analyzeTranscript('讨论'),/超时/);
  const controller=new AbortController();controller.abort();await assert.rejects(analyzeTranscript('讨论',{signal:controller.signal}),/取消/);
  globalThis.fetch=async()=>({ok:true,json:async()=>({done:true,done_reason:'length',message:{content:JSON.stringify(result())}})});await assert.rejects(analyzeTranscript('讨论'),/完整输出/);
});
test('chunk failure rejects whole job, without reporting partial success',async t=>{
  let calls=0;mock(t,async()=>{if(++calls===2)throw new Error('offline');return response(result());});await assert.rejects(analyzeTranscript('甲'.repeat(10001)),/无法连接/);assert.equal(calls,2);
});
test('cloud models, empty text and oversized text are refused before fetch',async t=>{
  let calls=0;mock(t,async()=>{calls++;return response(result())});await assert.rejects(analyzeTranscript('内容',{model:'qwen3:cloud'}),/仅允许本地模型/);await assert.rejects(analyzeTranscript('  '),/非空/);await assert.rejects(analyzeTranscript('甲'.repeat(80001)),/80,000/);assert.equal(calls,0);
});

test('custom category catalog is sent to model and validated',async()=>{
	const original=global.fetch;const catalog=[{id:'inbox',name:'待确认',color:'#817b70',icon:'folder'},{id:'custom-english',name:'英语口语',color:'#527778',icon:'mic'}];
	try{global.fetch=async(url,options)=>{const req=JSON.parse(options.body);assert.deepEqual(req.format.properties.category.enum,['inbox','custom-english']);assert.ok(req.messages[0].content.includes('英语口语'));return {ok:true,json:async()=>({done:true,done_reason:'stop',message:{content:JSON.stringify({title:'英语练习',category:'custom-english',summary:'练习英语发音',highlights:['英语发音'],learnings:[],actions:[],reason:'口语练习',confidence:.9})}})}};
	const result=await analyzeTranscript('今天练习英语发音',{categories:catalog});assert.equal(result.category,'custom-english');
	}finally{global.fetch=original}
});

test('value tier is parsed when valid and silently dropped when missing or invalid',async t=>{
	mock(t,async(url,options)=>{const body=JSON.parse(options.body);assert.deepEqual(body.format.properties.value.enum,['gem','daily']);return response(result({value:'gem'}))});
	assert.equal((await analyzeTranscript('完整的方法论分享')).value,'gem');
	globalThis.fetch=async()=>response(result({value:'daily'}));
	assert.equal((await analyzeTranscript('寒暄闲聊')).value,'daily');
	globalThis.fetch=async()=>response(result());
	assert.equal((await analyzeTranscript('寒暄闲聊')).value,undefined);
	globalThis.fetch=async()=>response(result({value:'重要'}));
	assert.equal((await analyzeTranscript('寒暄闲聊')).value,undefined);
	globalThis.fetch=async()=>response(result({value:123}));
	assert.equal((await analyzeTranscript('寒暄闲聊')).value,undefined);
});

test('summarizeWeek sends daily digest material with record entries and parses the text field',async t=>{
	mock(t,async(url,options)=>{
		assert.equal(url,'http://127.0.0.1:11434/api/chat');
		const body=JSON.parse(options.body);
		assert.equal(body.stream,false);assert.equal(body.options.temperature,0);
		assert.ok(body.messages[0].content.includes('周报'));
		assert.deepEqual(body.format.required,['text']);
		const payload=JSON.parse(body.messages[1].content);
		assert.ok(payload.task.includes('周报'));
		assert.deepEqual(payload.entries[0],{kind:'day',date:'2026-03-02',title:'',summary:'',text:'周一的每日提炼内容'});
		assert.deepEqual(payload.entries[1],{kind:'record',date:'',title:'晨会记录',summary:'讨论了交付安排',text:'整理稿正文'});
		return response({text:'本周完成三轮评审。'});
	});
	const output=await summarizeWeek([{kind:'day',date:'2026-03-02',text:'周一的每日提炼内容'},{kind:'record',title:'晨会记录',summary:'讨论了交付安排',text:'整理稿正文'}]);
	assert.deepEqual(output,{text:'本周完成三轮评审。',model:'qwen2.5:7b'});
});

test('summarizeWeek refuses cloud models, empty entries and invalid model output',async t=>{
	await assert.rejects(summarizeWeek([],{model:'qwen3:cloud'}),/仅允许本地模型/);
	await assert.rejects(summarizeWeek([]),/没有可提炼/);
	mock(t,async()=>response('not json'));await assert.rejects(summarizeWeek([{kind:'record',title:'t'}]),/JSON/);
	globalThis.fetch=async()=>response({nope:1});await assert.rejects(summarizeWeek([{kind:'record',title:'t'}]),/有效/);
	globalThis.fetch=async()=>response({text:''});await assert.rejects(summarizeWeek([{kind:'record',title:'t'}]),/有效/);
	globalThis.fetch=async()=>({ok:false,status:502});await assert.rejects(summarizeWeek([{kind:'record',title:'t'}]),/HTTP 502/);
});

test('summarizeMonth sends weekly and daily digest material with record entries and parses the text field',async t=>{
	mock(t,async(url,options)=>{
		assert.equal(url,'http://127.0.0.1:11434/api/chat');
		const body=JSON.parse(options.body);
		assert.equal(body.stream,false);assert.equal(body.options.temperature,0);
		assert.ok(body.messages[0].content.includes('月度回顾'));
		assert.deepEqual(body.format.required,['text']);
		const payload=JSON.parse(body.messages[1].content);
		assert.ok(payload.task.includes('月度回顾'));
		assert.deepEqual(payload.entries[0],{kind:'day',date:'2026-03-02',title:'',summary:'',text:'周一的每日提炼内容'});
		assert.deepEqual(payload.entries[1],{kind:'week',date:'2026-03-02',title:'',summary:'',text:'第一周的周报文本'});
		assert.deepEqual(payload.entries[2],{kind:'record',date:'2026-03-03',title:'晨会记录',summary:'讨论了交付安排',text:'整理稿正文'});
		return response({text:'本月完成三轮评审，明确下月重点。'});
	});
	const output=await summarizeMonth([{kind:'day',date:'2026-03-02',text:'周一的每日提炼内容'},{kind:'week',date:'2026-03-02',text:'第一周的周报文本'},{kind:'record',date:'2026-03-03',title:'晨会记录',summary:'讨论了交付安排',text:'整理稿正文'}]);
	assert.deepEqual(output,{text:'本月完成三轮评审，明确下月重点。',model:'qwen2.5:7b'});
});

test('summarizeMonth refuses cloud models, empty entries and invalid model output',async t=>{
	await assert.rejects(summarizeMonth([],{model:'qwen3:cloud'}),/仅允许本地模型/);
	await assert.rejects(summarizeMonth([]),/没有可提炼/);
	mock(t,async()=>response('not json'));await assert.rejects(summarizeMonth([{kind:'record',title:'t'}]),/JSON/);
	globalThis.fetch=async()=>response({nope:1});await assert.rejects(summarizeMonth([{kind:'record',title:'t'}]),/有效/);
	globalThis.fetch=async()=>response({text:''});await assert.rejects(summarizeMonth([{kind:'record',title:'t'}]),/有效/);
	globalThis.fetch=async()=>({ok:false,status:502});await assert.rejects(summarizeMonth([{kind:'record',title:'t'}]),/HTTP 502/);
});

test('summarizeYear sends monthly, daily and record material and parses the text field',async t=>{
	mock(t,async(url,options)=>{
		assert.equal(url,'http://127.0.0.1:11434/api/chat');
		const body=JSON.parse(options.body);
		assert.equal(body.stream,false);assert.equal(body.options.temperature,0);
		assert.ok(body.messages[0].content.includes('年度回顾'));
		assert.deepEqual(body.format.required,['text']);
		const payload=JSON.parse(body.messages[1].content);
		assert.ok(payload.task.includes('年度回顾'));
		assert.deepEqual(payload.entries[0],{kind:'month',date:'2025-01',title:'',summary:'',text:'一月的月报文本'});
		assert.deepEqual(payload.entries[1],{kind:'day',date:'2025-01-06',title:'',summary:'',text:'一日的每日提炼内容'});
		assert.deepEqual(payload.entries[2],{kind:'record',date:'2025-03-03',title:'晨会记录',summary:'讨论了交付安排',text:'整理稿正文'});
		return response({text:'这一年完成三轮交付。'});
	});
	const output=await summarizeYear([{kind:'month',date:'2025-01',text:'一月的月报文本'},{kind:'day',date:'2025-01-06',text:'一日的每日提炼内容'},{kind:'record',date:'2025-03-03',title:'晨会记录',summary:'讨论了交付安排',text:'整理稿正文'}]);
	assert.deepEqual(output,{text:'这一年完成三轮交付。',model:'qwen2.5:7b'});
});

test('summarizeYear refuses cloud models, empty entries and invalid model output',async t=>{
	await assert.rejects(summarizeYear([],{model:'qwen3:cloud'}),/仅允许本地模型/);
	await assert.rejects(summarizeYear([]),/没有可提炼/);
	mock(t,async()=>response('not json'));await assert.rejects(summarizeYear([{kind:'record',title:'t'}]),/JSON/);
	globalThis.fetch=async()=>response({nope:1});await assert.rejects(summarizeYear([{kind:'record',title:'t'}]),/有效/);
	globalThis.fetch=async()=>response({text:''});await assert.rejects(summarizeYear([{kind:'record',title:'t'}]),/有效/);
	globalThis.fetch=async()=>({ok:false,status:502});await assert.rejects(summarizeYear([{kind:'record',title:'t'}]),/HTTP 502/);
});
