/**
 * 童站挑战剪辑器 —— 本地服务端（零依赖，仅用 Node 内置模块）
 *
 * 职责：把「自动切分 → 人工审核 → OCR 判定 → 导出切片」整条链路包在工具内部，
 * 用户点按钮即可，无需复制命令到外部终端运行。
 *
 * 依赖：本机 ffmpeg / ffprobe（已在 PATH），以及 venv 里的 RapidOCR。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------- 环境常量 ----------
const FFMPEG = 'ffmpeg';
const FFPROBE = 'ffprobe';
const NODE = process.execPath;
const PY = process.env.CUT_PY || 'C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe';
const OCR_WORKER = path.join(__dirname, 'ocr_worker.py');
const OVERLAY_PY = process.env.CUT_OVERLAY_PY || path.join(__dirname, 'overlay_gen.py'); // ✅/❌+编号 合成
const PICK_PS1 = path.join(__dirname, 'pick_file.ps1');   // 原生文件对话框

const ROOT = __dirname;
const WORK = path.join(ROOT, 'work');        // 中间产物（帧图、清单）
const OUT = path.join(ROOT, 'output');       // 最终切片
const PUBLIC = path.join(ROOT, 'public');
const ASSETS = path.join(ROOT, 'assets');    // 对.mp3 / 错.mp3 等内置素材
const BADGES = path.join(WORK, 'badges');    // 每次导出生成的标记图
const BURN_TMP = path.join(WORK, 'burn_tmp');// 烧录时的临时混音文件

// 手动打点模式的默认输出（用户指定：切片不覆盖旧产物，单独子目录；ASS 覆盖指定文件）
const DEFAULT_OUT_DIR = process.env.CUT_OUT_DIR || 'F:\\workbuddy\\2026-10-02-12-47-05\\output\\manual';
const DEFAULT_ASS_PATH = process.env.CUT_ASS_PATH || 'F:\\workbuddy\\2026-10-02-12-47-05\\output\\无标题.ass';

// 烧录标记（✅/❌ + 编号 + 音效）默认值
const DEFAULT_SFX_OK = process.env.CUT_SFX_OK || path.join(ASSETS, '对.mp3');
const DEFAULT_SFX_NO = process.env.CUT_SFX_NO || path.join(ASSETS, '错.mp3');
const DEFAULT_BADGE_FONT = process.env.CUT_BADGE_FONT || 'C:\\Windows\\Fonts\\msyhbd.ttc';

/** 烧录配置默认值（前端会整体覆盖，这里保证服务端单独调用也安全） */
const DEFAULT_BURN = {
  enabled: true,          // 是否烧录 ✅/❌ + 编号
  badgeScale: 0.22,       // 符号宽度 = 画面宽 × 该值
  numberSize: 0.055,      // 编号字号 = 画面高 × 该值
  gap: 0.012,             // 符号与编号间距 = 画面高 × 该值
  order: 'badgeTop',      // badgeTop=符号在上 | numberTop=编号在上
  anchor: 'bottom-center',// 九宫格锚点
  offsetX: 0,             // 附加偏移（画面宽/高的比例）
  offsetY: -0.06,
  numberColor: '#FFFFFF',
  numberStroke: '#000000',
  strokeWidth: 0.004,     // 描边宽 = 画面高 × 该值
  delay: 0.5,             // 符号（+音效）在切片开始多少秒后出现；切片过短自动提前
  numberDelay: 0,         // 编号出现延迟（默认 0：从第一帧就有）
  badgeShow: 3,           // 符号出现后显示多少秒消失（0 = 不消失）
  numberShow: 0,          // 编号显示多少秒后消失（默认 0 = 不消失，一直显示到片尾）
  fontPath: DEFAULT_BADGE_FONT,
  badgeStyle: 'emoji',    // emoji=系统彩色表情 | vector=矢量绿勾/红叉
  badgeOkImage: '',
  badgeNoImage: '',
  sfxEnabled: true,       // 是否混入对/错音效
  sfxOkPath: DEFAULT_SFX_OK,
  sfxNoPath: DEFAULT_SFX_NO,
  sfxVolume: 1.0,
  writeClean: true,       // 同时输出未烧录的干净切片到 clips/
};
const ANCHORS = ['top-left', 'top-center', 'top-right', 'mid-left', 'center', 'mid-right', 'bottom-left', 'bottom-center', 'bottom-right'];

for (const d of [WORK, OUT, path.join(WORK, 'frames'), BADGES, BURN_TMP, ASSETS]) fs.mkdirSync(d, { recursive: true });

// 端口：CUT_PORT 只接受 1–65535，异常值（空/非数字）一律回退 8777，避免 listen(NaN) 直接崩
const PORT = (() => {
  const p = parseInt(process.env.CUT_PORT, 10);
  return (isFinite(p) && p > 0 && p < 65536) ? p : 8777;
})();
// 并发：烧录（overlay + amix）比纯切片吃 CPU，默认降到 3；可用 CUT_CONC 覆盖
const CONC = Math.max(1, Math.min(8, +(process.env.CUT_CONC || 0) || 3));

// ---------- 小工具 ----------
const log = (...a) => console.log('[cut]', ...a);
const pad3 = n => String(n).padStart(3, '0');

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 200 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!raw.length) return resolve({});
      try { resolve(JSON.parse(raw.toString('utf8'))); }
      catch (e) { reject(new Error('bad json: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

// 执行命令，收集 stdout/stderr
function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString('utf8'));
    p.stderr.on('data', d => err += d.toString('utf8'));
    p.on('error', e => resolve({ code: -1, out, err: err + '\n' + e.message }));
    p.on('close', code => resolve({ code, out, err }));
  });
}

// 带超时的执行（用于可能挂起的交互式命令，如文件对话框）
function runWithTimeout(cmd, args, ms, opts = {}) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '', err = '', done = false;
    const finish = res => { if (done) return; done = true; clearTimeout(timer); resolve(res); };
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} finish({ code: -1, out, err, timeout: true }); }, ms);
    p.stdout.on('data', d => out += d.toString('utf8'));
    p.stderr.on('data', d => err += d.toString('utf8'));
    p.on('error', e => finish({ code: -1, out, err: err + '\n' + e.message }));
    p.on('close', code => finish({ code, out, err }));
  });
}

// ---------- 任务系统（长任务轮询）----------
const jobs = new Map();
let jobSeq = 0;

function newJob(kind) {
  const id = kind + '-' + (++jobSeq);
  jobs.set(id, { id, kind, state: 'running', progress: 0, total: 0, message: '准备中…', result: null, error: null, logs: [] });
  return id;
}
function jobLog(id, msg) {
  const j = jobs.get(id);
  if (!j) return;
  j.message = msg;
  j.logs.push(msg);
  if (j.logs.length > 300) j.logs.shift();
  log(id, msg);
}

// ---------- 1. 探针 ----------
async function probe(src) {
  const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', src]);
  if (r.code !== 0) throw new Error('ffprobe 失败: ' + r.err.slice(0, 400));
  const info = JSON.parse(r.out);
  const v = (info.streams || []).find(s => s.codec_type === 'video') || {};
  const a = (info.streams || []).find(s => s.codec_type === 'audio') || {};
  return {
    duration: parseFloat(info.format && info.format.duration || 0),
    size: parseInt(info.format && info.format.size || 0, 10),
    bitrate: parseInt(info.format && info.format.bit_rate || 0, 10),
    vcodec: v.codec_name || null,
    width: v.width || 0, height: v.height || 0,
    acodec: a.codec_name || null,
    sampleRate: a.sample_rate || null,
    channels: a.channels || 0,
  };
}

// ---------- 2. 音频自动切分（silencedetect）----------
/**
 * 「简单音频截断」：检测静音段，把每段静音的中点作为切分点。
 * 只解码音频（-vn -map 0:a），速度快很多。
 */
async function autoSplit(src, opt) {
  const opt_v = {
    mode: opt.mode || 'silence',                        // 'silence' | 'equal'
    chunk: opt.chunk != null ? +opt.chunk : 30,          // 等长模式：每片秒数
    noise: opt.noise || '-30dB',
    minSilence: opt.minSilence != null ? opt.minSilence : 0.6,
    minClip: opt.minClip != null ? opt.minClip : 0.8,
    padding: opt.padding != null ? opt.padding : 0.05, // 切点相对静音中点的微调
  };

  // ---- 等长切分：按固定时长均分 ----
  if (opt_v.mode === 'equal') {
    const info = await probe(src);
    const D = info.duration;
    const n = Math.max(1, Math.round(D / opt_v.chunk));
    const cuts = [];
    for (let i = 1; i < n; i++) cuts.push(+(i * D / n).toFixed(3));
    return { silences: [], cuts, opt: opt_v, equal: true, pieces: n };
  }

  const a = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', src,
    '-vn', '-map', '0:a:0',
    '-af', `silencedetect=noise=${opt_v.noise}:d=${opt_v.minSilence}`,
    '-f', 'null', '-'], { });

  const err = a.err + a.out;
  if (!/silence_/.test(err)) {
    // 没有静音段，退化为整段
    return { silences: [], cuts: [], opt: opt_v, raw: err.slice(-2000) };
  }

  const starts = [];
  const reStart = /silence_start:\s*(-?[\d.]+)/g;
  const reEnd = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g;

  let m;
  const sList = [];
  while ((m = reStart.exec(err))) sList.push({ start: parseFloat(m[1]), end: null, dur: null });
  const eList = [];
  while ((m = reEnd.exec(err))) eList.push({ end: parseFloat(m[1]), dur: parseFloat(m[2]) });

  // 按顺序配对
  let ei = 0;
  const silences = [];
  for (const s of sList) {
    if (ei < eList.length && eList[ei].end >= s.start) {
      s.end = eList[ei].end; s.dur = eList[ei].dur; ei++;
    } else {
      s.end = null; s.dur = null; // 尾部静音（视频以此结束）
    }
    silences.push({ start: s.start, end: s.end, dur: s.dur });
  }

  // 切分点 = 静音中点（尾部未闭合的静音用 start）
  let cuts = silences.map(s => (s.end != null ? (s.start + s.end) / 2 : s.start) + opt_v.padding)
    .filter(t => t > opt_v.minClip);

  cuts.sort((a, b) => a - b);
  // 合并过近的切点
  const merged = [];
  for (const t of cuts) {
    if (!merged.length || t - merged[merged.length - 1] >= opt_v.minClip) merged.push(t);
  }
  return { silences, cuts: merged, opt: opt_v, raw: err.slice(-3000) };
}

// ---------- 3. 取某一时刻的帧（返回 jpeg buffer）----------
function grabFrame(src, t, width) {
  return new Promise(resolve => {
    const args = ['-hide_banner', '-nostats', '-loglevel', 'error',
      '-ss', String(Math.max(0, t)), '-i', src,
      '-frames:v', '1', '-vf', `scale=${width}:-2`, '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'];
    const p = spawn(FFMPEG, args, { windowsHide: true });
    const chunks = [];
    let err = '';
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.on('data', d => err += d.toString());
    p.on('close', () => resolve({ buf: Buffer.concat(chunks), err }));
    p.on('error', e => resolve({ buf: Buffer.alloc(0), err: String(e) }));
  });
}

// ---------- 4. OCR 判定规则 ----------
/**
 * 加权判定，避免误伤。
 * 关键经验：录屏类素材（如网页/APP 录屏）画面里会大量出现平台 UI 文字
 * （bilibili、人正在看、关注、点赞、播放量…），若把这类词当广告，
 * 会导致几乎整片被判为「剔除」。因此分三档：
 *   强特征词（weight 3）：只有真正的广告/引流话术才算，单独命中即可判定
 *   弱特征词（weight 1）：需要累积到阈值才判定
 *   噪声词（weight 0）：平台界面元素，明确不参与判定（仅记录）
 */
const CUT_STRONG = [
  '独家赞助', '本节目由', '本视频由', '由.{0,6}独家', '特别鸣谢', '冠名播', '赞助播出', '赞助商',
  '商务合作', '商务微信', '合作请加', '广告位', '招商',
  '加群', '加我', '扫码', '扫一扫', '二维码', '公众号回复', '领取资料', '领取课程', '免费领',
  '限时优惠', '优惠券', '下单立减', '购买链接', '淘宝搜', '天猫店', '京东自营', '拼多多',
];
const CUT_WEAK = [
  '公众号', '私信', '咨询', '热线', '官网', '网址', '下载app', '报名', '学费',
  '关注', '点赞', '投币', '收藏', '订阅', '转发', '一键三连',
  '优惠', '折扣', '促销', '福利', '抽奖', '领取', '购买', '下单',
  '片头', '片尾', '下集', '预告', '花絮', '招募', '招聘',
];
// 平台/界面噪声：命中不计分，防止录屏素材被整体误判
const NOISE_WORDS = [
  'bilibili', '哔哩哔哩', '人正在看', '正在看', '弹幕', '播放', '评论', '简介',
  '粉丝', '关注列表', '首页', '推荐', '搜索', '登录', '注册', '设置', '消息',
  '投币已', '分享', '收藏夹', '大会员', '充电', '追番', '动态',
];
const KEEP_WORDS = [
  '第[一二三四五六七八九十0-9]+[章节讲部分]', '知识点', '例题', '习题', '总结', '回顾',
  '我们来看', '接下来', '上一节', '这一节', '讲解', '教程', '课程', '定义', '概念', '结论',
  '目录', '大纲', '作业', '考试', '重点', '难点', '公式', '定理', '证明',
];
const CUT_THRESHOLD = 3;   // 加权分达到此值才建议剔除

function classify(text) {
  const raw = text || '';
  const t = raw.replace(/\s+/g, '');
  const strongHits = [], weakHits = [], keepHits = [], noiseHits = [];
  const test = (w, arr) => { try { if (new RegExp(w, 'i').test(t)) arr.push(w); } catch (e) {} };

  for (const w of CUT_STRONG) test(w, strongHits);
  for (const w of CUT_WEAK) test(w, weakHits);
  for (const w of KEEP_WORDS) test(w, keepHits);
  for (const w of NOISE_WORDS) test(w, noiseHits);

  const cutScore = strongHits.length * 3 + weakHits.length * 1;
  const keepScore = keepHits.length;

  let suggestion, reason;
  if (!t) {
    suggestion = 'unsure'; reason = '无可识别文字';
  } else if (strongHits.length) {
    suggestion = 'cut'; reason = '命中强广告特征：' + strongHits.join('、');
  } else if (cutScore >= CUT_THRESHOLD && cutScore > keepScore) {
    suggestion = 'cut'; reason = `弱特征累积 ${cutScore} 分（阈值 ${CUT_THRESHOLD}）：` + weakHits.join('、');
  } else if (keepScore > 0) {
    suggestion = 'keep'; reason = '命中课程内容特征：' + keepHits.join('、');
  } else if (noiseHits.length >= 2 && cutScore < CUT_THRESHOLD) {
    // 典型录屏界面：大量平台 UI 文字但无广告特征 -> 保留
    suggestion = 'keep'; reason = '以平台界面文字为主，未见广告特征';
  } else if (cutScore > 0) {
    suggestion = 'unsure'; reason = `弱特征 ${cutScore} 分、未达阈值（${CUT_THRESHOLD}），建议人工确认`;
  } else {
    suggestion = 'keep'; reason = '未命中剔除特征';
  }

  return {
    suggestion, reason,
    cutScore, keepScore,
    // 只把真正参与判定的词暴露给前端（噪声词单独列，避免误导）
    cutHits: [...strongHits, ...weakHits],
    strongHits, weakHits, keepHits, noiseHits,
    textLen: t.length,
  };
}

// ---------- 5. 渲染切片 ----------
async function renderClips(src, plan, mode, onTick) {
  const results = { keep: [], cut: [], errors: [] };
  const total = plan.keep.length + plan.cut.length;
  let done = 0;

  const cut = (item, seq, group) => new Promise(resolve => {
    const dur = item.end - item.start;
    if (dur <= 0.02) return resolve({ skipped: true });
    fs.mkdirSync(path.join(OUT, group), { recursive: true });
    const outFile = path.join(OUT, group, `${group}_${pad3(seq)}.mp4`);
    const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-y',
      '-ss', item.start.toFixed(3), '-i', src, '-t', dur.toFixed(3)];
    if (mode === 'copy') {
      args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
    }
    args.push(outFile);
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let e = '';
    p.stderr.on('data', d => e += d.toString());
    const finish = code => {
      done++;
      if (onTick) onTick(done, total);
      if (code === 0) {
        let size = 0; try { size = fs.statSync(outFile).size; } catch (err) {}
        resolve({ file: path.relative(OUT, outFile).replace(/\\/g, '/'), start: item.start, end: item.end, size });
      } else {
        results.errors.push({ start: item.start, error: e.slice(0, 300) });
        resolve({ error: true });
      }
    };
    p.on('close', finish);
    p.on('error', () => finish(-1));
  });

  // 限制并发，避免打满 CPU / 磁盘
  const CONC = 4;
  async function runGroup(list, group) {
    const queue = list.map((it, i) => ({ it, seq: i + 1, group }));
    const workers = Array.from({ length: Math.min(CONC, queue.length || 1) }, async () => {
      while (queue.length) {
        const job = queue.shift();
        const r = await cut(job.it, job.seq, job.group);
        if (r && r.file) results[group].push(r);
      }
    });
    await Promise.all(workers);
    // 并发完成顺序不定，按文件名序号还原先后顺序
    results[group].sort((a, b) => a.file.localeCompare(b.file));
  }
  await runGroup(plan.keep, 'keep');
  await runGroup(plan.cut, 'cut');
  return results;
}

// ---------- 6. 手动打点：编号规则 +（已停用）ASS 生成 ----------
// 注：编号现在直接烧进画面，导出流程已不再写 ASS。
//     下面这些 ASS 工具函数 + /api/ass-styles 保留备用（想要恢复字幕方案时可直接接回）。
//     ASS_FALLBACK_HEADER / readAssHeader / assTime / buildAssText / writeFileRobust / writeAssResilient 均无调用方。
/**
 * 编号规则（用户指定）：
 *   按时间顺序从 1 递增；某段被标为「错误」时，**该段本身仍参与编号**，
 *   但它之后的一段重新从 1 开始。
 *   例：A=1 B=2 C=3(错误) → D=1 E=2
 * 文件命名（clip_001.mp4…）始终按时间顺序，不受编号重置影响。
 */
function assignNumbers(segs, errSet) {
  let counter = 1;
  for (const s of segs) {
    s.err = errSet.has(s.seq);
    s.num = counter;
    counter = s.err ? 1 : counter + 1;   // 出错后下一条回到 1
  }
  return segs;
}

// ASS 时间戳：H:MM:SS.CC（Aegisub 惯例，两位百分秒）
function assTime(t) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  const cc = Math.floor((t % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
}

const ASS_FALLBACK_HEADER = [
  '[Script Info]',
  '; 由 童站挑战剪辑器 生成',
  'Title: Default Aegisub file',
  'ScriptType: v4.00+',
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  'YCbCr Matrix: TV.601',
  'PlayResX: 1080',
  'PlayResY: 1920',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1',
].join('\r\n');

/**
 * 读取已有 .ass 的头部（Script Info / Project Garbage / Styles）以便原样保留用户样式，
 * 只替换 [Events] 段。文件不存在则用内置兜底头部。
 */
function readAssHeader(assPath) {
  if (!assPath || !fs.existsSync(assPath)) {
    return { header: ASS_FALLBACK_HEADER, styles: ['Default'], exists: false };
  }
  let txt;
  try {
    txt = fs.readFileSync(assPath, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    // 被独占占用 / 路径是目录 → 不中断流程，退回默认模板，稍后写入时再走降级逻辑
    return { header: ASS_FALLBACK_HEADER, styles: ['Default'], exists: false, readError: (e && e.code) || 'EACCES' };
  }
  const m = txt.search(/^\[Events\]/m);
  let header = (m >= 0 ? txt.slice(0, m) : txt).replace(/[\s\r\n]+$/, '');
  const styles = [...header.matchAll(/^\s*Style:\s*([^,]+),/gm)].map(x => x[1].trim()).filter(Boolean);
  if (!/\[V4\+ Styles\]/.test(header)) header = ASS_FALLBACK_HEADER;
  return { header, styles: styles.length ? styles : ['Default'], exists: true };
}

function buildAssText(segs, style, includeErrors) {
  const evs = segs
    .filter(s => includeErrors || !s.err)
    .map(s => `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},${style},,0,0,0,,${s.num}`);
  return evs;
}

function tsStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 稳健写入：Windows 上若目标文件被别的程序打开（Aegisub/剪映/播放器）会报 EPERM/EBUSY/EACCES。
// 这里重试 + 尝试清只读位，仍失败则交给调用方退回到时间戳副本，绝不中断整个导出流程。
function writeFileRobust(p, data) {
  let last = null;
  for (let i = 0; i < 3; i++) {
    try { fs.writeFileSync(p, data, 'utf8'); return { ok: true, path: p }; }
    catch (e) { last = e; }
  }
  try { fs.chmodSync(p, 0o666); fs.writeFileSync(p, data, 'utf8'); return { ok: true, path: p }; }
  catch (e) { last = e; }
  return { ok: false, error: last };
}

// 写 ASS；被占用时自动改写为同目录 `<名>_<时间戳>.ass`，返回实际落盘路径与告警文案
function writeAssResilient(assPath, payload, jobId, lineCount, existed) {
  const dir = path.dirname(assPath);
  fs.mkdirSync(dir, { recursive: true });
  // 覆盖前自动留底：每次导出前把原文件另存 _autobak/，误操作也能找回
  if (existed) {
    try {
      const bkDir = path.join(dir, '_autobak');
      fs.mkdirSync(bkDir, { recursive: true });
      const src0 = fs.readFileSync(assPath);
      fs.writeFileSync(path.join(bkDir, `${path.basename(assPath, path.extname(assPath))}_${tsStamp()}${path.extname(assPath) || '.ass'}`), src0);
    } catch (e) { jobLog(jobId, `原 ASS 自动备份失败（${(e && e.code) || e}），继续导出`); }
  }
  const w = writeFileRobust(assPath, payload);
  if (w.ok) {
    jobLog(jobId, `已写入 ASS：${assPath}（${lineCount} 行${existed ? '，保留原样式' : '，使用默认模板'}）`);
    return { path: assPath, warning: '' };
  }
  const ext = path.extname(assPath) || '.ass';
  const base = path.basename(assPath, ext);
  const alt = path.join(dir, `${base}_${tsStamp()}${ext}`);
  const w2 = writeFileRobust(alt, payload);
  if (w2.ok) {
    const warning = `目标 ASS 被其他程序占用（${w.error && w.error.code || 'EPERM'}），已改写到：${alt}。关闭占用它的程序（如 Aegisub / 剪映 / 播放器）后重试可写回原文件。`;
    jobLog(jobId, warning);
    return { path: alt, warning };
  }
  const warning = `ASS 写入失败（${(w2.error || w.error || {}).code || 'EPERM'}）：${assPath} 可能正被 Aegisub / 剪映 / 播放器打开。请关闭后重试。`;
  jobLog(jobId, warning);
  return { path: null, warning };
}

// ---------- 7. 烧录标记（✅/❌ + 编号 + 音效）----------
function clampF(v, lo, hi, dft) {
  const n = Number(v);
  if (!isFinite(n)) return dft;
  return Math.max(lo, Math.min(hi, n));
}

/** 归一化烧录配置（前端只传部分字段也能安全使用） */
function normBurn(raw) {
  const b = Object.assign({}, DEFAULT_BURN, raw || {});
  b.enabled = b.enabled !== false;
  b.sfxEnabled = b.sfxEnabled !== false;
  b.writeClean = b.writeClean !== false;
  b.badgeScale = clampF(b.badgeScale, 0.04, 0.8, DEFAULT_BURN.badgeScale);
  b.numberSize = clampF(b.numberSize, 0.01, 0.25, DEFAULT_BURN.numberSize);
  b.gap = clampF(b.gap, 0, 0.25, DEFAULT_BURN.gap);
  b.strokeWidth = clampF(b.strokeWidth, 0, 0.02, DEFAULT_BURN.strokeWidth);
  b.delay = clampF(b.delay, 0, 5, DEFAULT_BURN.delay);
  b.numberDelay = clampF(b.numberDelay, 0, 5, DEFAULT_BURN.numberDelay);
  b.badgeShow = clampF(b.badgeShow, 0, 600, DEFAULT_BURN.badgeShow);
  b.numberShow = clampF(b.numberShow, 0, 600, DEFAULT_BURN.numberShow);
  b.offsetX = clampF(b.offsetX, -1, 1, 0);
  b.offsetY = clampF(b.offsetY, -1, 1, 0);
  b.sfxVolume = clampF(b.sfxVolume, 0, 4, 1);
  b.order = b.order === 'numberTop' ? 'numberTop' : 'badgeTop';
  b.badgeStyle = b.badgeStyle === 'vector' ? 'vector' : 'emoji';
  b.anchor = ANCHORS.includes(b.anchor) ? b.anchor : 'bottom-center';
  b.fontPath = String(b.fontPath || '').trim() || DEFAULT_BADGE_FONT;
  b.numberColor = /^#?[0-9a-fA-F]{3,8}$/.test(String(b.numberColor || '')) ? String(b.numberColor) : DEFAULT_BURN.numberColor;
  b.numberStroke = /^#?[0-9a-fA-F]{3,8}$/.test(String(b.numberStroke || '')) ? String(b.numberStroke) : DEFAULT_BURN.numberStroke;
  return b;
}

/**
 * 调 overlay_gen.py 生成每段的「符号 + 编号」标记图。
 * 返回 {map:Map(seq→{png,x,y,w,h}), style, log, items} 或 {error}。
 */
async function genOverlays(segs, burn, info, jobId, opts = {}) {
  const inP = path.join(BADGES, `spec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`);
  const outP = inP.replace(/\.json$/, '.out.json');
  try {
    // 目录可能被外部清理掉（比如手工删中间产物），每次生成前确保存在
    fs.mkdirSync(opts.subdir ? path.join(BADGES, opts.subdir) : BADGES, { recursive: true });
  } catch (e) {
    return { error: `标记图目录创建失败（${(e && e.code) || e}）：${BADGES}` };
  }
  const spec = {
    video: { w: info.width || 1080, h: info.height || 1920 },
    cfg: {
      badgeScale: burn.badgeScale, numberSize: burn.numberSize, gap: burn.gap,
      order: burn.order, anchor: burn.anchor, offsetX: burn.offsetX, offsetY: burn.offsetY,
      numberColor: burn.numberColor, numberStroke: burn.numberStroke, strokeWidth: burn.strokeWidth,
      fontPath: burn.fontPath, badgeStyle: burn.badgeStyle,
      badgeOkImage: burn.badgeOkImage, badgeNoImage: burn.badgeNoImage,
    },
    items: segs.map(s => ({ id: String(s.seq), num: s.num, err: !!s.err })),
    outDir: opts.subdir ? path.join(BADGES, opts.subdir) : BADGES,
    returnBase64: !!opts.base64,
  };
  try {
    fs.writeFileSync(inP, JSON.stringify(spec), 'utf8');
  } catch (e) {
    return { error: `标记图任务写入失败（${(e && e.code) || e}）` };
  }
  const r = await run(PY, [OVERLAY_PY, inP, outP]);
  let res = null;
  try { res = JSON.parse(fs.readFileSync(outP, 'utf8')); } catch (e) { /* 下方统一报错 */ }
  try { fs.unlinkSync(inP); fs.unlinkSync(outP); } catch (e) {}
  if (!res || !res.ok) {
    const detail = (res && (res.error || String(res.trace || '').trim().split('\n').pop()))
      || (r.err || '').split('\n').filter(Boolean).slice(-2).join(' | ')
      || `python 退出码 ${r.code}`;
    return { error: `标记图生成失败：${detail}` };
  }
  const map = new Map();
  for (const it of res.items || []) map.set(String(it.id), it);
  return { map, style: (res.badge || {}).style || burn.badgeStyle, log: res.log || [], items: res.items || [] };
}

/**
 * 音频混音链（纯音频图）。srcCh/sfxCh = 源 / 音效的声道数。
 * 输出声道跟随源：单声道源 → 单声道，原声电平分毫不动（aformat 上混会悄悄 -3dB）。
 * ⚠ 不要在 amix 入口用 aformat 固定声道：ffmpeg 4.4 会把图输入垫协商成与文件不一致的布局，
 *   运行时抛 "Changing audio frame properties on the fly"。
 * 声道换算用 pan（单位矩阵/0.5+0.5 下混），避免依赖 swresample 的默认矩阵。
 */
function mixAudioGraph(o) {
  const { hasAudio, delay, sfxVolume, srcCh, sfxCh, sfxIdx } = o;
  const dms = Math.max(0, Math.round(delay * 1000));
  const target = hasAudio ? (srcCh >= 2 ? 'stereo' : 'mono') : (sfxCh >= 2 ? 'stereo' : 'mono');
  const fxPre = `volume=${sfxVolume},adelay=${dms}:all=1`;
  const fxConv = (sfxCh === 2 && target === 'mono') ? ',pan=mono|c0=0.5*c0+0.5*c1'
    : (sfxCh <= 1 && target === 'stereo') ? ',pan=stereo|c0=c0|c1=c0' : '';
  const post = `aformat=sample_fmts=fltp:channel_layouts=${target}`;
  if (!hasAudio) {
    return { graph: `[${sfxIdx}:a]${fxPre}${fxConv},apad,${post}[a]`, aMap: '[a]' };
  }
  const mainConv = (srcCh === 1 && target === 'stereo') ? 'pan=stereo|c0=c0|c1=c0'
    : (srcCh > 2 ? `aformat=channel_layouts=${target}` : 'anull');
  return {
    graph: `[0:a]${mainConv}[main];[${sfxIdx}:a]${fxPre}${fxConv}[fx];`
      + `[main][fx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${post}[a]`,
    aMap: '[a]',
  };
}

/** 出现/消失时间窗 → overlay 的 enable 表达式（show=0 表示出现后不消失） */
function enableExpr(delay, show) {
  const d = Number(delay) || 0;
  const f = Number(show) || 0;
  if (f <= 0) return `gte(t,${d})`;
  return `between(t,${d},${+(d + f).toFixed(3)})`;
}

/** overlay 链：按顺序把若干层叠到 [0:v] 上，每层带自己的出现延迟与显示时长（秒） */
function overlayChain(layers) {
  const graph = [];
  let cur = '[0:v]';
  layers.forEach((L, i) => {
    const out = `[v${i + 1}]`;
    graph.push(`${cur}[${L.idx}:v]overlay=x=${L.x}:y=${L.y}:enable='${enableExpr(L.delay, L.show)}'${out}`);
    cur = out;
  });
  if (layers.length) graph.push(`${cur}format=yuv420p[v]`);
  return { graph, vMap: layers.length ? '[v]' : null };
}

/**
 * 把标记图条目展开成层列表：[{png,x,y,delay,show}]
 * 符号层用 badgeDelay/badgeShow，编号层用 numberDelay/numberShow。
 */
function ovItems(entry, badgeDelay, numberDelay, badgeShow, numberShow) {
  if (!entry || !Array.isArray(entry.layers)) return [];
  return entry.layers.map(L => {
    const isNum = (L.kind === 'number');
    return {
      png: L.png, x: L.x, y: L.y,
      delay: isNum ? numberDelay : badgeDelay,
      show: isNum ? numberShow : badgeShow,
    };
  });
}

/**
 * 单趟参数（图里只有视频支路、或只有音频支路）：
 *  干净切片 / 只烧标记 → 视频图 + 音频直通；只配音效（无标记）→ 音频图 + 视频直通。
 * overlays: [{png,x,y,delay}] 空数组=不烧标记；sfxDelay 应与符号延迟一致。
 * 有滤镜图时强制重编码；否则保持旧行为（可 -c copy）。
 * ⚠ 「视频滤镜 + 音频 amix 同图」在 ffmpeg 4.4 会挂，两者同时需要请走两趟流程。
 */
function buildClipArgs(o) {
  const { src, s, mode, overlays = [], sfxFile, sfxDelay = 0, hasAudio, sfxVolume, srcCh, sfxCh } = o;
  const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-y',
    '-ss', s.start.toFixed(3), '-i', src];
  let idx = 1, sfxIdx = -1;
  const layers = overlays.map(L => { args.push('-loop', '1', '-i', L.png); return Object.assign({}, L, { idx: idx++ }); });
  if (sfxFile) { args.push('-i', sfxFile); sfxIdx = idx++; }

  const graph = [];
  const vv = overlayChain(layers);
  graph.push(...vv.graph);
  let aMap = null;
  if (sfxIdx >= 0) {
    const mix = mixAudioGraph({ hasAudio, delay: sfxDelay, sfxVolume, srcCh, sfxCh, sfxIdx });
    graph.push(mix.graph);
    aMap = mix.aMap;
  }
  if (graph.length) args.push('-filter_complex', graph.join(';'));
  if (vv.vMap) args.push('-map', vv.vMap);
  else if (graph.length) args.push('-map', '0:v');
  if (aMap) args.push('-map', aMap);
  else if (vv.vMap && hasAudio) args.push('-map', '0:a');
  if (!hasAudio && !sfxFile) args.push('-an');

  args.push('-t', s.dur.toFixed(3));
  if (graph.length) {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  } else if (mode === 'copy') {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  }
  return args;
}

/** 两趟流程 · 第一趟：只混音（纯音频图），输出临时 m4a 交给第二趟流拷贝 */
function buildAudioMixArgs(o) {
  const { src, s, sfxFile, hasAudio, delay, sfxVolume, outAudio, srcCh, sfxCh } = o;
  const { graph } = mixAudioGraph({ hasAudio, delay, sfxVolume, srcCh, sfxCh, sfxIdx: 1 });
  return ['-hide_banner', '-nostats', '-loglevel', 'error', '-y',
    '-ss', s.start.toFixed(3), '-i', src, '-i', sfxFile,
    '-filter_complex', graph, '-map', '[a]', '-t', s.dur.toFixed(3),
    '-c:a', 'aac', '-b:a', '192k', outAudio];
}

/** 两趟流程 · 第二趟：烧录标记层 + 并入第一趟的混音（音频流拷贝，不二次编码） */
function buildVideoBurnArgs(o) {
  const { src, s, overlays = [], audioFrom, hasAudio, outFile } = o;
  const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-y',
    '-ss', s.start.toFixed(3), '-i', src];
  let idx = 1;
  const layers = overlays.map(L => { args.push('-loop', '1', '-i', L.png); return Object.assign({}, L, { idx: idx++ }); });
  const audioIdx = audioFrom ? idx++ : -1;
  if (audioFrom) args.push('-i', audioFrom);

  const vv = overlayChain(layers);
  if (vv.vMap) args.push('-filter_complex', vv.graph.join(';'), '-map', vv.vMap);
  else args.push('-map', '0:v');
  if (audioIdx >= 0) args.push('-map', `${audioIdx}:a`, '-c:a', 'copy');
  else if (hasAudio) args.push('-map', '0:a', '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');

  args.push('-t', s.dur.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile);
  return args;
}

/** 合并成片 · 输出文件名：童站挑战_<源名>_<YYYYMMDD-HHmm>.mp4 */
function mergeOutName(src) {
  const base = String(src || '合集').split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || '合集';
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `童站挑战_${base}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.mp4`;
}

/** 目录里按文件名顺序（clip_001… clip_010…）列出切片 */
function listClipsIn(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => /\.(mp4|mov|mkv)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }))
      .map(f => path.join(dir, f));
  } catch (e) { return []; }
}

/**
 * 把若干切片按顺序拼成一条视频。
 * 先试 `-c copy`（同源同参数编码，秒级完成、无损）；失败则退回重编码，保证能出片。
 */
async function mergeClips(files, outFile, jobId, tag) {
  fs.mkdirSync(BURN_TMP, { recursive: true });
  const lst = path.join(BURN_TMP, `concat_${tag}.txt`);
  const text = files.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n';
  fs.writeFileSync(lst, text, 'utf8');       // 注意：不能加 BOM，否则 ffmpeg 读不出第一行指令
  let r = await run(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', '-movflags', '+faststart', outFile]);
  if (r.code !== 0) {
    const why = (r.err || '').split('\n').filter(Boolean).slice(-1)[0] || '';
    if (jobId) jobLog(jobId, `流拷贝合并失败，改用重编码合并（${String(why).slice(0, 160)}）`);
    r = await run(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', lst,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outFile]);
  }
  try { fs.unlinkSync(lst); } catch (e) {}
  return r.code === 0
    ? { ok: true }
    : { ok: false, err: (r.err || '').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) };
}

// ---------- HTTP 路由 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    // --- 静态页面 ---
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const f = path.join(PUBLIC, 'index.html');
      const b = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': b.length, 'Cache-Control': 'no-store' });
      return res.end(b);
    }

    // --- 媒体流（支持 Range，供 <video> 拖动预览）---
    if (req.method === 'GET' && p === '/media') {
      const src = u.searchParams.get('path');
      if (!src || !fs.existsSync(src)) { res.writeHead(404); return res.end('not found'); }
      const stat = fs.statSync(src);
      const range = req.headers.range;
      const type = src.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream';
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
        end = Math.min(end, stat.size - 1);
        res.writeHead(206, {
          'Content-Type': type, 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
        });
        return fs.createReadStream(src, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
      return fs.createReadStream(src).pipe(res);
    }

    // --- 缩略图 ---
    if (req.method === 'GET' && p === '/frame') {
      const src = u.searchParams.get('path');
      const t = parseFloat(u.searchParams.get('t') || '0');
      const w = parseInt(u.searchParams.get('w') || '320', 10);
      if (!src || !fs.existsSync(src)) { res.writeHead(404); return res.end('not found'); }
      const { buf } = await grabFrame(src, t, w);
      if (!buf.length) { res.writeHead(500); return res.end('frame failed'); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      return res.end(buf);
    }

    // --- 环境自检（GET / POST 均可）---
    if (p === '/api/env') {
      const fv = await run(FFMPEG, ['-version']);
      const ffOk = fv.code === 0;
      const pil = await run(PY, ['-c', 'import PIL;print(PIL.__version__)']);
      const pilOk = pil.code === 0;
      const parts = [
        ffOk ? 'ffmpeg ✔' : 'ffmpeg ✘',
        pilOk ? `PIL ${(pil.out || '').trim()} ✔` : 'PIL ✘',
        '输出目录 ' + DEFAULT_OUT_DIR,
      ];
      return json(res, 200, {
        ok: ffOk,
        ffmpeg: ffOk,
        pillow: pilOk,
        pillowVersion: (pil.out || '').trim(),
        ffmpegVersion: (fv.out.split('\n')[0] || '').slice(0, 60),
        outDir: OUT,
        defaultOutDir: DEFAULT_OUT_DIR,
        defaultAssPath: DEFAULT_ASS_PATH,
        sfxOk: DEFAULT_SFX_OK,
        sfxNo: DEFAULT_SFX_NO,
        sfxOkExists: fs.existsSync(DEFAULT_SFX_OK),
        sfxNoExists: fs.existsSync(DEFAULT_SFX_NO),
        badgeFont: DEFAULT_BADGE_FONT,
        burnDefaults: DEFAULT_BURN,
        text: parts.join(' · '),
      });
    }

    // --- 读取某个 .ass 的可用样式（供下拉选择；GET 用 query，POST 用 body）---
    if (p === '/api/ass-styles' && req.method === 'GET') {
      const ap = u.searchParams.get('path') || DEFAULT_ASS_PATH;
      const { styles, exists } = readAssHeader(ap);
      return json(res, 200, { ok: true, path: ap, exists, styles });
    }

    // --- 列出周边可用视频（GET，便于扫描目录）---
    if (p === '/api/list') {
      const dir = u.searchParams.get('dir') || WORK;
      if (!fs.existsSync(dir)) return json(res, 400, { error: '目录不存在: ' + dir });
      const files = fs.readdirSync(dir).filter(f => /\.(mp4|mov|mkv|avi|flv|ts|m4v|webm)$/i.test(f));
      return json(res, 200, { ok: true, dir, files });
    }

    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

    const body = await readBody(req);

    // --- 探针 ---
    if (p === '/api/probe') {
      const src = body.path;
      if (!src || !fs.existsSync(src)) return json(res, 400, { error: '文件不存在: ' + src });
      const info = await probe(src);
      return json(res, 200, { ok: true, info });
    }

    // --- 自动切分 ---
    if (p === '/api/autosplit') {
      const src = body.path;
      if (!src || !fs.existsSync(src)) return json(res, 400, { error: '文件不存在: ' + src });
      const t0 = Date.now();
      const info = await probe(src);
      const r = await autoSplit(src, body.opt || {});
      return json(res, 200, {
        ok: true, duration: info.duration, info,
        silences: r.silences, cuts: r.cuts, opt: r.opt,
        equal: !!r.equal, pieces: r.pieces || 0,
        elapsedMs: Date.now() - t0,
        rawTail: (r.cuts && r.cuts.length) ? undefined : r.raw,
      });
    }

    // --- OCR（长任务）---
    if (p === '/api/ocr') {
      const src = body.path;
      const segs = body.segments || [];
      if (!src || !fs.existsSync(src)) return json(res, 400, { error: '文件不存在: ' + src });
      const samples = body.samples === 'multi' ? 3 : 1;   // 默认取中位时间；可选 3 点增强
      const id = newJob('ocr');
      json(res, 200, { ok: true, jobId: id });

      (async () => {
        const j = jobs.get(id);
        const framesDir = path.join(WORK, 'frames');
        fs.mkdirSync(framesDir, { recursive: true });
        const items = [];
        const meta = {};
        j.total = segs.length;
        jobLog(id, `开始截帧：共 ${segs.length} 段，每段 ${samples} 帧`);

        // 并发截帧
        const CONC = 4;
        const q = segs.slice();
        const workers = Array.from({ length: CONC }, async () => {
          while (q.length) {
            const s = q.shift();
            const times = samples === 1
              ? [(s.start + s.end) / 2]
              : [s.start + (s.end - s.start) * 0.25, (s.start + s.end) / 2, s.start + (s.end - s.start) * 0.75];
            const files = [];
            for (let k = 0; k < times.length; k++) {
              const fp = path.join(framesDir, `seg_${pad3(s.seq)}_${k}.jpg`);
              const { buf } = await grabFrame(src, times[k], 1600);
              if (buf.length) { fs.writeFileSync(fp, buf); files.push(fp); }
            }
            meta[s.seq] = { seq: s.seq, start: s.start, end: s.end, times, files };
            files.forEach((f, k) => items.push({ id: `${s.seq}:${k}`, image: f }));
            j.progress++;
            j.message = `截帧 ${j.progress}/${j.total}`;
          }
        });
        await Promise.all(workers);

        if (!items.length) {
          j.state = 'error'; j.error = '没有任何帧被成功截取'; return;
        }

        jobLog(id, `截帧完成（${items.length} 帧），启动 OCR 引擎…`);
        const inJson = path.join(WORK, 'ocr_in.json');
        const outJson = path.join(WORK, 'ocr_out.json');
        fs.writeFileSync(inJson, JSON.stringify({ items }, null, 0), 'utf8');

        const r = await run(PY, [OCR_WORKER, inJson, outJson]);
        if (!fs.existsSync(outJson)) {
          j.state = 'error';
          j.error = 'OCR 进程无输出。' + (r.err || '').slice(0, 500);
          return;
        }
        const ocr = JSON.parse(fs.readFileSync(outJson, 'utf8'));
        if (!ocr.ok && !Object.keys(ocr.results || {}).length) {
          j.state = 'error';
          j.error = 'OCR 失败: ' + JSON.stringify(ocr.errors || []).slice(0, 500);
          return;
        }

        // 汇总每个分段
        const out = [];
        for (const s of segs) {
          const m = meta[s.seq];
          if (!m) continue;
          const texts = [];
          const scores = [];
          m.files.forEach((f, k) => {
            const r0 = ocr.results[`${s.seq}:${k}`];
            if (r0 && r0.text) { texts.push(r0.text); (r0.scores || []).forEach(x => scores.push(x)); }
          });
          const merged = texts.join('\n');
          const cls = classify(merged);
          out.push({
            seq: s.seq, start: s.start, end: s.end,
            sampleTimes: m.times.map(t => +t.toFixed(3)),
            text: merged,
            lines: texts.flatMap(t => t.split('\n')).filter(Boolean),
            avgScore: scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3) : 0,
            ...cls,
          });
          j.progress = s.seq;
          j.message = `OCR 判定 ${s.seq}/${segs.length}`;
        }

        j.result = { segments: out, frameCount: items.length };
        j.state = 'done';
        j.message = 'OCR 判定完成';
        jobLog(id, 'OCR 判定完成');
      })().catch(e => {
        const j = jobs.get(id);
        if (j) { j.state = 'error'; j.error = String(e && e.stack || e); }
      });
      return;
    }

    // --- 读取某个 .ass 的可用样式（POST 版）---
    if (p === '/api/ass-styles') {
      const ap = body.path || DEFAULT_ASS_PATH;
      const { styles, exists } = readAssHeader(ap);
      return json(res, 200, { ok: true, path: ap, exists, styles });
    }

    // --- 烧录标记预览：合成 ✅/❌+编号 图，返回图片 base64 与贴图坐标 ---
    if (p === '/api/badge-preview') {
      const burn = normBurn(body.cfg);
      const w = Math.max(16, +body.w || 1080), h = Math.max(16, +body.h || 1920);
      const items = (Array.isArray(body.items) && body.items.length ? body.items : [{ id: 'ok', num: 1, err: false }]).slice(0, 4);
      const segs = items.map((it, i) => ({ seq: i + 1, num: it.num != null ? it.num : 1, err: !!it.err }));
      const r = await genOverlays(segs, burn, { width: w, height: h }, null, { base64: true, subdir: 'preview' });
      if (r.error) return json(res, 500, { ok: false, error: r.error });
      const out = segs.map((s, i) => {
        const it = r.map.get(String(s.seq)) || {};
        return { id: items[i].id || String(i), num: s.num, err: s.err, x: it.x, y: it.y, w: it.w, h: it.h,
          b64: it.b64 || '', layers: it.layers || [] };
      });
      return json(res, 200, {
        ok: true, videoW: w, videoH: h, badgeStyle: r.style, items: out,
        warning: (r.log || []).join('；'),
      });
    }

    // --- 手动打点导出：烧录切片（+ 可选干净切片）（长任务；不再生成 ASS）---
    if (p === '/api/export') {
      const src = body.path;
      if (!src || !fs.existsSync(src)) return json(res, 400, { error: '文件不存在: ' + src });

      const cuts = (body.cuts || []).map(Number).filter(n => isFinite(n)).sort((a, b) => a - b);
      const errSet = new Set((body.errors || []).map(Number));
      const endRaw = (body.end != null) ? Number(body.end) : NaN;   // 「结尾打点」：之后的视频不切片、不烧录
      const endAt = (isFinite(endRaw) && endRaw > 0.02) ? +endRaw.toFixed(3) : null;
      const startRaw = (body.start != null) ? Number(body.start) : NaN; // 「起点」：之前的内容不导出，编号从起点重新从 1 开始
      const startAt = (isFinite(startRaw) && startRaw > 0.02) ? +startRaw.toFixed(3) : null;
      const outDir = (body.outDir || DEFAULT_OUT_DIR).trim();
      const mode = body.mode === 'copy' ? 'copy' : 'reencode';
      const prefix = ((body.prefix || 'clip_').replace(/[\\/:*?"<>|]/g, '') || 'clip_');
      const burn = normBurn(body.burn);

      const id = newJob('export');
      json(res, 200, { ok: true, jobId: id });

      (async () => {
        const j = jobs.get(id);
        jobLog(id, '读取媒体信息…');
        const info = await probe(src);
        const D = info.duration;

        // 1) 分段：边界序列 [起点或0, 中间的切点……, 结尾点或视频末尾]
        //    「起点」之前的内容完全不参与导出（不切片、不烧录、不编号）；编号从第一段（= 起点那段）从 1 开始
        //    「结尾打点」之后的内容同样不参与导出
        const endEff = (endAt != null && endAt < D - 0.02) ? endAt : null;
        const startEff = (startAt != null && startAt < D - 0.02 && (endEff == null || startAt < endEff - 0.001)) ? startAt : null;
        const cutsUsed = cuts.filter(t => t > 0.02 && t < D - 0.02
          && (startEff == null || t > startEff + 0.001)
          && (endEff == null || t < endEff - 0.001));
        const bounds = [(startEff == null ? 0 : startEff), ...cutsUsed, (endEff == null ? D : endEff)];
        const segs = [];
        for (let i = 0; i < bounds.length - 1; i++) {
          const start = bounds[i], end = bounds[i + 1];
          if (end - start < 0.02) continue;
          segs.push({ seq: segs.length + 1, start: +start.toFixed(3), end: +end.toFixed(3), dur: +(end - start).toFixed(3) });
        }

        // 2) 编号（错误段后重置为 1；错误段本身仍编号）
        assignNumbers(segs, errSet);
        jobLog(id, `共 ${segs.length} 段（错误 ${segs.filter(s => s.err).length} 段）· 范围 `
          + `${(startEff == null ? 0 : startEff).toFixed(2)}s → `
          + (endEff == null ? `${D.toFixed(2)}s（视频末尾）` : `${endEff.toFixed(2)}s（结尾打点，之后不导出）`));

        // 3) 切片：先出干净切片（clips/，可选），再出烧录版（clips_burned/）
        //    注：本工具已不再生成 ASS 字幕（编号直接烧进画面）。
        const clipBySeq = new Map();
        const getRec = s => {
          if (!clipBySeq.has(s.seq)) {
            clipBySeq.set(s.seq, { seq: s.seq, num: s.num, err: s.err, start: s.start, end: s.end, dur: s.dur });
          }
          return clipBySeq.get(s.seq);
        };
        let burnWarning = '', burnStyle = '', burnWritten = null, burnedCount = 0;
        // 本次导出的独立运行目录：多开实例/多次导出互不干扰（不再共用 badges / burn_tmp 根目录）
        const runTag = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const badgeDir = path.join(BADGES, runTag);
        const tmpDir = path.join(BURN_TMP, runTag);
        {
          const clipsDir = path.join(outDir, 'clips');
          const burnDir = path.join(outDir, 'clips_burned');
          const clearDir = dir => {
            fs.mkdirSync(dir, { recursive: true });
            for (const f of fs.readdirSync(dir)) {
              if (/\.(mp4|mov|mkv)$/i.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
            }
          };

          const hasAudio = !!info.acodec;
          let overlayMap = null;
          let sfxOk = burn.sfxOkPath, sfxNo = burn.sfxNoPath;
          let sfxChOk = 2, sfxChNo = 2;      // 音效声道数（决定混音输出声道与换算方式）
          if (burn.enabled) {
            if (burn.sfxEnabled) {
              if (!fs.existsSync(sfxOk)) { jobLog(id, `对.mp3 不存在，正常段将不带音效：${sfxOk}`); sfxOk = null; }
              if (!fs.existsSync(sfxNo)) { jobLog(id, `错.mp3 不存在，错误段将不带音效：${sfxNo}`); sfxNo = null; }
              if (sfxOk) { try { sfxChOk = (await probe(sfxOk)).channels || 2; } catch (e) {} }
              if (sfxNo) { try { sfxChNo = (await probe(sfxNo)).channels || 2; } catch (e) {} }
            } else { sfxOk = sfxNo = null; }

            jobLog(id, '生成 ✅/❌ + 编号标记图…');
            const ov = await genOverlays(segs, burn, info, id, { subdir: runTag });
            if (ov.error) {
              burnWarning = ov.error + '（本次只输出干净切片）';
              jobLog(id, burnWarning);
            } else {
              overlayMap = ov.map; burnStyle = ov.style;
              if ((ov.log || []).length) jobLog(id, ov.log.join('；'));
              jobLog(id, `标记图就绪：${overlayMap.size} 段 · 风格 ${ov.style} · 锚点 ${burn.anchor}`);
              if (mode === 'copy') jobLog(id, '烧录切片一律重编码（滤镜/混音没法流拷贝）；干净切片仍按所选的流拷贝执行');
            }
          }
          const burnOn = !!overlayMap;

          const cleanList = [], burnList = [];
          for (const s of segs) {
            if (!burnOn || burn.writeClean) cleanList.push(s);
            if (burnOn) burnList.push(s);
          }
          j.total = cleanList.length + burnList.length;
          let doneCount = 0;

          const runPass = async (list, kind) => {
            const q = list.slice();
            const workers = Array.from({ length: Math.min(CONC, q.length || 1) }, async () => {
              while (q.length) {
                const s = q.shift();
                const target = kind === 'burn' ? burnDir : clipsDir;
                const outFile = path.join(target, `${prefix}${pad3(s.seq)}.mp4`);
                const entry = kind === 'burn' ? overlayMap.get(String(s.seq)) : null;
                const sfxFile = (kind === 'burn' && burn.sfxEnabled) ? (s.err ? sfxNo : sfxOk) : null;
                // 出现延迟：符号默认 0.5s（音效与符号同步）、编号默认 0（第一帧就有）；
                // 切片过短时各自自动提前（约占总长 20%），音效由 -t 自然截断
                const delay = +Math.min(burn.delay, s.dur * 0.2).toFixed(3);
                const numDelay = +Math.min(burn.numberDelay, s.dur * 0.2).toFixed(3);
                const overlays = ovItems(entry, delay, numDelay, burn.badgeShow, burn.numberShow);
                let r, finalSfx = sfxFile;
                const srcCh = info.channels || 0;
                const sfxCh = s.err ? sfxChNo : sfxChOk;
                if (kind === 'burn' && overlays.length && sfxFile) {
                  // 视频滤镜与 amix 同图会被 ffmpeg 4.4 的声道协商搞挂 → 拆两趟：
                  // ① 纯音频图混音（快） ② 视频叠加 + 音频流拷贝
                  const mixTmp = path.join(tmpDir, `${prefix}${pad3(s.seq)}.m4a`);
                  const ra = await run(FFMPEG, buildAudioMixArgs({ src, s, sfxFile, hasAudio, delay, sfxVolume: burn.sfxVolume, outAudio: mixTmp, srcCh, sfxCh }));
                  if (ra.code === 0) {
                    r = await run(FFMPEG, buildVideoBurnArgs({ src, s, overlays, audioFrom: mixTmp, hasAudio, outFile }));
                    try { fs.unlinkSync(mixTmp); } catch (e) {}
                  } else {
                    jobLog(id, `混音失败（第 ${s.seq} 段），改为不带音效烧录：`
                      + (ra.err || '').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200));
                    finalSfx = null;
                    const args = buildClipArgs({ src, s, mode, overlays, sfxFile: null, hasAudio, sfxVolume: burn.sfxVolume, srcCh, sfxCh });
                    args.push(outFile);
                    r = await run(FFMPEG, args);
                  }
                } else {
                  const args = buildClipArgs({ src, s, mode, overlays, sfxFile, sfxDelay: delay, hasAudio, sfxVolume: burn.sfxVolume, srcCh, sfxCh });
                  args.push(outFile);
                  r = await run(FFMPEG, args);
                }
                doneCount++;
                j.progress = doneCount;
                j.message = `${kind === 'burn' ? '烧录切片' : '切片'} ${doneCount}/${j.total}`;
                let size = 0; try { size = fs.statSync(outFile).size; } catch (e) {}
                if (r.code !== 0) {
                  jobLog(id, `${kind === 'burn' ? '烧录' : '切片'}失败（第 ${s.seq} 段）：`
                    + (r.err || '').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300));
                }
                const rec = getRec(s);
                const rel = path.relative(outDir, outFile).replace(/\\/g, '/');
                if (kind === 'burn') {
                  rec.burnFile = rel; rec.burnSize = size; rec.burnOk = r.code === 0;
                  rec.sfx = finalSfx ? path.basename(finalSfx) : null;
                  rec.burnDelay = delay;
                  rec.burnNumDelay = numDelay;
                  if (r.code === 0) burnedCount++;
                } else {
                  rec.file = rel; rec.size = size; rec.ok = r.code === 0;
                }
              }
            });
            await Promise.all(workers);
          };

          if (burnOn) {
            clearDir(burnDir);          // 只有确实要写烧录版时才清旧文件
            fs.mkdirSync(tmpDir, { recursive: true });
          }
          if (cleanList.length) clearDir(clipsDir);   // 只有确实要写干净切片时才清旧文件
          await runPass(cleanList, 'clean');
          if (burnOn) {
            if (!hasAudio && burn.sfxEnabled) jobLog(id, '源视频没有音轨：烧录版仅混入对/错音效');
            await runPass(burnList, 'burn');
            burnWritten = burnDir;
          }
          // 清理本次导出的独立目录（标记图 / 临时混音）
          try { fs.rmSync(badgeDir, { recursive: true, force: true }); } catch (e) {}
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        }
        const clips = [...clipBySeq.values()].sort((a, b) => a.seq - b.seq);

        // 4.5) 合并成片（可选，默认开）：把切片按顺序拼成一条「童站挑战视频」
        let mergedFile = null, mergeWarning = '', mergeDur = 0;
        if (body.merge !== false) {
          const srcDir = burnWritten || (path.join(outDir, 'clips'));
          const list = listClipsIn(srcDir);
          if (list.length) {
            jobLog(id, `合并成片：${list.length} 段…`);
            const outName = mergeOutName(src);
            const outFile = path.join(outDir, outName);
            const mg = await mergeClips(list, outFile, id, runTag);
            if (mg.ok) {
              mergedFile = path.relative(outDir, outFile).replace(/\\/g, '/');
              try { mergeDur = (await probe(outFile)).duration || 0; } catch (e) {}
              jobLog(id, `成片已生成：${outName}（${list.length} 段 · ${mergeDur.toFixed(1)}s）`);
            } else {
              mergeWarning = `合并成片失败：${mg.err}`;
              jobLog(id, mergeWarning);
            }
          }
        }

        // 5) 清单
        const manifest = {
          source: src, mode, outDir,
          burn: burn.enabled ? {
            enabled: true, anchor: burn.anchor, offsetX: burn.offsetX, offsetY: burn.offsetY,
            badgeScale: burn.badgeScale, numberSize: burn.numberSize, gap: burn.gap, order: burn.order,
            delay: burn.delay, numberDelay: burn.numberDelay, badgeStyle: burnStyle || burn.badgeStyle,
            badgeShow: burn.badgeShow, numberShow: burn.numberShow,
            numberColor: burn.numberColor, numberStroke: burn.numberStroke, strokeWidth: burn.strokeWidth,
            sfxEnabled: burn.sfxEnabled, sfxOkPath: burn.sfxOkPath, sfxNoPath: burn.sfxNoPath,
            sfxVolume: burn.sfxVolume, writeClean: burn.writeClean,
          } : { enabled: false },
          burnDir: burnWritten, burnWarning,
          mergedFile, mergeDuration: +mergeDur.toFixed(3), mergeWarning,
          generatedAt: new Date().toISOString(),
          duration: +D.toFixed(3), cuts, cutsUsed, end: endEff, start: startEff,
          counts: { segs: segs.length, errors: segs.filter(s => s.err).length, clips: clips.length, burned: burnedCount },
          segments: segs.map(s => ({ seq: s.seq, num: s.num, err: s.err, start: s.start, end: s.end, dur: s.dur })),
          clips,
        };
        fs.mkdirSync(outDir, { recursive: true });
        try { fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8'); }
        catch (e) { jobLog(id, `清单写入失败（${(e && e.code) || e}），不影响切片`); }

        j.result = manifest;
        j.state = 'done';
        const okMsg = (burnWritten
          ? `完成：${burnedCount} 个烧录切片${burn.writeClean ? ` + ${clips.length} 个干净切片` : ''}`
          : `完成：${clips.length} 个干净切片（未烧录）`)
          + (mergedFile ? ` · 成片：${path.basename(mergedFile)}（${mergeDur.toFixed(1)}s）` : '');
        const warn = [burnWarning, mergeWarning].filter(Boolean).join('；');
        j.message = warn ? `完成，但 ${warn}` : okMsg;
        jobLog(id, okMsg);
        if (warn) jobLog(id, warn);
      })().catch(e => {
        const j = jobs.get(id);
        if (j) { j.state = 'error'; j.error = String(e && e.stack || e); }
      });
      return;
    }

    // --- 合并成片：把已有切片按顺序拼成一条「童站挑战视频」（长任务）---
    if (p === '/api/merge') {
      const outDir = (body.outDir || DEFAULT_OUT_DIR).trim();
      const src = body.path || '';
      const dirs = [path.join(outDir, 'clips_burned'), path.join(outDir, 'clips')];
      const id = newJob('merge');
      json(res, 200, { ok: true, jobId: id });

      (async () => {
        const j = jobs.get(id);
        let files = [], fromDir = '';
        for (const d of dirs) {
          const f = listClipsIn(d);
          if (f.length) { files = f; fromDir = d; break; }
        }
        if (!files.length) throw new Error(`没找到可合并的切片：${dirs.join(' / ')} 里都没有 mp4`);
        fs.mkdirSync(outDir, { recursive: true });
        const outName = mergeOutName(src || '合集');
        const outFile = path.join(outDir, outName);
        j.total = files.length;
        j.progress = 0;
        jobLog(id, `把 ${files.length} 段（来自 ${path.basename(fromDir)}）合并成 ${outName}…`);
        const mg = await mergeClips(files, outFile, id, id);
        if (!mg.ok) throw new Error('合并失败：' + mg.err);
        let size = 0; try { size = fs.statSync(outFile).size; } catch (e) {}
        let dur = 0; try { dur = (await probe(outFile)).duration || 0; } catch (e) {}
        j.progress = files.length;
        j.result = { file: outFile, name: outName, clips: files.length, size, duration: +dur.toFixed(3), dir: fromDir };
        j.state = 'done';
        j.message = `成片已生成：${outName}（${files.length} 段 · ${dur.toFixed(1)}s）`;
        jobLog(id, j.message);
      })().catch(e => {
        const j = jobs.get(id);
        if (j) { j.state = 'error'; j.error = String(e && e.stack || e); }
      });
      return;
    }

    // --- 渲染切片（长任务）---
    if (p === '/api/render') {
      const src = body.path;
      const plan = body.plan || { keep: [], cut: [] };
      const mode = body.mode === 'copy' ? 'copy' : 'reencode';
      if (!src || !fs.existsSync(src)) return json(res, 400, { error: '文件不存在: ' + src });
      const id = newJob('render');
      json(res, 200, { ok: true, jobId: id });

      (async () => {
        const j = jobs.get(id);
        j.total = (plan.keep || []).length + (plan.cut || []).length;
        jobLog(id, `开始切片：保留 ${(plan.keep || []).length} 段 + 剔除 ${(plan.cut || []).length} 段，模式 ${mode}`);
        // 清空旧输出，避免混淆
        for (const g of ['keep', 'cut']) {
          const gd = path.join(OUT, g);
          if (fs.existsSync(gd)) for (const f of fs.readdirSync(gd)) { try { fs.unlinkSync(path.join(gd, f)); } catch (e) {} }
        }
        const r = await renderClips(src, plan, mode, (d, t) => { j.progress = d; j.total = t; j.message = `切片 ${d}/${t}`; });
        const manifest = {
          source: src, mode,
          generatedAt: new Date().toISOString(),
          keep: r.keep, cut: r.cut, errors: r.errors,
          counts: { keep: r.keep.length, cut: r.cut.length },
        };
        fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
        j.result = manifest;
        j.state = 'done';
        j.message = `完成：保留 ${r.keep.length} 段，剔除 ${r.cut.length} 段`;
      })().catch(e => {
        const j = jobs.get(id);
        if (j) { j.state = 'error'; j.error = String(e && e.stack || e); }
      });
      return;
    }

    // --- 任务查询 ---
    if (p === '/api/job') {
      const j = jobs.get(body.id || u.searchParams.get('id'));
      if (!j) return json(res, 404, { error: 'no such job' });
      return json(res, 200, {
        id: j.id, kind: j.kind, state: j.state, progress: j.progress, total: j.total,
        message: j.message, result: j.result, error: j.error,
      });
    }

    // --- 打开输出目录 ---
    if (p === '/api/open-folder') {
      const dir = body.dir && fs.existsSync(body.dir) ? body.dir : OUT;
      spawn('explorer.exe', [dir], { detached: true, windowsHide: false }).unref();
      return json(res, 200, { ok: true, dir });
    }

    // --- 选择源文件：弹本机原生文件对话框，直接返回真实路径（不上传）---
    if (p === '/api/pick') {
      const r = await runWithTimeout('powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', PICK_PS1], 180000);
      if (r.timeout) return json(res, 200, { ok: true, path: null, canceled: true, timeout: true });
      const picked = (r.out || '').trim().replace(/^\uFEFF/, '');
      if (!picked && r.code !== 0 && r.err) {
        return json(res, 500, { error: '无法弹出文件对话框：' + r.err.trim().slice(0, 200) + '。可改用下方输入框直接粘贴路径。' });
      }
      if (!picked) return json(res, 200, { ok: true, path: null, canceled: true });
      if (!fs.existsSync(picked)) return json(res, 400, { error: '选中的文件不存在: ' + picked });
      return json(res, 200, { ok: true, path: picked, size: fs.statSync(picked).size });
    }

    // --- 解析手动粘贴的路径：文件→直接返回；目录→列出其中的视频 ---
    if (p === '/api/resolve') {
      let src = (body.path || '').trim().replace(/^"|"$/g, '');
      if (!src) return json(res, 400, { error: '路径为空' });
      if (!fs.existsSync(src)) return json(res, 400, { error: '路径不存在: ' + src });
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        const files = fs.readdirSync(src)
          .filter(f => /\.(mp4|mov|mkv|avi|flv|ts|m4v|webm|wmv)$/i.test(f))
          .map(f => ({ name: f, size: fs.statSync(path.join(src, f)).size }));
        return json(res, 200, { ok: true, kind: 'dir', dir: src, files });
      }
      return json(res, 200, { ok: true, kind: 'file', path: src, size: st.size });
    }

    // --- 内置文件浏览器：列磁盘 / 目录 / 视频文件 ---
    if (p === '/api/browse') {
      const MEDIA_RE = /\.(mp4|mov|mkv|avi|flv|ts|m4v|webm|wmv|mp3|m4a|wav|aac)$/i;
      const home = process.env.USERPROFILE || 'C:\\Users\\Administrator';
      const quick = [
        { label: '工作目录', dir: ROOT },
        { label: 'work/src', dir: path.join(WORK, 'src') },
        { label: '桌面', dir: path.join(home, 'Desktop') },
        { label: '下载', dir: path.join(home, 'Downloads') },
        { label: '视频', dir: path.join(home, 'Videos') },
        { label: '本任务目录', dir: 'F:\\workbuddy\\2026-10-01-11-46-21' },
      ].filter(q => { try { return fs.existsSync(q.dir); } catch (e) { return false; } });

      const dir = ((body && body.dir) || u.searchParams.get('dir') || '').trim();
      if (!dir) {
        const drives = [];
        for (let i = 65; i <= 90; i++) {
          const d = String.fromCharCode(i) + ':\\';
          try { if (fs.existsSync(d)) drives.push(d); } catch (e) {}
        }
        return json(res, 200, { ok: true, kind: 'root', drives, quick });
      }
      if (!fs.existsSync(dir)) return json(res, 400, { error: '目录不存在: ' + dir });
      const st = fs.statSync(dir);
      if (!st.isDirectory()) return json(res, 400, { error: '不是目录: ' + dir });

      const dirs = [], files = [];
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
        return json(res, 400, { error: '无法读取目录（可能无权限）: ' + e.message });
      }
      for (const e of entries) {
        if (e.name.startsWith('$') || e.name === 'System Volume Information' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        try {
          if (e.isDirectory()) dirs.push({ name: e.name, path: full });
          else if (MEDIA_RE.test(e.name)) files.push({ name: e.name, path: full, size: fs.statSync(full).size });
        } catch (e2) {}
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      const parent = path.dirname(dir);
      return json(res, 200, {
        ok: true, kind: 'dir', dir,
        parent: parent && parent !== dir ? parent : null,
        dirs, files, quick,
      });
    }

    // --- 导入源：上传文件（仅适合小文件；大文件请用「选择文件…」直读磁盘）---
    if (p === '/api/import') {
      const name = (body.name || 'input.mp4').replace(/[\\/:*?"<>|]/g, '_');
      const data = Buffer.from(body.dataBase64 || '', 'base64');
      if (!data.length) return json(res, 400, { error: '空文件' });
      if (data.length > 60 * 1024 * 1024) {
        return json(res, 413, { error: '文件超过 60MB，浏览器上传会卡死。请改用「选择文件…」（服务端直读磁盘，不受大小限制）。' });
      }
      const dir = path.join(WORK, 'src');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, name);
      fs.writeFileSync(dest, data);
      return json(res, 200, { ok: true, path: dest, size: data.length });
    }

    // --- 列出周边可用视频（已在上方处理，此分支保留兼容 POST）---

    res.writeHead(404); res.end('no route');
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log('童站挑战剪辑器 · 服务已启动: http://127.0.0.1:' + PORT);
  log('ffmpeg:', FFMPEG, '| python:', PY);
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') log('端口被占用，请设置 CUT_PORT 环境变量换端口');
  else log('server error', e.message);
  process.exit(1);
});
