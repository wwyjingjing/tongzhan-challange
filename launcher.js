/**
 * 启动助手（不依赖 PowerShell）：
 *   ① 已有服务在跑 → 直接打开页面
 *   ② 否则挑一个空闲端口（8777 起）→ 启动 server.js → 就绪后自动开浏览器
 *
 * 由「启动.cmd」调用。关闭控制台窗口 = 停止服务（子进程挂在同一个控制台上）。
 * 排查问题看：_launcher.log
 */
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = __dirname;
const LOG = path.join(ROOT, '_launcher.log');
const PORTS = Array.from({ length: 14 }, (_, i) => 8777 + i);   // 8777–8790

function log(...a) {
  const line = `[${new Date().toLocaleString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

/** 这个端口上是不是「我们的」服务？ */
function probe(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/env', timeout: 1200 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(res.statusCode === 200 && body.indexOf('"ok"') >= 0));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 端口是否空闲（能连上说明被占用） */
function free(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(true));
    s.setTimeout(800, () => { s.destroy(); resolve(true); });
  });
}

function openBrowser(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    log('打开浏览器失败：', e.message, '→ 请手动访问', url);
  }
}

async function main() {
  fs.writeFileSync(LOG, `---- 启动 ${new Date().toLocaleString()} ----\n`);
  console.log('============================================');
  console.log('  童站挑战剪辑器 · 本地服务');
  console.log('============================================\n');
  log('node', process.version, '·', process.execPath);

  // ① 已经有服务在跑（比如上次没关窗口）→ 直接开页面
  if (await probe(8777)) {
    log('检测到服务已在运行（8777），直接打开页面。');
    openBrowser('http://127.0.0.1:8777/');
    console.log('服务已在运行，已为你打开页面。');
    return;
  }

  // ② 挑一个空闲端口
  let port = null;
  for (const p of PORTS) {
    if (await free(p)) { port = p; break; }
  }
  if (!port) {
    console.log('[错误] 8777–8790 端口都被占用了，请先关掉占用端口的程序再启动。');
    log('端口全被占用，退出');
    return;
  }
  log('使用端口', port);

  // ③ 启动服务（前台继承控制台，日志直接显示在这里）
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CUT_PORT: String(port) }),
    stdio: 'inherit',
  });
  child.on('exit', code => { log('服务进程退出，code =', code); process.exit(code || 0); });

  const url = `http://127.0.0.1:${port}/`;
  console.log('服务地址:', url);
  console.log('就绪后会自动打开浏览器；关闭本窗口即停止服务。\n');

  // ④ 就绪后打开浏览器（最多等 30 秒，等不到就提示手动访问）
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await probe(port)) {
      log('服务已就绪，打开浏览器');
      openBrowser(url);
      return;
    }
  }
  log('等待就绪超时');
  console.log('[提示] 服务启动较慢，请手动访问：' + url);
}

main().catch(e => {
  console.log('[错误]', (e && e.message) || e);
  log('启动失败：', String((e && e.stack) || e));
});
