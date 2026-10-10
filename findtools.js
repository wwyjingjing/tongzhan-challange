/**
 * findtools.js — 找 ffmpeg / python（两个剪辑器工具共用，可直接复制）
 *
 * 目标：换一台电脑也能用。
 *   查找顺序：环境变量指定 → PATH → 工具目录里的 tools\ 或 ffmpeg\bin\ → 常见安装位置 → 开发机兜底
 *   python 会**优先挑带 Pillow 的那个**（烧录 ✅/❌ 需要 Pillow；只装了个空 python 也跑不了）
 *
 * 用法：
 *   const { resolveFfmpeg, resolvePython } = require('./findtools');
 *   const ff = resolveFfmpeg(__dirname);      // { path, ok, source }
 *   const py = resolvePython(__dirname);      // { path, ok, pillow, source, versions }
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const isWin = process.platform === 'win32';

function existsFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; }
}
function fromPath(exe) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, exe);
    if (existsFile(p)) return p;
  }
  return '';
}
function pickFirst(cands) {
  for (const c of cands) if (existsFile(c)) return c;
  return '';
}

function ffmpegCandidates(root) {
  const exe = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const dev = String(process.env.TOOL_NO_DEV_FALLBACK || '').trim() !== '1';   // =1 假装在别人的电脑上（调试/验收用）
  return [
    process.env.CUT_FFMPEG || process.env.BINGO_FFMPEG || process.env.TOOL_FFMPEG,
    fromPath(exe),
    path.join(root, 'tools', exe),
    path.join(root, 'ffmpeg', 'bin', exe),
    path.join(root, 'bin', exe),
    dev && isWin ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : '',
    dev ? (isWin ? 'F:\\ffmpeg-4.4.1-full_build\\bin\\ffmpeg.exe' : '/usr/local/bin/ffmpeg') : '',
  ].filter(Boolean);
}
/** 返回 { path, ok, ver, source }；找不到时 ok=false（path 仍给个 'ffmpeg' 让报错更直观） */
function resolveFfmpeg(root, probe) {
  const cands = ffmpegCandidates(root || __dirname).filter(existsFile);
  for (const c of cands) {
    if (probe === false) return { path: c, ok: true, source: describe(c, root), ver: '' };
    const v = checkFfmpeg(c);
    if (v.ok) return { path: c, ok: true, ver: v.ver, source: describe(c, root) };
  }
  // 上面都没有 → 读缓存（上次扫描找到的）
  const cached = readCache(root || __dirname);
  if (cached && existsFile(cached) && checkFfmpeg(cached).ok) {
    return { path: cached, ok: true, ver: checkFfmpeg(cached).ver, source: describe(cached, root) };
  }
  // 最后：扫描本机常见位置（很多人电脑里其实有 ffmpeg，只是不在 PATH）
  if (String(process.env.TOOL_NO_SCAN || '').trim() !== '1' && probe !== false) {
    const hit = scanForFfmpeg(root || __dirname);
    if (hit) return { path: hit, ok: true, ver: checkFfmpeg(hit).ver, source: describe(hit, root) + '（扫描找到）' };
  }
  return { path: isWin ? 'ffmpeg.exe' : 'ffmpeg', ok: false, ver: '', source: '未找到' };
}

/** 跑一下 -version，拿版本号并确认能用（要求主版本 ≥ 3，太老的不认） */
function checkFfmpeg(p) {
  try {
    const r = spawnSync(p, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const out = String((r.stdout || '') + (r.stderr || ''));
    const m = /ffmpeg version\s+n?(\d+)\.(\d+)/i.exec(out);
    if (!m) return { ok: false, ver: '' };
    const major = parseInt(m[1], 10);
    if (!(major >= 3)) return { ok: false, ver: '', tooOld: true };
    return { ok: true, ver: (out.split('\n')[0] || '').trim().slice(0, 70) };
  } catch (e) { return { ok: false, ver: '' }; }
}

/* ---------- 扫描本机已有的 ffmpeg（限深 / 限时 / 限目录数，找到就停） ---------- */
function scanCacheFile(root) { return path.join(root, 'work', '_tools.json'); }
function readCache(root) {
  try {
    const j = JSON.parse(fs.readFileSync(scanCacheFile(root), 'utf8'));
    return j && j.ffmpeg && existsFile(j.ffmpeg) ? j.ffmpeg : '';
  } catch (e) { return ''; }
}
function writeCache(root, ffmpeg, extra) {
  try {
    fs.mkdirSync(path.join(root, 'work'), { recursive: true });
    fs.writeFileSync(scanCacheFile(root), JSON.stringify(Object.assign({ ffmpeg, scannedAt: new Date().toISOString() }, extra || {}), null, 1), 'utf8');
  } catch (e) {}
}

/**
 * 在常见位置找 ffmpeg.exe（很多录屏/直播软件自带一份）：
 *   工具目录/上一级 → 桌面/下载/视频 → LOCALAPPDATA\Programs → 各盘根目录（限深 3）
 * 找到可用的就立刻停；默认总预算 9 秒、最多进 6000 个目录。结果写进 work\_tools.json 缓存。
 */
function scanForFfmpeg(root, opts) {
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : function () {};
  const exe = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const budgetMs = +(process.env.TOOL_SCAN_MS || o.budgetMs || 9000);
  const maxDirs = +(o.maxDirs || 6000);
  const t0 = Date.now();
  let dirs = 0, best = null;

  const SKIP = /^(windows|winsxs|system32|syswow64|\$recycle\.bin|recovery|perflogs|programdata|node_modules|\.git|temp|tmp|onedrive|音乐|图片)$/i;
  const roots = [];
  const push = p => { if (p && existsFile(p) === false && fs.existsSync(p) && roots.indexOf(p) < 0) roots.push(p); };
  push(path.join(root, '..'));                       // 工具所在文件夹的上一级（常见的解压位置）
  const home = process.env.USERPROFILE || require('os').homedir();
  ['Desktop', 'Downloads', 'Videos', 'Documents'].forEach(d => push(path.join(home, d)));
  push(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '');
  push(process.env.ProgramFiles);
  if (isWin) for (const d of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { if (fs.existsSync(d + ':\\')) push(d + ':\\'); } catch (e) {} }

  const hit = p => {                                  // 命中优先级：能用就行，顺便挑版本高的
    const v = checkFfmpeg(p);
    if (!v.ok) return false;
    const major = +(/(\d+)\./.exec(v.ver.replace(/.*version\s+n?/, '')) || [0, 0])[1];
    if (!best || major > best.major) best = { path: p, major, ver: v.ver };
    return true;
  };

  function walk(dir, depth) {
    if (best || depth > 3 || Date.now() - t0 > budgetMs || dirs > maxDirs) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    dirs++;
    // 先看这个目录里有没有
    for (const e of ents) {
      if (e.isFile() && e.name.toLowerCase() === exe.toLowerCase()) {
        if (hit(path.join(dir, e.name))) return;
      }
    }
    // 再看常见子目录名（ffmpeg/bin 优先，省时间）
    const sub = ents.filter(e => e.isDirectory() && !SKIP.test(e.name) && !e.name.startsWith('.'));
    sub.sort((a, b) => (/^(ffmpeg|bin|tools)$/i.test(b.name) ? 1 : 0) - (/^(ffmpeg|bin|tools)$/i.test(a.name) ? 1 : 0));
    for (const e of sub) { if (best) return; walk(path.join(dir, e.name), depth + 1); }
  }

  log('本机没在 PATH 里找到 ffmpeg，正在扫描常见位置（最多 ' + Math.round(budgetMs / 1000) + ' 秒）…');
  for (const r of roots) {
    if (best || Date.now() - t0 > budgetMs) break;
    walk(r, 0);
  }
  if (best) {
    log('扫描找到 ffmpeg：' + best.path + '（已记进 work/_tools.json，下次直接用）');
    writeCache(root, best.path, { ver: best.ver });
    return best.path;
  }
  log(`扫描结束：没找到（看了 ${dirs} 个目录 / ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  return '';
}
function describe(p, root) {
  if (!p) return '未找到';
  try {
    const rel = path.relative(root || '', p);
    if (rel && !path.isAbsolute(rel) && !rel.startsWith('..')) return '工具目录\\' + rel;
  } catch (e) {}
  return p;
}

function pythonCandidates(root) {
  const names = isWin ? ['python.exe', 'py.exe', 'python3.exe'] : ['python3', 'python'];
  const list = [];
  const envP = process.env.CUT_PY || process.env.BINGO_PY || process.env.TOOL_PY;
  if (envP) list.push(envP);
  const DEV_VENV = 'C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe';
  if (String(process.env.TOOL_NO_DEV_FALLBACK || '').trim() !== '1') list.push(DEV_VENV);   // 工具专用 venv（带 OCR 模型）优先
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const n of names) for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, n);
    if (existsFile(p)) list.push(p);
  }
  if (isWin) {
    const la = process.env.LOCALAPPDATA || '';
    list.push(
      la ? path.join(la, 'Programs', 'Python', 'Python312', 'python.exe') : '',
      la ? path.join(la, 'Programs', 'Python', 'Python311', 'python.exe') : '',
      la ? path.join(la, 'Programs', 'Python', 'Python310', 'python.exe') : '',
      'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe', 'C:\\Python310\\python.exe'
    );
  }
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c) continue;
    let key = c.toLowerCase();
    try { key = fs.realpathSync(c).toLowerCase(); } catch (e) {}
    if (seen.has(key)) continue;
    seen.add(key);
    if (!existsFile(c)) continue;
    out.push(c);
  }
  return out;
}

/**
 * 挑一个 python：**优先带 rapidocr_onnxruntime 的**（本地 OCR 自动打点要用），
 * 其次是带 Pillow 的（历史备用路径），都没有就给第一个能跑的。
 * 返回 { path, ok, pillow, ocr, ver, pillowVer, ocrVer, source, versions }
 */
function resolvePython(root, maxProbe) {
  const cands = pythonCandidates(root || __dirname);
  const n = maxProbe == null ? 5 : maxProbe;
  const probe = [
    '-c',
    "import sys;v=sys.version.split()[0];p='';o=''\n" +
    "try:\n import PIL;p=PIL.__version__\nexcept Exception: pass\n" +
    "try:\n import rapidocr_onnxruntime as r;o=getattr(r,'__version__','?')\nexcept Exception: pass\n" +
    "print(v+'|'+p+'|'+o)",
  ];
  const versions = [];
  let bestOcr = null, bestPil = null, bestAny = null;
  for (const c of cands.slice(0, n)) {
    const r = spawnSync(c, probe, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const out = String((r.stdout || '') + (r.stderr || '')).trim().split('\n').pop() || '';
    if (r.error || r.status !== 0 || out.indexOf('|') < 0) continue;
    const [v, pil, ocr] = out.split('|');
    const rec = { path: c, ok: true, ver: v, pillowVer: pil, ocrVer: ocr,
      pillow: !!pil, ocr: !!ocr && ocr !== '', source: describe(c, root) };
    versions.push({ path: c, ver: v, pillow: rec.pillow, ocr: rec.ocr });
    if (!bestAny) bestAny = rec;
    if (rec.ocr && !bestOcr) bestOcr = rec;
    if (rec.pillow && !bestPil) bestPil = rec;
    if (bestOcr) break;                                     // 找到带 OCR 的就够了
  }
  const pick = bestOcr || bestPil || bestAny;
  if (pick) return Object.assign(pick, { versions });
  return { path: isWin ? 'python.exe' : 'python', ok: false, pillow: false, ocr: false,
    ver: '', pillowVer: '', ocrVer: '', source: '未找到', versions: [] };
}

module.exports = { resolveFfmpeg, resolvePython, scanForFfmpeg, checkFfmpeg, readCache, writeCache,
  ffmpegCandidates, pythonCandidates, existsFile, fromPath, pickFirst };
