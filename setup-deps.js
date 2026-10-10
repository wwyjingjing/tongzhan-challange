/**
 * setup-deps.js —— 一键准备依赖（双击「安装依赖.cmd」运行）
 *
 * 这个工具只需要一个外部程序：ffmpeg。
 * 流程：先看本机有没有（PATH / 工具目录 / 常见位置 / 扫描）→ 没有就下载官方压缩包 →
 *       解压到 <工具目录>\ffmpeg\bin\（不改 PATH、不需要管理员）→ 复检。
 *
 * 支持的加速/自定义：
 *   set FFMPEG_URL=<你的镜像或本地 zip 的直链>        （国内可指向自己的镜像）
 *   把 ffmpeg.zip 直接放到工具目录里再运行本脚本        （离线：别人传给你的 zip）
 * 备份地址：gyan.dev → GitHub(BtbN) 依次尝试。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const readline = require('readline');
const TOOLS = require('./findtools');

const ROOT = __dirname;
const DEST = path.join(ROOT, 'ffmpeg', 'bin');          // findtools 会自动来找这里
const LOCAL_ZIP = path.join(ROOT, 'ffmpeg.zip');
const SOURCES = [
  process.env.FFMPEG_URL || '',
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
].filter(Boolean);

const isWin = process.platform === 'win32';

function log(...a) { console.log(...a); }
function mb(n) { return (n / 1048576).toFixed(1) + 'MB'; }

/* ---------- 1. 先看看本机到底缺什么 ---------- */
function selfCheck(scan) {
  const ff = TOOLS.resolveFfmpeg(ROOT, scan === false ? false : true);
  log('');
  log('  当前状态：');
  log('    ffmpeg : ' + (ff.ok ? '✔ 已有 —— ' + ff.path : '✘ 没有'));
  const py = TOOLS.resolvePython(ROOT);
  log('    Python : ' + (py.ok && py.pillow ? '✔ 已有（不再需要，工具已改成浏览器渲染标记）'
    : '不需要了（✅/❌ + 编号 现在由浏览器渲染，不再依赖 Python）'));
  log('');
  return ff.ok;
}

/* ---------- 2. 下载（跟随重定向 + 进度） ---------- */
function download(url, dest, redirects) {
  return new Promise((resolve, reject) => {
    const n = redirects == null ? 5 : redirects;
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('地址无效：' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { headers: { 'User-Agent': 'tz-cutter-setup' }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (n <= 0) return reject(new Error('重定向次数过多'));
        return download(new URL(res.headers.location, u).href, dest, n - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0, lastPct = -1;
      const out = fs.createWriteStream(dest);
      res.on('data', c => {
        got += c.length;
        const pct = total ? Math.floor(got / total * 100) : -1;
        if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
          lastPct = pct;
          process.stdout.write(`\r    下载中… ${pct >= 0 ? pct + '%' : ''} ${mb(got)}${total ? ' / ' + mb(total) : ''}   `);
        }
      });
      res.pipe(out);
      out.on('finish', () => { process.stdout.write('\r    下载完成：' + mb(got) + '                    \n'); resolve(dest); });
      out.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('下载超时')); });
    req.on('error', reject);
  });
}

/* ---------- 3. 解压（内置实现，不依赖外部命令） ---------- */
function unzip(zipPath, outDir) {
  const buf = fs.readFileSync(zipPath);
  // 找中央目录结尾（EOCD）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（没找到目录结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let made = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + cmtLen;
    if (name.endsWith('/')) continue;
    if (name.includes('..')) continue;                       // 防目录穿越
    // 本地头 → 数据段
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else continue;                                            // 其它压缩方式跳过
    const full = path.join(outDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    made++;
  }
  if (!made) throw new Error('解压出来 0 个文件');
  return made;
}

/** 在解压目录里找 ffmpeg（顺带把它旁边的 DLL 一起算上，shared 构建也能用） */
function findInDir(dir, depth) {
  if (depth > 4) return null;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
  const exe = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  if (ents.some(e => e.isFile() && e.name.toLowerCase() === exe)) return dir;
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const hit = findInDir(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

/* ---------- 可选：OCR（自动打点「认字幕变化」用） ---------- */
function runCmd(cmd, args, label) {
  return new Promise(resolve => {
    console.log('    ' + cmd + ' ' + args.join(' '));
    const p = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true });
    resolve(p.status === 0);
  });
}
function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, ans => { rl.close(); resolve(/^y/i.test(String(ans || '').trim())); });
  });
}
async function ensureOcr() {
  const py = TOOLS.resolvePython(ROOT);
  const has = !!(py.ok && py.ocr);
  log('');
  log('  自动打点（OCR 认字幕变化）: ' + (has ? '✔ 已装 ' + ((py.ocrVer && py.ocrVer !== '?') ? py.ocrVer : 'RapidOCR') : '未装（这是可选功能，不影响其他功能）'));
  if (has) return;
  if (!py.ok) {
    log('    想用「自动打点」的话：');
    log('      1) 装 Python: https://www.python.org/downloads/  （安装时勾选 Add to PATH）');
    log('      2) 再运行:    pip install rapidocr_onnxruntime');
    return;
  }
  log('    （本机 Python: ' + py.path + '）');
  const yes = await ask('    要顺便装 OCR 吗？纯本地离线模型，约 60MB [Y/N] ');
  if (!yes) { log('    跳过。以后想装：' + py.path + ' -m pip install rapidocr_onnxruntime'); return; }
  let ok = await runCmd(py.path, ['-m', 'pip', 'install', 'rapidocr_onnxruntime']);
  if (!ok) {                                   // 国内网络慢时走清华镜像
    log('    默认源失败，换清华镜像再试一次…');
    ok = await runCmd(py.path, ['-m', 'pip', 'install', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', 'rapidocr_onnxruntime']);
  }
  log(ok ? '    ✔ OCR 装好了（自动打点可用）' : '    ✘ OCR 没装上；可稍后手动运行上面那条 pip 命令');
}

async function main() {
  log('============================================');
  log('  童站挑战剪辑器 · 依赖安装（只需 ffmpeg）');
  log('============================================');
  if (selfCheck()) {
    await ensureOcr();
    log('');
    log('  什么都不用装，直接双击「启动.cmd」就能用。');
    return 0;
  }
  if (!isWin) {
    log('  非 Windows 环境请自行安装 ffmpeg（apt install ffmpeg / brew install ffmpeg）。');
    return 1;
  }

  const tmp = path.join(os.tmpdir(), 'tz_ffmpeg_' + Date.now() + '.zip');
  let zip = '';
  if (fs.existsSync(LOCAL_ZIP)) {
    zip = LOCAL_ZIP;
    log('  发现工具目录里的 ffmpeg.zip，直接用这个（不联网）。');
  } else {
    log('  本机没找到 ffmpeg，准备下载官方压缩包（约 80MB，只下一次，之后离线可用）。');
    log('  下载地址依次尝试：gyan.dev → GitHub；国内慢的话可以先自己下载好，');
    log('  改名为 ffmpeg.zip 放进本工具目录，再双击本脚本。');
    log('');
    let lastErr = null;
    for (const src of SOURCES) {
      try {
        log('  → ' + src.slice(0, 90));
        await download(src, tmp, 5);
        zip = tmp;
        break;
      } catch (e) {
        lastErr = e;
        log('    失败：' + (e.message || e) + '，换下一个地址…');
      }
    }
    if (!zip) {
      log('');
      log('  ✘ 下载失败：' + ((lastErr && lastErr.message) || ''));
      log('    你可以手动装：');
      log('      1) 下载 https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip');
      log('      2) 解压，把里面的 bin 文件夹改名为 ffmpeg，放到：');
      log('         ' + path.join(ROOT, 'ffmpeg'));
      log('         （即最后是 ' + DEST + ' 这种结构）');
      log('      3) 再双击「启动.cmd」');
      return 1;
    }
  }

  const exDir = path.join(os.tmpdir(), 'tz_ffmpeg_x_' + Date.now());
  try {
    log('  正在解压…');
    let made = 0;
    try { made = unzip(zip, exDir); }
    catch (e) {                                             // 兜底：用系统的 tar（Win10 1803+ 自带）
      log('    内置解压失败（' + e.message + '），改用系统 tar…');
      fs.mkdirSync(exDir, { recursive: true });
      const r = spawnSync('tar', ['-xf', zip, '-C', exDir], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
      if (r.status !== 0) throw new Error('tar 解压也失败：' + String((r.stderr || '') + (r.stdout || '')).slice(0, 200));
      made = 1;
    }
    const srcDir = findInDir(exDir, 0);
    if (!srcDir) throw new Error('解压后没找到 ffmpeg.exe');
    fs.mkdirSync(DEST, { recursive: true });
    let copied = 0, bytes = 0;
    for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      // 只拿 ffmpeg.exe 和它可能需要的 DLL（ffplay/ffprobe 用不上，省 300MB）
      const okName = /^ffmpeg\.exe$/i.test(e.name) || /\.dll$/i.test(e.name);
      if (!okName) continue;
      const src2 = path.join(srcDir, e.name), dst2 = path.join(DEST, e.name);
      fs.copyFileSync(src2, dst2);
      try { bytes += fs.statSync(dst2).size; } catch (err) {}
      copied++;
    }
    log(`  已安装 ${copied} 个文件（${mb(bytes)}）到 ${DEST}`);
    // 清缓存，让下次启动重新探测
    try { fs.unlinkSync(path.join(ROOT, 'work', '_tools.json')); } catch (e) {}
  } catch (e) {
    log('  ✘ 解压/安装失败：' + (e.message || e));
    return 1;
  } finally {
    try { fs.rmSync(exDir, { recursive: true, force: true }); } catch (e) {}
    if (zip === tmp) { try { fs.unlinkSync(tmp); } catch (e) {} }
  }

  log('');
  if (selfCheck(false)) {
    await ensureOcr();
    log('');
    log('  ✔ 搞定！现在双击「启动.cmd」就能用了（以后都不需要联网）。');
    return 0;
  }
  log('  ⚠ 装好了但没检测到，请把上面那行路径发我看看。');
  return 1;
}

main().then(code => { process.exitCode = code; }).catch(e => {
  log('  ✘ 出错：' + ((e && e.stack) || e));
  process.exitCode = 1;
});
