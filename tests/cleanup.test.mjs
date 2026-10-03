import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, splitTranscript } from '../cleanup.mjs';

const response = value => ({ ok: true, status: 200, json: async () => ({ done: true, done_reason: 'stop', eval_count: 12, message: { content: JSON.stringify(value) } }) });
const none = () => response({ deletions: [] });
function mock(t, fn) { t.mock.method(globalThis, 'fetch', fn); }
function userPayload(options) { return JSON.parse(JSON.parse(options.body).messages[1].content); }

test('production candidate IDs avoid model offset arithmetic and retain negation and amounts',async t=>{
 const text='嗯，不是周五，是周一。呃，预算三千元。';
 mock(t,async(_url,options)=>{const payload=userPayload(options);assert.deepEqual(payload.candidates.map(c=>c.quote),['嗯','呃']);assert.deepEqual(JSON.parse(options.body).format.required,['removeIds']);return response({removeIds:[0,1]})});
 assert.equal((await cleanTranscript(text)).text,'不是周五，是周一。预算三千元。');
});
test('unknown candidate IDs cannot delete arbitrary content and pass the chunk through raw',async t=>{mock(t,async()=>response({removeIds:[900]}));const output=await cleanTranscript('嗯，预算三千元。');assert.equal(output.text,'嗯，预算三千元。');assert.equal(output.chunksFailed,1)});

test('every chunk is requested and coverage equals the original', async t => {
  const sentence = `${'甲'.repeat(1900)}。`;
  const text = sentence.repeat(3);
  const received = [];
  mock(t, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.stream, false);
    assert.equal(body.options.temperature, 0);
    assert.equal(body.messages[0].content.includes(userPayload(options).segment.text), false);
    received.push(userPayload(options).segment.text);
    return none();
  });
  const output = await cleanTranscript(text);
  assert.equal(received.join(''), text);
  assert.ok(received.length >= 3);
  assert.ok(received.slice(0, -1).every(chunk => chunk.length >= 1500 && chunk.length <= 2500));
  assert.ok(received.at(-1).length <= 2500);
  assert.equal(output.text, text);
  assert.equal(output.coverage.characters, text.length);
  assert.equal(output.coverage.chunks, received.length);
  assert.equal(output.chunksFailed, 0);
  assert.equal(output.method, 'model-noop');
  assert.equal(output.model, 'qwen2.5:7b');
  assert.ok(Number.isFinite(Date.parse(output.cleanedAt)));
  assert.match(output.note, /对照原文/);
});

test('legal fillers are removed and every other character stays', async t => {
  const text = '我们嗯周五呃确认，就是说交付。';
  mock(t, async (_url, options) => {
    const source = userPayload(options).segment.text;
    return response({ deletions: [
      { segmentId: 's0', start: source.indexOf('嗯'), end: source.indexOf('嗯') + 1, quote: '嗯' },
      { segmentId: 's0', start: source.indexOf('呃'), end: source.indexOf('呃') + 1, quote: '呃' },
      { segmentId: 's0', quote: '就是说', occurrence: 1 },
    ] });
  });
  const output = await cleanTranscript(text, { model: 'qwen3:14b' });
  assert.equal(output.text, '我们周五确认，交付。');
  assert.equal(output.method, 'deletions-applied');
  assert.equal(output.model, 'qwen3:14b');
  assert.deepEqual(output.deletions.map(item => item.quote), ['嗯', '呃', '就是说']);
});

test('pause commas wrapped around a filler are tightened locally', async t => {
  const text = '嗯，我们，那个，明天开会。';
  mock(t, async () => response({ deletions: [
    { start: 0, end: 1, quote: '嗯' },
    { quote: '那个', occurrence: 1 },
  ] }));
  const output = await cleanTranscript(text);
  assert.equal(output.text, '我们，明天开会。');
});

test('negation and number deletions are refused while a real filler may go', async t => {
  const text = '不要嗯把预算改成不是300。';
  mock(t, async () => response({ deletions: [
    { start: 0, end: 1, quote: '不' },
    { start: 10, end: 13, quote: '300' },
    { start: 2, end: 3, quote: '嗯' },
  ] }));
  const output = await cleanTranscript(text);
  assert.equal(output.text, '不要把预算改成不是300。');
  assert.ok(output.text.includes('不'));
  assert.ok(output.text.includes('300'));
  assert.equal(output.text.includes('嗯'), false);
});

test('a rewritten full sentence is never applied and the chunk passes through raw', async t => {
  mock(t, async () => response({ cleanedText: '预算保持不变。' }));
  const output = await cleanTranscript('不要把预算改成300。');
  assert.equal(output.text, '不要把预算改成300。');
  assert.equal(output.chunksFailed, 1);
});

test('out of range, unknown quote and excess occurrence leave the chunk raw', async t => {
  mock(t, async () => response({ deletions: [{ start: 0, end: 50, quote: '嗯' }] }));
  let output = await cleanTranscript('今天嗯开会。');
  assert.equal(output.text, '今天嗯开会。');
  assert.equal(output.chunksFailed, 1);
  globalThis.fetch = async () => response({ deletions: [{ quote: '完全编造', occurrence: 1 }] });
  output = await cleanTranscript('今天嗯开会。');
  assert.equal(output.text, '今天嗯开会。');
  assert.equal(output.chunksFailed, 1);
  globalThis.fetch = async () => response({ deletions: [{ quote: '嗯', occurrence: 2 }] });
  output = await cleanTranscript('今天嗯开会。');
  assert.equal(output.text, '今天嗯开会。');
  assert.equal(output.chunksFailed, 1);
});

test('occurrence and offsets delete only the chosen repeat', async t => {
  const text = '那个嗯那个文件在桌上，那个嗯。';
  mock(t, async () => response({ deletions: [{ quote: '嗯', occurrence: 1 }] }));
  const first = await cleanTranscript(text);
  assert.equal(first.text, '那个那个文件在桌上，那个嗯。');
  globalThis.fetch = async () => response({ deletions: [
    { start: text.indexOf('嗯'), end: text.indexOf('嗯') + 1 },
    { start: text.lastIndexOf('嗯'), end: text.lastIndexOf('嗯') + 1 },
    { start: text.indexOf('那个文件'), end: text.indexOf('那个文件') + 2, quote: '那个' },
  ] });
  const both = await cleanTranscript(text);
  assert.equal(both.text, '那个那个文件在桌上，那个。');
  assert.ok(both.text.includes('那个文件'));
});

test('a failed chunk passes through raw while the other chunks still clean', async t => {
  const text = `${'甲'.repeat(2000)}嗯。${'乙'.repeat(2000)}。${'丙'.repeat(2000)}。`;
  let calls = 0;
  const progress = [];
  mock(t, async (_url, options) => {
    calls++;
    if (calls === 2) throw new TypeError('offline');
    const source = userPayload(options).segment.text;
    return source.includes('嗯') ? response({ deletions: [{ quote: '嗯', occurrence: 1 }] }) : none();
  });
  const output = await cleanTranscript(text, { onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(calls, 3);
  assert.equal(output.chunksFailed, 1);
  assert.equal(output.text, `${'甲'.repeat(2000)}。${'乙'.repeat(2000)}。${'丙'.repeat(2000)}。`);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
});

test('cancellation rejects before fetch and aborts an in-flight request', async t => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  mock(t, async () => { calls++; return none(); });
  await assert.rejects(cleanTranscript('内容', { signal: controller.signal }), /取消/);
  assert.equal(calls, 0);

  const live = new AbortController();
  const text = `${'甲'.repeat(2000)}。${'乙'.repeat(2000)}。`;
  calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    live.abort();
    assert.equal(options.signal.aborted, true);
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await assert.rejects(cleanTranscript(text, { signal: live.signal }), /取消/);
  assert.equal(calls, 1);
});

test('non-local models and overlong text never call fetch', async t => {
  let calls = 0;
  mock(t, async () => { calls++; return none(); });
  for (const model of ['qwen3:cloud', 'gpt-4o', 'qwen2.5:7b-remote']) {
    await assert.rejects(cleanTranscript('内容', { model }), /仅允许本地模型/);
  }
  await assert.rejects(cleanTranscript('甲'.repeat(80001)), /80,000/);
  assert.equal(calls, 0);
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(userPayload(options).segment.text.length <= 2500, true);
    return none();
  };
  const full = await cleanTranscript('甲'.repeat(80000));
  assert.equal(full.coverage.characters, 80000);
  assert.equal(full.text.length, 80000);
  assert.ok(calls >= 2);
});

test('empty text and whitespace skip the model', async t => {
  let calls = 0;
  mock(t, async () => { calls++; return none(); });
  for (const text of ['', '   ']) {
    const output = await cleanTranscript(text);
    assert.equal(output.text, text);
    assert.equal(output.method, 'passthrough');
    assert.equal(output.coverage.characters, text.length);
    assert.equal(output.coverage.chunks, 0);
    assert.equal(output.chunksFailed, 0);
  }
  assert.equal(calls, 0);
});

test('emoji surrogate pairs stay intact and a split offset fails', async t => {
  const text = `${'啊'.repeat(2499)}😀。嗯${'乙'.repeat(1600)}`;
  const chunks = splitTranscript(text);
  assert.equal(chunks.join(''), text);
  assert.equal(chunks.some(chunk => chunk.endsWith('\uD83D') || chunk.startsWith('\uDE00')), false);
  assert.ok(chunks.some(chunk => chunk.includes('😀')));
  mock(t, async (_url, options) => {
    const source = userPayload(options).segment.text;
    const emoji = source.indexOf('😀');
    if (emoji === -1) return none();
    return response({ deletions: [{ start: emoji, end: emoji + 1 }] });
  });
  const broken = await cleanTranscript(text);
  assert.equal(broken.text, text);/* 高位代理删除非法 → 该块原文透传，😀 完整保留 */
  assert.equal(broken.chunksFailed, 1);
  globalThis.fetch = async (_url, options) => {
    const source = userPayload(options).segment.text;
    return source.includes('嗯') ? response({ deletions: [{ quote: '嗯', occurrence: 1 }] }) : none();
  };
  const output = await cleanTranscript(text);
  assert.ok(output.text.includes('😀'));
  assert.equal(output.text.includes('嗯'), false);
  assert.equal(output.coverage.characters, text.length);
  assert.equal(output.chunksFailed, 0);
});

test('timeout and truncated output surface as a raw chunk with chunksFailed', async t => {
  mock(t, async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); });
  let output = await cleanTranscript('讨论');
  assert.equal(output.text, '讨论');
  assert.equal(output.chunksFailed, 1);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ done: true, done_reason: 'length', message: { content: '{"deletions":[]}' } }) });
  output = await cleanTranscript('讨论');
  assert.equal(output.text, '讨论');
  assert.equal(output.chunksFailed, 1);
});
