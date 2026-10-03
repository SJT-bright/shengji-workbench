import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../store.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shengji-store-perf-'));
}

const CATEGORIES = [{id: 'work', name: '工作', color: '#607646', icon: 'work'}];

function initialState() {
  return {
    version: 2,
    categories: CATEGORIES,
    categoryRevision: 0,
    records: [],
    settings: {watchFolder: '/tmp', watchEnabled: false, autoAnalyze: false, model: 'qwen2.5:7b'},
    seenHashes: [],
    digests: {},
    weeklies: {},
    monthlies: {},
    yearlies: {},
    doneActions: [],
    revision: 0,
  };
}

function record(i, chars = 3000) {
  return {
    id: `perf-${i}`,
    title: `会议记录第${i}篇`,
    category: 'work',
    date: '2026-09-01',
    time: '10:00',
    duration: 5,
    transcript: '这是一段会议转写内容，讨论了项目排期与分工安排。'.repeat(Math.ceil(chars / 26)).slice(0, chars),
    summary: `摘要${i}`,
    highlights: [],
    learnings: [],
    actions: [],
    favorite: false,
    reviewed: false,
    demo: false,
    revision: 1,
    source: {name: 't.txt', path: '', hash: `h${i}`, kind: 'manual', importedAt: '2026-09-01T00:00:00.000Z', dateBasis: '导入时间'},
    ai: {status: 'none', error: '', model: 'qwen2.5:7b'},
  };
}

const accept = state => state;

test('50 consecutive single-record edits: load() equals in-memory state and search sees latest content', () => {
  const dir = tempDir();
  const store = openStore({dataDir: dir, initialState: initialState(), validate: accept});
  const records = Array.from({length: 120}, (_, index) => record(index + 1));
  const state = {...initialState(), records, revision: 1};
  store.save(state);

  const started = performance.now();
  for (let round = 1; round <= 50; round++) {
    // gcd(7,120)=1，前 50 轮目标互不重复：每轮只改一条记录
    const target = records[(round * 7) % records.length];
    target.summary = `第${round}轮更新摘要`;
    target.transcript = `${target.transcript.slice(0, 120)}第${round}轮更新内容`;
    state.revision = 1 + round;
    store.save(state);
    const hits = store.search(`第${round}轮更新内容`);
    assert.equal(hits.length, 1, `第${round}轮编辑后 search 应命中最新内容`);
    assert.equal(hits[0].id, target.id);
    assert.equal(hits[0].summary, `第${round}轮更新摘要`);
  }
  const elapsed = performance.now() - started;

  assert.deepEqual(store.load(), JSON.parse(JSON.stringify(state)));

  store.close();
  const reopened = openStore({dataDir: dir, initialState: initialState(), validate: accept});
  assert.deepEqual(reopened.load(), JSON.parse(JSON.stringify(state)));
  assert.equal(reopened.search('第50轮更新内容').length, 1);
  assert.equal(reopened.stats().recordCount, 120);
  assert.equal(reopened.search('会议记录第', 100).length, 100); // 命中上限 100
  reopened.close();
  console.log(`store-perf: 50 次 editSave 合计 ${elapsed.toFixed(0)}ms（平均 ${(elapsed / 50).toFixed(1)}ms）`);
});

test('incremental diff handles update, insert, delete, reorder and small fields exactly like a full rewrite', () => {
  const dir = tempDir();
  const store = openStore({dataDir: dir, initialState: initialState(), validate: accept});
  const a = record(1);
  const b = record(2);
  const c = record(3);
  let state = {...initialState(), records: [a, b, c]};
  store.save(state);

  // 修改一条 + 删一条 + 增一条 + 换序 + 分类与 settings 变更
  const d = record(4);
  b.summary = '被修改的摘要';
  state = {
    ...initialState(),
    categories: [{...CATEGORIES[0], name: '工作沟通'}],
    categoryRevision: 2,
    records: [c, b, d],
    settings: {...initialState().settings, watchEnabled: true},
    revision: 2,
  };
  store.save(state);

  const loaded = store.load();
  assert.deepEqual(loaded, JSON.parse(JSON.stringify(state)));
  assert.deepEqual(loaded.records.map(item => item.id), ['perf-3', 'perf-2', 'perf-4']);
  assert.equal(loaded.categories[0].name, '工作沟通');
  assert.equal(loaded.settings.watchEnabled, true);
  assert.equal(store.search('被修改的摘要')[0].id, 'perf-2');
  assert.deepEqual(store.search('摘要1'), [], '删除的记录不应再被检索到');
  assert.equal(store.stats().recordCount, 3);

  // 保存失败（重复 id）必须回滚且不影响影子：下一次正常保存仍然正确
  assert.throws(() => store.save({
    ...state,
    records: [record(9), record(9)],
  }), /重复记录/);
  const e = record(5);
  const nextState = {...state, records: [c, b, d, e], revision: 3};
  store.save(nextState);
  assert.deepEqual(store.load(), JSON.parse(JSON.stringify(nextState)));
  assert.equal(store.search('摘要5')[0].id, 'perf-5');

  store.close();
  const reopened = openStore({dataDir: dir, initialState: initialState(), validate: accept});
  assert.deepEqual(reopened.load(), JSON.parse(JSON.stringify(nextState)));
  reopened.close();
});
