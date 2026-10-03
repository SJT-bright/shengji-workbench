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

function restrictSidecars(prefix) {
  for (const suffix of ['-wal', '-shm']) {
    try { fs.chmodSync(`${prefix}${suffix}`, 0o600); } catch { /* sidecar 尚未创建或已被回收 */ }
  }
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

// 写事务期间的 journal 策略：先切到 WAL（提交只追加 -wal，避免回滚日志整页改写），
// 提交后立刻切回 DELETE —— 该切换会把 WAL checkpoint 回主库文件并删除 -wal/-shm，
// 保证落盘静止态始终是"主库文件完整、无 sidecar"，与既有语义一致。
function enableWal(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
}

function checkpointToRollback(db) {
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA journal_mode = DELETE');
}

function writeTransaction(db, fn, sidecarPrefix) {
  enableWal(db);
  db.exec('BEGIN IMMEDIATE');
  if (sidecarPrefix) restrictSidecars(sidecarPrefix);
  let committed = false;
  try {
    const result = fn();
    db.exec('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    }
    try { checkpointToRollback(db); } catch { /* 下次 openDatabase 会回收遗留的 WAL */ }
  }
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

// 崩溃可能留下停留在 WAL 模式且带 -wal/-shm 的库文件：打开时 checkpoint 回主库并
// 恢复 DELETE 模式，保证只读会话（load/search/stats）不会留下 sidecar 文件。
function recoverLeftoverWal(db) {
  try {
    const row = db.prepare('PRAGMA journal_mode').get();
    if (String(row?.journal_mode) === 'wal') db.exec('PRAGMA journal_mode = DELETE');
  } catch { /* 保持原样；下次写事务仍会按需启用 WAL */ }
}

function openDatabase(file) {
  assertSqliteFile(file);
  const db = new DatabaseSync(file);
  try {
    assertSchema(db);
    recoverLeftoverWal(db);
    db.fts = Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='records_fts'").get());
    return db;
  } catch (error) {
    try { db.close(); } catch { /* already unusable */ }
    throw error;
  }
}

function applySchema(db) {
  enableWal(db);
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
  let stmts = null;
  let persistedRecords = null; // Map<id, {json, position}>：上一次已落盘的 records 影子
  const searchMode = 'LIKE';

  function attach(database) {
    db = database;
    stmts = null;
    persistedRecords = null;
    restrictFile(sqlitePath);
  }

  function createEmptyFile() {
    const partial = `${sqlitePath}.partial`;
    fs.rmSync(`${partial}-wal`, {force: true});
    fs.rmSync(`${partial}-shm`, {force: true});
    fs.rmSync(partial, {force: true});
    const created = new DatabaseSync(partial);
    try {
      applySchema(created);
      restrictFile(partial);
      return {created, partial};
    } catch (error) {
      try { created.close(); } catch { /* ignore */ }
      fs.rmSync(`${partial}-wal`, {force: true});
      fs.rmSync(`${partial}-shm`, {force: true});
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
      // 全量入口（迁移 / 首次落盘）：保留 writeContents 的逐条校验
      writeTransaction(created, () => writeContents(created, state), partial);
      publishPartial(created, partial);
    } catch (error) {
      try { created.close(); } catch { /* ignore */ }
      fs.rmSync(`${partial}-wal`, {force: true});
      fs.rmSync(`${partial}-shm`, {force: true});
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

  function getStatements() {
    if (!stmts) {
      stmts = {
        insertRecord: db.prepare(`INSERT INTO records
          (id, data, title, transcript, cleaned_transcript, summary, date, category, position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        updateRecord: db.prepare(`UPDATE records
          SET data = ?, title = ?, transcript = ?, cleaned_transcript = ?, summary = ?, date = ?, category = ?, position = ?
          WHERE id = ?`),
        moveRecord: db.prepare('UPDATE records SET position = ? WHERE id = ?'),
        deleteRecord: db.prepare('DELETE FROM records WHERE id = ?'),
        insertCategory: db.prepare('INSERT INTO categories (id, data, position) VALUES (?, ?, ?)'),
        insertMeta: db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)'),
        insertFts: null,
        deleteFts: null,
      };
      if (db.fts) {
        stmts.insertFts = db.prepare(`INSERT INTO records_fts (rowid, title, transcript, cleaned_transcript, summary)
          SELECT rowid, title, transcript, cleaned_transcript, summary FROM records WHERE id = ?`);
        stmts.deleteFts = db.prepare('DELETE FROM records_fts WHERE rowid = (SELECT rowid FROM records WHERE id = ?)');
      }
    }
    return stmts;
  }

  // 常规 save 的增量计划：与上次落盘影子按 id 比对，产出最小写集。
  // 结构校验（对象/ id / 重复 id）对所有记录执行——开销 O(N) 纯字符串比较，
  // 保证与全量写完全一致的报错行为；逐条内容校验由调用方 validate 承担。
  function planRecordDiff(records) {
    if (persistedRecords === null) {
      persistedRecords = new Map();
      for (const row of db.prepare('SELECT id, data, position FROM records').all()) {
        persistedRecords.set(row.id, {json: row.data, position: Number(row.position)});
      }
    }
    const seen = new Set();
    const inserts = [];
    const updates = [];
    const moves = [];
    const nextMap = new Map();
    records.forEach((record, position) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('记录格式无效');
      if (typeof record.id !== 'string' || !record.id) throw new Error('记录缺少 id');
      if (seen.has(record.id)) throw new Error(`重复记录 id: ${record.id}`);
      seen.add(record.id);
      const json = JSON.stringify(record);
      nextMap.set(record.id, {json, position});
      const prev = persistedRecords.get(record.id);
      if (!prev) {
        inserts.push([
          record.id,
          json,
          columnText(record.title),
          columnText(record.transcript),
          columnText(record.cleanedTranscript),
          columnText(record.summary),
          columnText(record.date),
          columnText(record.category),
          position,
        ]);
      } else if (prev.json !== json) {
        updates.push({
          id: record.id,
          params: [
            json,
            columnText(record.title),
            columnText(record.transcript),
            columnText(record.cleanedTranscript),
            columnText(record.summary),
            columnText(record.date),
            columnText(record.category),
            position,
            record.id,
          ],
        });
      } else if (prev.position !== position) {
        moves.push([position, record.id]);
      }
    });
    const deleteIds = [];
    for (const id of persistedRecords.keys()) {
      if (!seen.has(id)) deleteIds.push(id);
    }
    return {inserts, updates, moves, deleteIds, nextMap};
  }

  function applyRecordDiff(plan) {
    const s = getStatements();
    for (const id of plan.deleteIds) {
      if (s.deleteFts) s.deleteFts.run(id); // 先删 FTS 行（需要 records 里仍能查到 rowid）
      s.deleteRecord.run(id);
    }
    for (const params of plan.inserts) {
      s.insertRecord.run(...params);
      if (s.insertFts) s.insertFts.run(params[0]);
    }
    for (const update of plan.updates) {
      s.updateRecord.run(...update.params);
      if (s.insertFts) {
        s.deleteFts.run(update.id);
        s.insertFts.run(update.id);
      }
    }
    for (const [position, id] of plan.moves) {
      s.moveRecord.run(position, id);
    }
  }

  function rewriteCategories(categories) {
    const list = Array.isArray(categories) ? categories : [];
    const s = getStatements();
    db.exec('DELETE FROM categories');
    list.forEach((category, position) => {
      if (!category || typeof category.id !== 'string' || !category.id) throw new Error('分类缺少 id');
      s.insertCategory.run(category.id, JSON.stringify(category), position);
    });
  }

  function rewriteMetadata(state) {
    const s = getStatements();
    db.exec('DELETE FROM metadata');
    for (const [key, value] of Object.entries(state)) {
      if (RESERVED_KEYS.has(key)) continue;
      s.insertMeta.run(key, JSON.stringify(value));
    }
  }

  function save(state) {
    if (closed) throw new Error('存储已关闭');
    validate(state);
    ensureLoaded();
    if (!db) {
      commitNew(state);
      return;
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('状态格式无效');
    if (!Array.isArray(state.records)) throw new Error('records 必须是数组');
    const plan = planRecordDiff(state.records);
    try {
      writeTransaction(db, () => {
        applyRecordDiff(plan);
        rewriteCategories(state.categories);
        rewriteMetadata(state);
      }, sqlitePath);
    } catch (error) {
      persistedRecords = null; // 事务结果未知，下次保存前重建影子
      throw error;
    }
    persistedRecords = plan.nextMap;
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
    try {
      try { checkpointToRollback(db); } catch { /* 已是静止态或库不可写 */ }
      db.close();
    } finally { db = null; }
  }

  return {load, save, stats, search, close};
}
