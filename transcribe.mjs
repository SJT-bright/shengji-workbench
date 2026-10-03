import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const base = path.dirname(fileURLToPath(import.meta.url));
const engine = 'funasr-paraformer-zh';
const engineHome = path.join(os.homedir(), 'phone-asr-selfhosted');
const python = path.join(engineHome, 'venv', 'bin', 'python');
const models = path.join(engineHome, 'local', 'models');
const ffmpeg = '/opt/homebrew/bin/ffmpeg';
const ffprobe = '/opt/homebrew/bin/ffprobe';
const helper = path.join(base, 'native', 'transcribe_audio.py');
// No shell and no inherited service credentials. Dependencies stay entirely local.
const childEnv = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: os.homedir(),
  LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1', MODELSCOPE_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' };
function command(executable, args, { signal, timeout = 60_000, env = childEnv } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('音频转写已取消'));
    const child = spawn(executable, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', reason = '', settled = false, killTimer, settleTimer;
    const stop = message => { reason ||= message; child.kill('SIGTERM'); killTimer ||= setTimeout(() => { child.kill('SIGKILL'); /* 看门狗：不可中断进程连 SIGKILL 也不结算时，强制让队列继续 */ settleTimer ||= setTimeout(() => finish(new Error(reason || '本地转写进程无响应，已强制结束')), 3000); }, 2000); };
    const onAbort = () => stop('音频转写已取消');
    const timer = setTimeout(() => stop('本地音频转写超时，请缩短音频后重试'), timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort);
      clearTimeout(settleTimer);if (error) reject(error); else resolve(value);
    };
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-262144); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-32768); });
    child.on('error', error => finish(new Error(error.code === 'ENOENT' ? '缺少本机转写依赖（FunASR Python 环境），请在设置中检查转写环境' : '无法启动本地音频转写进程')));
    child.on('close', code => {
      if (reason) return finish(new Error(reason));
      if (code !== 0) {
        const detail = stderr.match(/SHENGJI_ASR_ERROR: ([^\n]+)/)?.[1];
        return finish(new Error(detail ? `本地转写失败：${detail.slice(0,500)}` : `音频无法解码或本地转写失败，请检查文件和模型环境（退出码 ${code}）`));
      }
      finish(null, stdout);
    });
  });
}
let statusCache;
export async function getTranscriptionStatus() {
  if (statusCache && Date.now() - statusCache.time < 60_000) return { ...await statusCache.value };
  const value = (async () => {
    try {
      for (const item of [python, ffmpeg, ffprobe, helper]) await fs.access(item);
      const output = await command(python, [helper, '--models', models, '--check']);
      const parsed = JSON.parse(output.trim());
      if (parsed.available !== true) throw new Error('本机转写环境检查失败');
      return { available: true, engine, error: '' };
    } catch (error) {
      return { available: false, engine, error: error.code === 'ENOENT' ? '缺少本机 Python、FFmpeg 或转写模型环境；不会自动下载模型。' : error.message };
    }
  })();
  statusCache = { time: Date.now(), value };
  return { ...await value };
}
export async function transcribeAudio(file, { signal } = {}) {
  if (signal?.aborted) throw new Error('音频转写已取消');
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('音频文件必须是本地绝对路径');
  let stat;
  try { stat = await fs.stat(file); } catch { throw new Error('音频文件不存在或无法读取'); }
  if (!stat.isFile() || stat.size === 0) throw new Error('音频文件为空或不是普通文件');
  if (stat.size > 100 * 1024 * 1024) throw new Error('音频超过 100 MB，请分段导入');
  if (signal?.aborted) throw new Error('音频转写已取消');
  // Probe by content, so audio stored with an extensionless hash works unchanged.
  let probe;
  try { probe = JSON.parse(await command(ffprobe, ['-v','error','-protocol_whitelist','file,pipe','-select_streams','a:0','-show_entries','stream=codec_type:format=duration','-of','json',file], { signal, timeout: 30_000 })); }
  catch (error) { if (/取消|超时|依赖/.test(error.message)) throw error; throw new Error('文件不是可读取的音频，或音频文件已损坏'); }
  if (!probe.streams?.some(stream => stream.codec_type === 'audio')) throw new Error('文件中没有音频轨道');
  const duration = Number(probe.format?.duration);
  if (Number.isFinite(duration) && duration > 7200) throw new Error('音频超过两小时，请分段导入');
  // Inference itself checks and imports its dependencies. Do not launch a second,
  // uncancellable Python status probe inside a cancellable transcription job.
  try { for (const dependency of [python, ffmpeg, ffprobe, helper]) await fs.access(dependency); }
  catch { throw new Error('缺少本机 Python、FFmpeg 或转写环境；不会自动下载模型。'); }
  if (signal?.aborted) throw new Error('音频转写已取消');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shengji-asr-'));
  try {
    const wav = path.join(temp,'input.wav'), output = path.join(temp,'result.json');
    // Decode at most one second beyond the limit, so unknown-duration containers cannot exhaust disk.
    // The helper rejects >7200s; it never reports a truncated long recording as complete.
    await command(ffmpeg, ['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-i',file,'-map','0:a:0','-vn','-ac','1','-ar','16000','-t','7201','-c:a','pcm_s16le','-y',wav], { signal, timeout: 180_000 });
    await command(python, [helper,'--models',models,'--audio',wav,'--output',output], { signal, timeout: Math.max(180_000, Math.min(2_700_000, (Number.isFinite(duration) ? duration : 7200)*1000+120_000)), env: { ...childEnv, TMPDIR: temp } });
    let raw;try{raw=await fs.readFile(output,'utf8')}catch{throw new Error('本地转写结果读取失败，请重试')}
    const result = JSON.parse(raw);
    if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('未识别到可转写的语音，请检查录音是否清晰或只有静音');
    if (!Number.isFinite(result.duration) || result.duration <= 0 || result.duration > 7200 || result.engine !== engine) throw new Error('本地转写结果格式无效，没有保存不完整结果');
    return { text: result.text.trim(), duration: result.duration, engine, language: 'zh' };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
