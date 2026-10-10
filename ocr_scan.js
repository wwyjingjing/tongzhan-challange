/**
 * ocr_scan.js —— 本地 OCR 自动打点：找「视频字幕文字变化的瞬间」
 *
 * 全程离线：ffmpeg 抽帧 + RapidOCR（ONNX 本地模型，走 ocr_worker.py）。
 *
 * 三段式（每段都能单独跑、单独测）：
 *   ① 变化点探测：把字幕条带按 fps 采样，用 ffmpeg 的 scene 检测找出「画面上字幕变了」的时刻；
 *      再做合并（相邻太近的算一次转换）+ 抽稀（不超过 maxCand）。
 *   ② 取文字：对每个变化点取 **t + delay（默认 0.5s）** 那一帧并 OCR ——
 *      这样拿到的是「变化之后新出现的那句」，而不是旧句/空帧（字幕有短暂空隙时也不会踩空）。
 *   ③ 分组：把相邻帧的文字归一化后比相似度，低于阈值才算「换了一句」，
 *      取这一句第一次出现的那个「变化点」作为切点时间（不是取帧时间）。
 *
 * 参数（都能在界面上调）：
 *   bandY/bandH  字幕条带位置与高度（占画面比例，默认下 1/4）
 *   fps          采样帧率（默认 8；越高越不漏，但更慢）
 *   scene        灵敏度阈值（默认 0.04；越小越敏感）
 *   delay        变化点之后多久取帧（默认 0.5 秒）
 *   sim          文字相似度阈值（默认 0.72；越高越容易判定为"换句"）
 *   minGap       两个切点最小间隔（默认 0.8 秒）
 *   minLen       文字太短就忽略（默认 2 字，滤掉噪声/字幕消失）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/* ---------- 小工具 ---------- */
function run(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    let out = '', err = '';
    const p = spawn(cmd, args, { windowsHide: true });
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} }, timeoutMs || 30 * 60 * 1000);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: err + '\n' + e.message }); });
    p.on('close', c => { clearTimeout(t); resolve({ code: c, out, err }); });
  });
}

/** 归一化：去掉所有空白和标点、统一大小写（OCR 常把空格/标点漏掉或多加） */
function norm(s) {
  return String(s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、！？：；,.!?:;"'`~（）()\[\]【】《》<>…—\-·]/g, '')
    .toLowerCase();
}

/** 相似度（0~1）：归一化后的 Levenshtein 距离换算 */
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > Math.max(m, n) * 0.85) return 0;      // 长度差太多直接判不同，省时间
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** 相邻太近的变化点合并成一个（一次转换只留最早那个） */
function mergeTimes(times, minGap) {
  const out = [];
  for (const t of times.slice().sort((a, b) => a - b)) {
    if (!out.length || t - out[out.length - 1] >= minGap) out.push(t);
  }
  return out;
}

/* ---------- ① 探测变化点（一次解码，不落盘） ---------- */
async function detectChanges(cfg, log) {
  const { ffmpeg, src, from, to, fps, scene, bandY, bandH } = cfg;
  const cropH = Math.max(0.02, Math.min(1, bandH));
  const cropY = Math.max(0, Math.min(1 - cropH, bandY));
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info'];
  if (from > 0) args.push('-ss', from.toFixed(3));
  args.push('-i', src);
  if (to > from) args.push('-t', (to - from).toFixed(3));
  args.push('-vf',
    `fps=${fps},crop=iw:ih*${cropH.toFixed(4)}:0:ih*${cropY.toFixed(4)},select='gt(scene,${scene})',showinfo`,
    '-an', '-sn', '-f', 'null', '-');
  if (log) log(`① 扫描字幕区域（每秒采样 ${fps} 帧 · 灵敏度 ${scene} · 区域 ${Math.round(cropY * 100)}%~${Math.round((cropY + cropH) * 100)}%）…`);
  const r = await run(ffmpeg, args, cfg.timeoutMs);
  const times = [];
  const re = /pts_time:\s*([0-9.]+)/g;
  let m;
  while ((m = re.exec(r.err || ''))) times.push(+(+m[1] + (from > 0 ? from : 0)).toFixed(3));
  const merged = mergeTimes(times, Math.max(0.1, cfg.minGap));
  if (log) log(`   原始变化点 ${times.length} 处 → 合并后 ${merged.length} 处`);
  return merged;
}

/* ---------- ② 在 t+delay 处取帧（并发小池子，快） ---------- */
async function extractFrames(cfg, times, log) {
  const { ffmpeg, src, dir, delay, bandY, bandH } = cfg;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    if (/^o_\d+\.png$/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
  }
  const cropH = Math.max(0.02, Math.min(1, bandH));
  const cropY = Math.max(0, Math.min(1 - cropH, bandY));
  const items = [];
  let i = 0, done = 0, fails = false;
  const CONC = 4;
  const worker = async () => {
    while (i < times.length) {
      const k = i++;
      const t = times[k];
      const file = path.join(dir, `o_${String(k).padStart(5, '0')}.png`);
      const at = Math.max(0, t + delay);
      // 条带先缩到最多 960 宽再交给 OCR：字幕够大，识别一样准，但快 2~3 倍
      const vf = `crop=iw:ih*${cropH.toFixed(4)}:0:ih*${cropY.toFixed(4)},scale='min(960,iw)':-2`;
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(3), '-i', src,
        '-frames:v', '1', '-vf', vf, '-f', 'image2', file];
      const r = await run(ffmpeg, args, 120000);
      if (r.code === 0 && fs.existsSync(file)) items.push({ id: 'k' + k, t, at: +at.toFixed(3), image: file });
      else if (log && !fails) {                          // 第一次失败就把原因打出来，方便排查
        fails = true;
        const why = String(r.err || '').split(String.fromCharCode(10)).filter(Boolean).slice(-1)[0] || ('退出码 ' + r.code);
        log('   ! 取帧失败（t=' + t + '）：' + why.slice(0, 200));
      }
      done++;
      if (log && (done % 25 === 0 || done === times.length)) log(`② 取帧 ${done}/${times.length} …`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, times.length) }, worker));
  items.sort((a, b) => a.t - b.t);
  return items;
}

/* ---------- ③ 批量 OCR（ocr_worker.py，一次进程只加载一次模型） ---------- */
async function runOcr(cfg, items, log) {
  const { py, worker, workDir } = cfg;
  const CHUNK = 400;
  const out = new Map();
  for (let i = 0; i < items.length; i += CHUNK) {
    const part = items.slice(i, i + CHUNK);
    const inP = path.join(workDir, `ocr_in_${Date.now()}_${i}.json`);
    const outP = inP.replace(/\.json$/, '.out.json');
    fs.writeFileSync(inP, JSON.stringify({ items: part.map(x => ({ id: x.id, image: x.image })) }), 'utf8');
    const r = await run(py, [worker, inP, outP], cfg.timeoutMs);
    let res = null;
    try { res = JSON.parse(fs.readFileSync(outP, 'utf8')); } catch (e) {}
    try { fs.unlinkSync(inP); fs.unlinkSync(outP); } catch (e) {}
    if (!res || !res.ok) {
      const detail = (res && (res.errors || []).join('; ')) || (r.err || '').split('\n').filter(Boolean).slice(-2).join(' | ') || ('python 退出码 ' + r.code);
      const err = new Error(String(detail).slice(0, 400));
      err.ocrMissing = /rapidocr|No module|import failed|ModuleNotFound/i.test(String(detail));
      throw err;
    }
    for (const [id, v] of Object.entries(res.results || {})) out.set(id, v);
    if (log) log(`③ OCR 识别 ${Math.min(i + CHUNK, items.length)}/${items.length} …`);
  }
  return out;
}

/* ---------- ④ 分组：文字真的换了才算一个切点 ---------- */
function groupChanges(items, ocr, opt) {
  const sim = opt.sim, minLen = opt.minLen;
  const rows = items.map(it => {
    const v = ocr.get(it.id) || {};
    return { t: it.t, at: it.at, text: String(v.text || '').replace(/\n/g, ' ').trim(), score: v.avgScore || 0 };
  });
  const changes = [];
  let curT = null, curAt = null;
  for (const r of rows) {
    const n = norm(r.text);
    if (n.length < minLen) continue;                       // 空帧 / 太短（字幕消失、噪声）
    if (curT == null) { curT = r.text; curAt = r.t; continue; }
    const s = similarity(curT, r.text);
    if (s >= sim) {                                        // 还是同一句：用更完整的那次识别纠偏
      if (r.text.length > curT.length) curT = r.text;
      continue;
    }
    changes.push({ t: +curAt.toFixed(3), text: curT });     // 上一句：从它第一次出现的「变化点」开始
    curT = r.text; curAt = r.t;
  }
  if (curT != null) changes.push({ t: +curAt.toFixed(3), text: curT });
  return { rows, changes };
}

/* ---------- 对外：一次完整扫描 ---------- */
async function scan(cfg, log) {
  const t0 = Date.now();
  const times = await detectChanges(cfg, log);
  if (!times.length) {
    return { ok: true, changes: [], rows: [], stats: { detected: 0, ocr: 0, kept: 0, seconds: +((Date.now() - t0) / 1000).toFixed(1) } };
  }
  let capped = times;
  if (cfg.maxCand && times.length > cfg.maxCand) {
    const step = times.length / cfg.maxCand;
    capped = [];
    for (let i = 0; i < cfg.maxCand; i++) capped.push(times[Math.floor(i * step)]);
    if (log) log(`   变化点 ${times.length} 处 → 抽稀到 ${cfg.maxCand} 处（把灵敏度调低或缩小范围可以保留更多）`);
  }
  const items = await extractFrames(cfg, capped, log);
  const ocr = await runOcr(cfg, items, log);
  const g = groupChanges(items, ocr, { sim: cfg.sim, minLen: cfg.minLen });
  if (log) log(`④ 分组完成：候选 ${items.length} 帧 → 换句 ${g.changes.length} 次（总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  return {
    ok: true,
    changes: g.changes,
    rows: cfg.returnRows === false ? [] : g.rows,
    stats: { detected: times.length, used: items.length, ocr: g.rows.length, kept: g.changes.length, seconds: +((Date.now() - t0) / 1000).toFixed(1) },
  };
}

/** OCR 后端可用性（快，只 import 不建模型） */
async function check(py) {
  const r = await run(py, ['-c', 'import rapidocr_onnxruntime as m;print(getattr(m,"__version__","?"))'], 30000);
  if (r.code === 0) return { ok: true, backend: 'RapidOCR（本地离线模型）', version: (r.out || '').trim() };
  const msg = ((r.err || '') + (r.out || '')).split('\n').filter(Boolean).slice(-1)[0] || '';
  return { ok: false, backend: 'RapidOCR', error: msg, hint: 'pip install rapidocr_onnxruntime（本地离线，约 60MB）' };
}

module.exports = { scan, check, norm, similarity, mergeTimes, detectChanges, extractFrames, groupChanges };
