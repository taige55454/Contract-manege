const { app, Tray, Menu, nativeImage, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 纯浏览器模式：禁用内置 GPU 硬件加速，将 V8 堆内存上限设为稳妥的 256MB
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256 --expose-gc');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let tray = null;
let isShuttingDown = false;
let backendController = null;
let localAppUrl = '';
let lanAppUrl = '';
let dataRootDir = '';

app.on('window-all-closed', () => {});

function resolveDataRoot() {
  if (!app.isPackaged) return __dirname;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'ContractData');
  }
  return path.join(app.getPath('userData'), 'ContractData');
}

function triggerMainGC() {
  if (typeof global.gc === 'function') {
    try { global.gc(); } catch (e) {}
  }
}

function getLocalLanIPv4() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    if (/vmware|virtualbox|vbox|hyper-v|wsl|docker|vethernet|loopback/i.test(name)) continue;
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        candidates.push(net.address);
      }
    }
  }
  return candidates.find(ip => ip.startsWith('192.168.')) || candidates[0] || '127.0.0.1';
}

function createBuiltinTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const isBorder = x === 1 || x === size - 2 || y === 1 || y === size - 2;
      const isLine = (y === 5 || y === 8 || y === 11) && x >= 4 && x <= 11;
      if (x === 0 || x === size - 1 || y === 0 || y === size - 1) {
        buf[idx] = 0; buf[idx + 1] = 0; buf[idx + 2] = 0; buf[idx + 3] = 0;
      } else if (isBorder || isLine) {
        buf[idx] = 255; buf[idx + 1] = 255; buf[idx + 2] = 255; buf[idx + 3] = 255;
      } else {
        buf[idx] = 235; buf[idx + 1] = 99; buf[idx + 2] = 37; buf[idx + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function openInSystemBrowser() {
  if (localAppUrl && /^http:\/\/127\.0\.0\.1:\d+$/.test(localAppUrl)) {
    shell.openExternal(localAppUrl).catch(() => {
      clipboard.writeText(localAppUrl);
      dialog.showMessageBox({
        type: 'info',
        title: '合同台账系统已启动',
        message: `未检测到系统默认浏览器，已自动将本机免密网址复制到剪贴板：\n${localAppUrl}\n\n内网其他电脑受口令保护访问地址：\n${lanAppUrl}`
      });
    });
    triggerMainGC();
  }
}

app.on('second-instance', () => openInSystemBrowser());

function setupTrayAndLaunchBrowser(port, dataRoot) {
  const lanIp = getLocalLanIPv4();
  localAppUrl = `http://127.0.0.1:${port}`;
  lanAppUrl = `http://${lanIp}:${port}`;
  dataRootDir = dataRoot;

  tray = new Tray(createBuiltinTrayIcon());
  tray.setToolTip(`企业合同台账管理系统 (端口: ${port})\n本机免密: ${localAppUrl}\n内网凭口令访问: ${lanAppUrl}`);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '🌐 在系统浏览器中打开合同台账主界面 (本机免密直连)',
      click: () => openInSystemBrowser()
    },
    {
      label: `🔐 复制本次内网共享地址 (${lanAppUrl} — 需输入验证口令)`,
      click: () => {
        lanAppUrl = `http://${getLocalLanIPv4()}:${port}`;
        clipboard.writeText(lanAppUrl);
      }
    },
    {
      label: `📋 复制本机访问地址 (${localAppUrl})`,
      click: () => clipboard.writeText(localAppUrl)
    },
    {
      label: '🗄️ 打开本机数据与 uploads 扫描件/关联资料目录',
      click: () => {
        if (dataRootDir && fs.existsSync(dataRootDir)) shell.openPath(dataRootDir);
      }
    },
    { type: 'separator' },
    {
      label: '🧹 立即执行后台内存垃圾回收 (GC)',
      click: () => triggerMainGC()
    },
    {
      label: '❌ 彻底退出并释放所有资源',
      click: () => performFullExit()
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => openInSystemBrowser());
  tray.on('double-click', () => openInSystemBrowser());

  openInSystemBrowser();
  setTimeout(() => triggerMainGC(), 1500);
}

async function performFullExit() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    if (backendController && typeof backendController.shutdown === 'function') {
      await backendController.shutdown();
      backendController = null;
    }
  } catch (err) {
    console.error('退出清理异常:', err);
  } finally {
    triggerMainGC();
    app.releaseSingleInstanceLock();
    app.quit();
    setTimeout(() => process.exit(0), 200).unref();
  }
}

app.on('will-quit', (event) => {
  if (!isShuttingDown) {
    event.preventDefault();
    performFullExit();
  }
});

process.on('SIGINT', () => performFullExit());
process.on('SIGTERM', () => performFullExit());
process.on('uncaughtException', (err) => {
  console.error('未捕获异常:', err);
  performFullExit();
});
process.on('unhandledRejection', (reason) => {
  console.error('未处理的 Promise 拒绝:', reason);
});

app.whenReady().then(async () => {
  try {
    const dataRoot = resolveDataRoot();
    if (!fs.existsSync(dataRoot)) fs.mkdirSync(dataRoot, { recursive: true });
    process.env.DATA_ROOT = dataRoot;
    const { startServer } = require('./server');
    backendController = await startServer(0, '0.0.0.0');
    setupTrayAndLaunchBrowser(backendController.port, dataRoot);
  } catch (err) {
    dialog.showErrorBox('系统启动失败', `无法初始化后台服务或数据库：\n${err.message}`);
    performFullExit();
  }
});
