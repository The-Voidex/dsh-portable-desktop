// DSH 专属桌面壳 — 主进程
// 职责：单实例 / 拉起并守护 dsh web 服务 / 主窗口（标准窗口）/ 系统托盘 / 开机自启 / 日志
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } = require('electron');
const { spawn, execFile } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_URL = 'http://127.0.0.1:3080';
const PORT = 3080;
const APP_NAME = 'DSH 桌面端';
const ICON = path.join(__dirname, 'icon.ico');
const ERROR_PAGE = path.join(__dirname, 'error.html');

// 托盘菜单图标：绿色勾（选中态）与透明占位（保证各菜单项文字列对齐）
const CHECK_ICON = (() => { try { return nativeImage.createFromPath(path.join(__dirname, 'check.png')); } catch { return nativeImage.createEmpty(); } })();
const BLANK_ICON = (() => { try { return nativeImage.createFromPath(path.join(__dirname, 'blank.png')); } catch { return nativeImage.createEmpty(); } })();

// 日志：沿用 %LOCALAPPDATA%\dsh-desktop.log（与启动器日志分开，互不干扰）
// 轮转：超过 2MB 时把旧日志改名为 .old 再重新开始，避免无上限增长
const LOG_FILE = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'dsh-desktop.log');
try {
  const st = fs.statSync(LOG_FILE);
  if (st.size > 2 * 1024 * 1024) {
    const oldFile = LOG_FILE + '.old';
    fs.rmSync(oldFile, { force: true });
    fs.renameSync(LOG_FILE, oldFile);
  }
} catch { /* 无日志或无法访问时跳过轮转 */ }
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  logStream.write(line);
  console.log(line.trim());
}

let win = null;
let tray = null;
let quitting = false;
let restarting = false; // 重启互斥：防止托盘连点导致重复拉起服务
let serverChild = null;
let lastAutoReloadAt = 0;  // 健康看护自动重连的冷却时间戳
let serverUpWatch = null;  // 健康看护记录的服务在线状态（'up' | 'down'）
const boundsFile = path.join(app.getPath('userData'), 'window.json');

// ---------- 单实例 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    healAutoLaunchPath();
    createTray();
    createWindow();
    loadApp();
  });
  app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
  app.on('before-quit', () => { quitting = true; });
}

// ---------- 开机自启路径自愈 ----------
// 便携版 exe 更新/移动后，Windows 登录项（Run 键）仍指向旧路径会导致开机自启失效。
// 检测到“已开启自启但路径不是当前 exe”时，自动把登录项改指向当前 exe。
function healAutoLaunchPath() {
  try {
    const settings = app.getLoginItemSettings();
    if (settings.openAtLogin && settings.path &&
        settings.path.toLowerCase() !== process.execPath.toLowerCase()) {
      app.setLoginItemSettings({ openAtLogin: false });
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
      log(`开机自启路径已更新：${settings.path} -> ${process.execPath}`);
    }
  } catch (e) {
    log(`开机自启路径检查跳过：${e.message}`);
  }
}

// ---------- 端口检测 / 服务管理 ----------
function isListening(port, cb) {
  const s = net.connect({ port, host: '127.0.0.1' });
  let done = false;
  const finish = (ok) => { if (!done) { done = true; s.destroy(); cb(ok); } };
  s.setTimeout(400);
  s.on('connect', () => finish(true));
  s.on('error', () => finish(false));
  s.on('timeout', () => finish(false));
}

function waitForServer(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      isListening(PORT, (ok) => {
        if (ok || Date.now() - start > timeoutMs) return resolve(ok);
        setTimeout(tick, 300);
      });
    };
    tick();
  });
}

// 判断 3080 上是不是真正的 DSH Web 服务：DSH 前端 HTML 会注入
// window.__DSH_BOOT__（只有 dsh web 会注入该标记）。
// 防止把其他程序的 3080 端口误当成 DSH——既避免加载错误页面，
// 也避免“重启/退出”时误杀无关进程。
function isDshServer(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; req.destroy(); resolve(ok); } };
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/', timeout: timeoutMs, headers: { accept: 'text/html' } },
      (res) => {
        if (res.statusCode !== 200) return finish(false);
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.includes('__DSH_BOOT__')) return finish(true); // 标记在前部，命中即确认
          if (body.length > 65536) finish(false); // 大响应仍未命中：不是 DSH
        });
        res.on('end', () => finish(body.includes('__DSH_BOOT__')));
        res.on('error', () => finish(false));
        res.on('aborted', () => finish(false));
      }
    );
    req.on('timeout', () => finish(false));
    req.on('error', () => finish(false));
  });
}

// 等待端口真正释放（kill 之后确认旧进程退出，避免新实例 EADDRINUSE）
function waitForPortFree(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      isListening(PORT, (ok) => {
        if (!ok || Date.now() - start > timeoutMs) return resolve(!ok);
        setTimeout(tick, 300);
      });
    };
    tick();
  });
}

// 把 killPortOwner 的 callback 风格包成 Promise
function killPortOwnerP() {
  return new Promise((resolve) => killPortOwner(resolve));
}

// 定位 dsh 命令：PATH → 全局 npm → npx 缓存兜底
function resolveDsh() {
  const pathEnv = process.env.Path || '';
  for (const dirRaw of pathEnv.split(';')) {
    const dir = dirRaw.trim();
    if (!dir) continue;
    for (const name of ['dsh.cmd', 'dsh.exe', 'dsh.bat']) {
      const f = path.join(dir, name);
      if (fs.existsSync(f)) return f;
    }
  }
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  for (const base of [appData, localAppData]) {
    const f = path.join(base, 'npm', 'dsh.cmd');
    if (fs.existsSync(f)) return f;
  }
  try {
    const npxRoot = path.join(localAppData, 'npm-cache', '_npx');
    if (fs.existsSync(npxRoot)) {
      let best = null, bestT = 0;
      for (const dir of fs.readdirSync(npxRoot)) {
        const f = path.join(npxRoot, dir, 'node_modules', '.bin', 'dsh.cmd');
        if (fs.existsSync(f)) {
          const t = fs.statSync(f).mtimeMs;
          if (t > bestT) { bestT = t; best = f; }
        }
      }
      if (best) return best;
    }
  } catch { /* ignore */ }
  return null;
}

// 隐藏窗口拉起 dsh web，输出进日志文件
function startServer() {
  const dsh = resolveDsh();
  if (!dsh) {
    log('启动失败：未找到 dsh 命令（请先 npm install -g @deepseek-ai/dsh）');
    return false;
  }
  log(`启动服务: ${dsh} web --no-open`);
  // 注意：不要手工给 dsh 路径加引号——Node 在 Windows 下会为含空格的参数
  // 自动加引号，手工引号会被双重转义导致 cmd 报"不是内部或外部命令"。
  // --no-open：dsh web 默认会自动打开默认浏览器；桌面壳自己就是窗口，
  // 必须关掉这个行为，否则每次启动/重启桌面端都会额外唤起网页端。
  serverChild = spawn('cmd.exe', ['/c', dsh, 'web', '--no-open'], { windowsHide: true });
  serverChild.stdout.pipe(logStream, { end: false });
  serverChild.stderr.pipe(logStream, { end: false });
  serverChild.on('exit', (code) => {
    log(`dsh web 进程退出，code=${code}`);
    serverChild = null;
  });
  return true;
}

// 杀掉占用 3080 的进程（与 重启DSH.bat 同逻辑）
function killPortOwner(cb) {
  execFile('netstat', ['-ano'], (err, stdout) => {
    const pids = new Set();
    if (!err) {
      for (const line of stdout.split(/\r?\n/)) {
        if (line.includes(':3080') && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (/^\d+$/.test(pid)) pids.add(pid);
        }
      }
    }
    const next = () => {
      const it = pids.values().next();
      if (it.done) return cb();
      pids.delete(it.value);
      execFile('taskkill', ['/F', '/T', '/PID', String(it.value)], () => next());
    };
    next();
  });
}

// ---------- 窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    icon: ICON,
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.setMenuBarVisibility(false);

  // 记忆窗口位置/大小（校验可见性：显示器移除/分辨率变化后旧坐标可能落在屏幕外，
  // 直接恢复会导致窗口“凭空消失”，这种情况丢弃存档用默认位置）
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
    if (b && b.width && b.height && Number.isFinite(b.x) && Number.isFinite(b.y)) {
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
      });
      if (onScreen) win.setBounds(b);
    }
  } catch { /* 首次运行无存档 */ }
  const saveBounds = () => {
    if (win.isMinimized() || win.isMaximized()) return;
    try { fs.writeFileSync(boundsFile, JSON.stringify(win.getBounds())); } catch { /* ignore */ }
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // 关闭 = 最小化到托盘（除非真正退出）
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });

  // 加载失败护栏：服务刚就绪瞬间可能误报失败，自动重试 3 次再弹错误页
  let failCount = 0;
  win.webContents.on('did-finish-load', () => {
    failCount = 0;
    // 每次页面加载后应用并提示当前缩放级别（含重启后首次进入）
    win.webContents.setZoomLevel(zoomLevel);
    ensureZoomBadge();
  });
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (quitting || !isMainFrame) return;
    isListening(PORT, (ok) => {
      if (ok && failCount < 3) {
        failCount++;
        log(`页面加载暂时失败（${code}），自动重试 ${failCount}/3`);
        setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(WEB_URL); }, 800);
      } else {
        showError(`页面加载失败（${code} ${desc}）`);
      }
    });
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showError(msg) {
  if (!win || win.isDestroyed()) return;
  win.loadFile(ERROR_PAGE, { query: { msg: encodeURIComponent(msg || '未知错误') } });
}

// 启动/重连：等端口 → 起服务 → 等就绪 → 载入界面
async function loadApp() {
  if (!win || win.isDestroyed()) return;
  const alreadyUp = await waitForServer(3000);
  if (alreadyUp) {
    if (await isDshServer()) {
      win.loadURL(WEB_URL);
      return;
    }
    // 端口被监听但不是 DSH：不覆盖别人的服务，明确提示
    showError(`端口 ${PORT} 已被其他程序占用，且不是 DSH 服务。
请先关闭占用该端口的程序后重试。`);
    return;
  }
  if (!startServer()) {
    showError('未找到 dsh 命令。请先在 PowerShell 执行：npm install -g @deepseek-ai/dsh');
    return;
  }
  const ok = await waitForServer(90000);
  if (ok && await isDshServer()) {
    win.loadURL(WEB_URL);
  } else {
    showError(`DSH 服务启动失败（90 秒超时）。请查看日志：${LOG_FILE}`);
  }
}

// 托盘菜单里的重启：校验身份 → 杀旧进程 → 等端口释放 → 拉起新服务 → 窗口重连
// 增加互斥锁，连点托盘不会重复拉起多个服务进程。
async function restartDsh() {
  if (restarting) { log('重启已在进行中，忽略重复请求'); return; }
  restarting = true;
  log('收到重启请求');
  try {
    if (await isDshServer()) {
      await killPortOwnerP();
      // 确认旧进程真正退出再启动，避免新实例 EADDRINUSE 直接退出
      await new Promise((r) => setTimeout(r, 800));
      await waitForPortFree(8000);
    } else {
      log('3080 端口上不是 DSH 服务，跳过杀进程，直接启动');
    }
    startServer();
    const ok = await waitForServer(90000);
    if (ok && await isDshServer() && win && !win.isDestroyed()) {
      lastAutoReloadAt = Date.now(); // 避免健康看护紧接着再刷一次
      win.loadURL(WEB_URL);
      tray && tray.displayBalloon && tray.displayBalloon({ title: APP_NAME, content: 'DSH 已重启完成' });
    } else {
      showError(`DSH 重启失败。请查看日志：${LOG_FILE}`);
    }
  } finally {
    restarting = false;
  }
}

// ---------- 页面缩放：Ctrl+滚轮 / Ctrl+0 / Ctrl+= / Ctrl+- ----------
// preload 捕获手势后通过 IPC 通知这里；缩放走 Chromium 页面缩放，
// 与浏览器 Ctrl+滚轮行为一致（整体界面等比缩放，文字随之变大变小）。
const ZOOM_FILE = path.join(app.getPath('userData'), 'zoom.json');
const ZOOM_MIN = -3;   // 最小 50%
const ZOOM_MAX = 4;    // 最大 300%
const ZOOM_STEP = 0.3; // 每个滚轮刻度约 10%

let zoomLevel = 0;
try {
  const saved = JSON.parse(fs.readFileSync(ZOOM_FILE, 'utf8'));
  if (typeof saved.level === 'number') zoomLevel = saved.level;
} catch { /* 首次运行无存档 */ }

const clampZoom = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 10) / 10));
const zoomPct = (level) => Math.round(100 * Math.pow(1.25, level));

function applyZoom(level) {
  zoomLevel = clampZoom(level);
  try { fs.writeFileSync(ZOOM_FILE, JSON.stringify({ level: zoomLevel })); } catch { /* ignore */ }
  if (win && !win.isDestroyed()) win.webContents.setZoomLevel(zoomLevel);
  showZoomBadge();
}
const zoomIn = () => applyZoom(zoomLevel + ZOOM_STEP);
const zoomOut = () => applyZoom(zoomLevel - ZOOM_STEP);
const resetZoom = () => applyZoom(0);

// 右下角缩放百分比提示（1 秒后自动淡出）
function zoomBadgeJs(pct, show) {
  return `(() => {
    let b = document.getElementById('dsh-zoom-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'dsh-zoom-badge';
      b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:rgba(0,0,0,.65);color:#fff;font:12px/1.8 "Microsoft YaHei",sans-serif;padding:0 10px;border-radius:999px;opacity:0;transition:opacity .25s;pointer-events:none;user-select:none;';
      document.body.appendChild(b);
    }
    b.textContent = ${JSON.stringify(pct + '%')};
    clearTimeout(b._t);
    if (${show ? 'true' : 'false'}) {
      b.style.opacity = '1';
      b._t = setTimeout(() => { b.style.opacity = '0'; }, 900);
    }
  })()`;
}
function ensureZoomBadge() {
  if (win && !win.isDestroyed()) win.webContents.executeJavaScript(zoomBadgeJs(zoomPct(zoomLevel), false)).catch(() => {});
}
function showZoomBadge() {
  if (win && !win.isDestroyed()) win.webContents.executeJavaScript(zoomBadgeJs(zoomPct(zoomLevel), true)).catch(() => {});
}

ipcMain.on('zoom-wheel', (_e, dir) => { if (dir === 'in') zoomIn(); else zoomOut(); });
ipcMain.on('zoom-in', () => zoomIn());
ipcMain.on('zoom-out', () => zoomOut());
ipcMain.on('zoom-reset', () => resetZoom());

// ---------- 托盘 ----------
function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON));
  } catch {
    return; // 图标异常时托盘可缺失，不影响主功能
  }
  tray.setToolTip(APP_NAME);
  tray.on('click', () => showWindow());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const autoLaunch = app.getLoginItemSettings().openAtLogin;
  // 全角空格对称填充：原生 Windows 托盘菜单不支持真正的文字居中，用等宽留白
  // 让各菜单项文字在视觉上居中；绿色勾图标表示开机自启动已开启。
  const pad = (label) => `\u3000${label}\u3000`;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: pad('重启 DSH'), icon: BLANK_ICON, click: () => restartDsh() },
    {
      label: pad('开机自启动'),
      icon: autoLaunch ? CHECK_ICON : BLANK_ICON,
      click: () => {
        app.setLoginItemSettings({ openAtLogin: !autoLaunch });
        refreshTrayMenu();
        tray.displayBalloon({ title: APP_NAME, content: !autoLaunch ? '已开启开机自启动' : '已关闭开机自启动' });
      }
    },
    { type: 'separator' },
    { label: pad('退出 DSH'), icon: BLANK_ICON, click: () => exitDsh() }
  ]));
}

// 退出 DSH：确认 3080 上是 DSH 服务后杀掉（释放端口），再关闭桌面壳。
// 不同于普通关闭——普通关闭只是藏到托盘，这里会真正停掉后台服务。
// 若 3080 被其他程序占用则不误杀，只退出桌面壳。
async function exitDsh() {
  if (quitting) return;
  quitting = true;
  log('收到退出请求：停止 DSH 服务并退出桌面壳');
  if (await isDshServer()) {
    await killPortOwnerP();
  } else {
    log('3080 端口上不是 DSH 服务，跳过杀进程，直接退出');
  }
  setTimeout(() => {
    try { app.quit(); } catch (e) { process.exit(0); }
  }, 500);
}

// ---------- 服务健康看护：服务宕机/重启后自动重连窗口 ----------
// 托盘重启或 dsh web 意外退出后，窗口若停留在错误页或断开连接，
// 这里会在服务恢复时自动重新载入，无需手工点“重试”。
setInterval(async () => {
  if (quitting || restarting || !win || win.isDestroyed()) return;
  const up = await new Promise((r) => isListening(PORT, r));
  const prev = serverUpWatch;
  serverUpWatch = up ? 'up' : 'down';
  if (prev === 'down' && up) {
    const now = Date.now();
    if (now - lastAutoReloadAt < 3000) return;
    lastAutoReloadAt = now;
    const current = win.webContents.getURL();
    if (current.startsWith(WEB_URL) || current === 'about:blank' || current.startsWith('file://')) {
      log('检测到 DSH 服务已恢复，自动重连窗口');
      win.loadURL(WEB_URL).catch(() => {});
    }
  }
}, 5000);

// 退出前收尾日志流，避免最后的日志行丢失
app.on('will-quit', () => {
  try { logStream.end(); } catch { /* ignore */ }
});

// ---------- 错误页的重试按钮 ----------
ipcMain.handle('dsh-retry', () => loadApp());
