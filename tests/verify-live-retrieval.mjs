// Uses synthetic text in an isolated library and the existing local Qwen model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'shengji-retrieval-'));
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const token = crypto.randomUUID();
await fs.mkdir(path.join(scratch, 'data'));
await fs.writeFile(path.join(scratch, 'data', 'library.json'), JSON.stringify({
  version: 2, records: [], settings: {watchEnabled: false, autoAnalyze: false},
}));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: {...process.env, SHENGJI_PORT: String(port), SHENGJI_TOKEN: token,
    SHENGJI_DATA_DIR: path.join(scratch, 'data'), SHENGJI_INBOX: path.join(scratch, 'inbox')},
  stdio: ['ignore', 'ignore', 'pipe'],
});
let logs = '';
child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
const api = async (route, body) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(330000),
    headers: {'X-Shengji-Token': token, 'Content-Type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
};
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await api('health'); ready = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(ready, `Isolated server did not start: ${logs}`);
  const prefix = '这一部分是日常阅读记录，讨论整理书桌和安排休息。\n'.repeat(550);
  const evidence = '松塔项目的最终预算是 28640 元，提交日期为十月十二日。';
  assert(prefix.length > 10000);
  const record = await api('import', {title: '隔离验收：长稿末尾的项目决定',
    text: prefix + evidence, autoAnalyze: false});
  const startedAt = Date.now();
  const answer = await api('ask', {question: '松塔项目最终预算是多少？'});
  assert(answer.items.some(item => item.recordId === record.record.id && item.quote.includes('28640')),
    'The local model did not return the budget with a verified source quote');
  assert(answer.sources.some(source => source.truncated), 'Coverage must disclose selection from a long transcript');
  const report = {verifiedAt: new Date().toISOString(), source: 'synthetic fixture',
    model: answer.model, elapsedMs: Date.now() - startedAt, transcriptCharacters: prefix.length + evidence.length,
    evidenceOffset: prefix.length, items: answer.items, sources: answer.sources};
  const destination = path.join(root, 'verification', 'live-retrieval.json');
  await fs.mkdir(path.dirname(destination), {recursive: true});
  await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ok: true, model: answer.model, evidenceOffset: prefix.length,
    citations: answer.items.length, elapsedMs: report.elapsedMs, report: destination}));
} finally {
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
  }
  await fs.rm(scratch, {recursive: true, force: true});
}
