import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../store.mjs';
import {validateBackup} from '../shared.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shengji-store-'));
}

function category(id = 'inbox') {
  return {id, name: id === 'inbox' ? '待确认' : id, color: '#817b70', icon: 'folder'};
}

function record(overrides = {}) {
  return {
    id: 'rec-1',
    title: '周会纪要',
    category: 'inbox',
    date: '2026-09-26',
    time: '09:30',
    duration: 12,
    transcript: '今天讨论了预算和排期',
    cleanedTranscript: '讨论了预算与排期',
    summary: '确认下季度预算',
    highlights: [],
    learnings: [],
    actions: [],
    reviewed: false,
    favorite: false,
    demo: false,
    revision: 1,
    ...overrides,
  };
}

function state(records = [record()], extra = {}) {
  return {
    version: 2,
    categories: [category()],
    categoryRevision: 3,
    records,
    settings: {model: 'qwen2.5:7b', watchEnabled: false, autoAnalyze: false, watchFolder: '/tmp'},
    seenHashes: ['abc'],
    revision: 4,
    ...extra,
  };
}

function accept(value) {
  if (!value || !Array.isArray(value.records)) throw new Error('拒绝');
  return value;
}

test('migrates library.json once, leaves the file byte-for-byte, and reloads after reopen', () => {
  const dir = tempDir();
  const jsonPath = path.join(dir, 'library.json');
  const original = state([record({title: '迁移保留', transcript: '原文里的句子'})]);
  fs.writeFileSync(jsonPath, JSON.stringify(original));
  const before = fs.readFileSync(jsonPath);
  const store = openStore({dataDir: dir, initialState: state([]), validate: accept});
  const loaded = store.load();
  assert.equal(loaded.records[0].title, '迁移保留');
  assert.deepEqual(loaded.seenHashes, ['abc']);
  assert.equal(loaded.revision, 4);
  assert.equal(loaded.categoryRevision, 3);
  assert.deepEqual(loaded.settings, original.settings);
  assert.equal(loaded.categories[0].id, 'inbox');
  assert.ok(fs.existsSync(path.join(dir, 'library.sqlite')));
  assert.deepEqual(fs.readFileSync(jsonPath), before);
  store.close();
  const again = openStore({dataDir: dir, initialState: state([]), validate: accept});
  assert.equal(again.load().records[0].transcript, '原文里的句子');
  again.close();
});

test('existing sqlite wins over a newer library.json', () => {
  const dir = tempDir();
  const jsonPath = path.join(dir, 'library.json');
  fs.writeFileSync(jsonPath, JSON.stringify(state([record({id: 'from-json', title: '来自 JSON'})])));
  const first = openStore({dataDir: dir, initialState: state([]), validate: accept});
  first.load();
  first.close();
  fs.writeFileSync(jsonPath, JSON.stringify(state([record({id: 'changed', title: '后来改过的 JSON'})])));
  const second = openStore({dataDir: dir, initialState: state([]), validate: accept});
  assert.equal(second.load().records[0].id, 'from-json');
  second.close();
});

test('rejected or unreadable json does not create sqlite and does not change the file', () => {
  const dir = tempDir();
  const jsonPath = path.join(dir, 'library.json');
  fs.writeFileSync(jsonPath, '{');
  const before = fs.readFileSync(jsonPath);
  const broken = openStore({dataDir: dir, initialState: state([]), validate: accept});
  assert.throws(() => broken.load(), /无法解析/);
  assert.equal(fs.existsSync(path.join(dir, 'library.sqlite')), false);
  assert.deepEqual(fs.readFileSync(jsonPath), before);
  broken.close();

  const dir2 = tempDir();
  const json2 = path.join(dir2, 'library.json');
  fs.writeFileSync(json2, JSON.stringify(state()));
  const snapshot = fs.readFileSync(json2);
  const refused = openStore({
    dataDir: dir2,
    initialState: state([]),
    validate() { throw new Error('校验拒绝'); },
  });
  assert.throws(() => refused.load(), /校验拒绝/);
  assert.equal(fs.existsSync(path.join(dir2, 'library.sqlite')), false);
  assert.deepEqual(fs.readFileSync(json2), snapshot);
  refused.close();
});

test('failed save rolls back the previous committed state', () => {
  const dir = tempDir();
  const store = openStore({dataDir: dir, initialState: state([]), validate: accept});
  store.save(state([record({id: 'keep', title: '保留'})]));
  assert.throws(() => store.save(state([
    record({id: 'dup', title: '甲'}),
    record({id: 'dup', title: '乙'}),
  ])), /重复记录/);
  assert.equal(store.load().records.length, 1);
  assert.equal(store.load().records[0].id, 'keep');
  store.close();
  const reopened = openStore({dataDir: dir, initialState: state([]), validate: accept});
  assert.equal(reopened.load().records[0].title, '保留');
  reopened.close();
});

test('search finds Chinese and cleanedTranscript, escapes wildcards, and ignores injected SQL', () => {
  const dir = tempDir();
  const store = openStore({dataDir: dir, initialState: state([]), validate: accept});
  store.save(state([
    record({id: 'zh', title: '普通标题', transcript: '无关', cleanedTranscript: '这里有预算两个字', summary: ''}),
    record({id: 'pct', title: '100%_done', transcript: 'plain', cleanedTranscript: '', summary: ''}),
    record({id: 'other', title: '别的', transcript: 'nothing', cleanedTranscript: '', summary: ''}),
  ]));
  const chinese = store.search('预算');
  assert.equal(chinese.length, 1);
  assert.equal(chinese[0].id, 'zh');
  assert.equal(chinese[0].cleanedTranscript, '这里有预算两个字');
  assert.deepEqual(store.search('%').map(item => item.id), ['pct']);
  assert.deepEqual(store.search('_').map(item => item.id), ['pct']);
  assert.deepEqual(store.search(`%' OR '1'='1`), []);
  assert.deepEqual(store.search(`" OR 1=1 --`), []);
  assert.equal(store.search('别', 1).length, 1);
  assert.deepEqual(store.search(''), []);
  assert.deepEqual(store.search('别', 0), []);
  const info = store.stats();
  assert.equal(info.engine, 'SQLite');
  assert.equal(info.path, path.join(dir, 'library.sqlite'));
  assert.equal(info.recordCount, 3);
  assert.equal(info.categoryCount, 1);
  assert.equal(info.search, 'LIKE');
  assert.deepEqual(store.search('   '), []);
  store.close();
  store.close();
  assert.throws(() => store.load(), /存储已关闭/);
});

test('a corrupt sqlite file throws and is left unchanged', () => {
  const dir = tempDir();
  const file = path.join(dir, 'library.sqlite');
  fs.writeFileSync(file, 'garbage-not-sqlite');
  const before = fs.readFileSync(file);
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(state([record({title: '不该被迁移'})])));
  const store = openStore({dataDir: dir, initialState: state([]), validate: accept});
  assert.throws(() => store.load(), /损坏/);
  assert.deepEqual(fs.readFileSync(file), before);
  store.close();

  const dir2 = tempDir();
  const file2 = path.join(dir2, 'library.sqlite');
  const seeded = new DatabaseSync(file2);
  seeded.exec("CREATE TABLE records (id TEXT PRIMARY KEY, data TEXT NOT NULL, title TEXT, transcript TEXT, cleaned_transcript TEXT, summary TEXT, date TEXT, category TEXT, position INTEGER)");
  seeded.exec('CREATE TABLE categories (id TEXT PRIMARY KEY, data TEXT, position INTEGER)');
  seeded.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
  seeded.prepare("INSERT INTO records (id, data, title, transcript, cleaned_transcript, summary, date, category, position) VALUES (?,?,?,?,?,?,?,?,?)")
    .run('x', JSON.stringify(record({id: 'x', title: '将被截断'})), '将被截断', '', '', '', '', '', 0);
  seeded.close();
  const full = fs.readFileSync(file2);
  fs.writeFileSync(file2, full.subarray(0, 120));
  const truncated = fs.readFileSync(file2);
  const broken = openStore({dataDir: dir2, initialState: state([]), validate: accept});
  assert.throws(() => broken.load(), /损坏|无法识别|malformed|不是/);
  assert.deepEqual(fs.readFileSync(file2), truncated);
  broken.close();
});

test('database directory and file are owner-only', () => {
  const dir = tempDir();
  fs.chmodSync(dir, 0o755);
  const store = openStore({dataDir: dir, initialState: state([]), validate: accept});
  store.save(state());
  const file = path.join(dir, 'library.sqlite');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644);
  store.close();
  const reopened = openStore({dataDir: dir, initialState: state([]), validate: accept});
  reopened.load();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}-wal`), false);
  assert.equal(fs.existsSync(`${file}-shm`), false);
  reopened.close();
});

test('validateBackup result is not stored, and a rejected save leaves sqlite and json untouched', () => {
  const dir = tempDir();
  const jsonPath = path.join(dir, 'library.json');
  const original = state([record({
    cleanedTranscript: '只在整理稿里的句子',
    cleanup: {model: 'qwen2.5:7b', cleanedAt: '2026-09-26T00:00:00.000Z', coverage: 1, method: 'keep'},
  })], {note: '额外字段'});
  fs.writeFileSync(jsonPath, JSON.stringify(original));
  const store = openStore({dataDir: dir, initialState: state([]), validate: validateBackup});
  const loaded = store.load();
  assert.equal(Array.isArray(loaded), false);
  assert.equal(loaded.settings.model, 'qwen2.5:7b');
  assert.equal(loaded.note, '额外字段');
  assert.equal(loaded.records[0].cleanedTranscript, '只在整理稿里的句子');
  const jsonBefore = fs.readFileSync(jsonPath);
  assert.throws(() => store.save(state([record({duration: -1})])), /时长/);
  assert.deepEqual(store.load().records.map(item => item.id), ['rec-1']);
  assert.deepEqual(fs.readFileSync(jsonPath), jsonBefore);
  store.close();
});

test('duplicate category id rolls back, leftover partial is ignored, and limits stay bounded', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'library.sqlite.partial'), 'stale');
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(state([record({id: 'from-json'})])));
  const store = openStore({dataDir: dir, initialState: state([]), validate: accept});
  assert.equal(store.load().records[0].id, 'from-json');
  assert.equal(fs.existsSync(path.join(dir, 'library.sqlite.partial')), false);
  store.save(state([record({id: 'keep'})], {note: 'n'}));
  assert.throws(() => store.save({
    ...state([record({id: 'keep'})]),
    categories: [category('inbox'), category('inbox')],
  }), /UNIQUE|分类/);
  assert.equal(store.load().records[0].id, 'keep');
  assert.equal(store.load().categories.length, 1);
  const many = Array.from({length: 120}, (_, index) => record({id: `n${index}`, title: `词${index}`, transcript: '共同词'}));
  store.save(state(many));
  assert.equal(store.search('共同词').length, 30);
  assert.equal(store.search('共同词', 1)[0].id, 'n0');
  assert.equal(store.search('共同词', 1000).length, 100);
  assert.deepEqual(store.search('共同词', -1), []);
  const onlyHighlight = record({id: 'hid', title: '无', transcript: '无', summary: '', highlights: ['只在要点里']});
  store.save(state([onlyHighlight, record({id: 'sum', title: '无', transcript: '无', summary: '摘要专有'})]));
  assert.deepEqual(store.search('只在要点里'), []);
  assert.equal(store.search('摘要专有')[0].id, 'sum');
  store.close();

  const emptyDir = tempDir();
  const emptyFile = path.join(emptyDir, 'library.sqlite');
  fs.writeFileSync(emptyFile, Buffer.alloc(0));
  const empty = openStore({dataDir: emptyDir, initialState: state([]), validate: accept});
  assert.throws(() => empty.load(), /损坏/);
  assert.equal(fs.statSync(emptyFile).size, 0);
  empty.close();
});
