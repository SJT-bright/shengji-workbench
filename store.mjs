import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
const SEARCH_LIMIT_MAX = 100;
const RESERVED_KEYS = new Set(['records', 'categories']);

const SCHEMA = `
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  cleaned_transcript TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL
);
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE records_fts USING fts5(
  title,
  transcript,
  cleaned_transcript,
  summary,
  tokenize = 'trigram'
);
`;

function assertArgs({dataDir, initialState, validate}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('dataDir 无效');
  if (!initialState || typeof initialState !== 'object' || Array.isArray(initialState)) throw new Error('initialState 无效');
  if (typeof validate !== 'function') throw new Error('validate 必须是函数');
}

function restrictDir(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.chmodSync(dir, 0o700);
}

function restrictFile(file) {
  fs.chmodSync(file, 0o600);
}

function assertSqliteFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const n = fs.readSync(fd, header, 0, header.length, 0);
    if (n < header.length || !header.equals(SQLITE_HEADER)) {
      throw new Error('SQLite 数据库已损坏（文件头无效），已停止打开，未改用空库');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function columnText(value) {
  return typeof value === 'string' ? value : '';
}

function writeContents(db, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('状态格式无效');
  if (!Array.isArray(state.records)) throw new Error('records 必须是数组');
  const categories = Array.isArray(state.categories) ? state.categories : [];
  db.exec('DELETE FROM records');
  db.exec('DELETE FROM categories');
  db.exec('DELETE FROM metadata');
  const insertRecord = db.prepare(`INSERT INTO records
    (id, data, title, transcript, cleaned_transcript, summary, date, category, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const seen = new Set();
  state.records.forEach((record, position) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('记录格式无效');
    if (typeof record.id !== 'string' || !record.id) throw new Error('记录缺少 id');
    if (seen.has(record.id)) throw new Error(`重复记录 id: ${record.id}`);
    seen.add(record.id);
    insertRecord.run(
      record.id,
      JSON.stringify(record),
      columnText(record.title),
      columnText(record.transcript),
      columnText(record.cleanedTranscript),
      columnText(record.summary),
      columnText(record.date),
      columnText(record.category),
      position,
    );
  });
  const insertCategory = db.prepare('INSERT INTO categories (id, data, position) VALUES (?, ?, ?)');
  categories.forEach((category, position) => {
    if (!category || typeof category.id !== 'string' || !category.id) throw new Error('分类缺少 id');
    insertCategory.run(category.id, JSON.stringify(category), position);
  });
  const insertMeta = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(state)) {
    if (RESERVED_KEYS.has(key)) continue;
    insertMeta.run(key, JSON.stringify(value));
  }
  if (db.fts) {
    db.exec('DELETE FROM records_fts');
    const insertFts = db.prepare(`INSERT INTO records_fts (title, transcript, cleaned_transcript, summary)
      SELECT title, transcript, cleaned_transcript, summary FROM records`);
    insertFts.run();
  }
}

function readState(db) {
  const metaRows = db.prepare('SELECT key, value FROM metadata').all();
  const state = {};
  for (const row of metaRows) state[row.key] = JSON.parse(row.value);
  state.categories = db.prepare('SELECT data FROM categories ORDER BY position ASC').all().map(row => JSON.parse(row.data));
  state.records = db.prepare('SELECT data FROM records ORDER BY position ASC').all().map(row => JSON.parse(row.data));
  return state;
}

function assertSchema(db) {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(row => row.name));
  for (const name of ['records', 'categories', 'metadata']) {
    if (!names.has(name)) throw new Error('SQLite 数据库结构无法识别，已停止打开，未改用空库');
  }
  const check = db.prepare('PRAGMA integrity_check').get();
  const status = check?.integrity_check ?? check?.quick_check;
  if (status !== 'ok') throw new Error('SQLite 数据库已损坏（完整性检查失败），已停止打开，未改用空库');
}

function openDatabase(file) {
  assertSqliteFile(file);
  const db = new DatabaseSync(file);
  try {
    assertSchema(db);
    db.fts = Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='records_fts'").get());
    return db;
  } catch (error) {
    try { db.close(); } catch { /* already unusable */ }
    throw error;
  }
}

function applySchema(db) {
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec(SCHEMA);
  try {
    db.exec(FTS_SCHEMA);
    db.fts = true;
  } catch {
    db.fts = false;
  }
}

function likePattern(query) {
  return `%${String(query).replace(/[\\%_]/g, char => `\\${char}`)}%`;
}

export function openStore({dataDir, initialState, validate}) {
  assertArgs({dataDir, initialState, validate});
  restrictDir(dataDir);
  const sqlitePath = path.join(dataDir, 'library.sqlite');
  const jsonPath = path.join(dataDir, 'library.json');
  let db = null;
  let closed = false;
  const searchMode = 'LIKE';

  function attach(database) {
    db = database;
    restrictFile(sqlitePath);
  }

  function createEmptyFile() {
    const partial = `${sqlitePath}.partial`;
    fs.rmSync(partial, {force: true});
    const created = new DatabaseSync(partial);
    try {
      applySchema(created);
      restrictFile(partial);
      return {created, partial};
    } catch (error) {
      try { created.close(); } catch { /* ignore */ }
      fs.rmSync(partial, {force: true});
      throw error;
    }
  }

  function publishPartial(created, partial) {
    created.close();
    fs.renameSync(partial, sqlitePath);
    restrictFile(sqlitePath);
    attach(openDatabase(sqlitePath));
  }

  function commitNew(state) {
    const {created, partial} = createEmptyFile();
    try {
      created.exec('BEGIN IMMEDIATE');
      writeContents(created, state);
      created.exec('COMMIT');
      publishPartial(created, partial);
    } catch (error) {
      try { created.exec('ROLLBACK'); } catch { /* not begun */ }
      try { created.close(); } catch { /* ignore */ }
      fs.rmSync(partial, {force: true});
      throw error;
    }
  }

  function migrateJson() {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const before = fs.readFileSync(jsonPath);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('library.json 无法解析，已保留原文件，未创建 SQLite');
    }
    validate(parsed);
    commitNew(parsed);
    const after = fs.readFileSync(jsonPath);
    if (!after.equals(before)) throw new Error('迁移改动了 library.json');
  }

  function ensureLoaded() {
    if (closed) throw new Error('存储已关闭');
    if (db) return;
    if (fs.existsSync(sqlitePath)) {
      try {
        attach(openDatabase(sqlitePath));
      } catch (error) {
        const message = String(error.message || '未知错误');
        if (message.startsWith('SQLite')) throw error;
        throw new Error(`SQLite 数据库已损坏：${message}`);
      }
      return;
    }
    if (fs.existsSync(jsonPath)) migrateJson();
  }

  function load() {
    ensureLoaded();
    if (!db) return structuredClone(initialState);
    return readState(db);
  }

  function save(state) {
    if (closed) throw new Error('存储已关闭');
    validate(state);
    ensureLoaded();
    if (!db) {
      commitNew(state);
      return;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      writeContents(db, state);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }

  function stats() {
    if (closed) throw new Error('存储已关闭');
    ensureLoaded();
    if (!db) {
      const state = initialState;
      return {
        engine: 'SQLite',
        path: sqlitePath,
        recordCount: Array.isArray(state.records) ? state.records.length : 0,
        categoryCount: Array.isArray(state.categories) ? state.categories.length : 0,
        search: searchMode,
      };
    }
    return {
      engine: 'SQLite',
      path: sqlitePath,
      recordCount: Number(db.prepare('SELECT COUNT(*) AS n FROM records').get().n),
      categoryCount: Number(db.prepare('SELECT COUNT(*) AS n FROM categories').get().n),
      search: searchMode,
    };
  }

  function search(query, limit = 30) {
    if (closed) throw new Error('存储已关闭');
    ensureLoaded();
    const capped = Number.isFinite(limit) ? Math.trunc(limit) : 30;
    const bounded = Math.min(SEARCH_LIMIT_MAX, Math.max(0, capped));
    const text = typeof query === 'string' ? query.trim() : '';
    if (!db || bounded === 0 || !text) return [];
    const pattern = likePattern(text);
    const rows = db.prepare(`SELECT data FROM records
      WHERE title LIKE ? ESCAPE '\\'
         OR transcript LIKE ? ESCAPE '\\'
         OR cleaned_transcript LIKE ? ESCAPE '\\'
         OR summary LIKE ? ESCAPE '\\'
      ORDER BY position ASC
      LIMIT ?`).all(pattern, pattern, pattern, pattern, bounded);
    return rows.map(row => JSON.parse(row.data));
  }

  function close() {
    if (closed) return;
    closed = true;
    if (!db) return;
    try { db.close(); } finally { db = null; }
  }

  return {load, save, stats, search, close};
}
