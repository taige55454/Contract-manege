const { app, Tray, Menu, nativeImage, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// ==================== 0. 纯浏览器模式：彻底禁用内置 GPU 硬件加速与渲染器冗余开销 ====================
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=96 --expose-gc');

// ==================== 1. 强制单实例运行 (Single Instance Lock) ====================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let tray = null;
let isShuttingDown = false;
let backendController = null;
let localAppUrl = '';
let dataRootDir = '';

// 阻止无窗口时自动退出，保持后台超轻量级托盘服务常驻
app.on('window-all-closed', () => {});

function resolveDataRoot() {
  if (!app.isPackaged) {
    return __dirname;
  }
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

// 纯内存动态生成 16x16 像素系统托盘图标
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

// 安全调用系统默认浏览器打开合同台账页面（若系统未关联默认浏览器则自动复制网址并提示）
function openInSystemBrowser() {
  if (localAppUrl && /^http:\/\/127\.0\.0\.1:\d+$/.test(localAppUrl)) {
    shell.openExternal(localAppUrl).catch(() => {
      clipboard.writeText(localAppUrl);
      dialog.showMessageBox({
        type: 'info',
        title: '合同台账系统已启动',
        message: `未检测到系统默认浏览器，已自动将系统网址复制到剪贴板：\n${localAppUrl}\n\n请打开任意浏览器粘贴访问。`
      });
    });
    triggerMainGC();
  }
}

// 当用户再次双击 .exe 图标时，自动在系统浏览器中唤醒页面
app.on('second-instance', () => {
  openInSystemBrowser();
});

// ==================== 2. 初始化系统托盘并自动弹出系统浏览器 ====================
function setupTrayAndLaunchBrowser(port, dataRoot) {
  localAppUrl = `http://127.0.0.1:${port}`;
  dataRootDir = dataRoot;

  const appIcon = createBuiltinTrayIcon();
  tray = new Tray(appIcon);
  tray.setToolTip(`企业合同台账管理系统 (纯浏览器极速模式: ${localAppUrl})`);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '🌐 在系统浏览器中打开合同台账主界面 (单击托盘图标亦可)',
      click: () => {
        openInSystemBrowser();
      }
    },
    {
      label: '🗄️ 打开数据与 uploads 扫描件/关联资料目录 (Excel放此目录可点超链接)',
      click: () => {
        if (dataRootDir && fs.existsSync(dataRootDir)) {
          shell.openPath(dataRootDir);
        }
      }
    },
    {
      label: `📋 复制本地访问地址 (${localAppUrl})`,
      click: () => {
        clipboard.writeText(localAppUrl);
      }
    },
    { type: 'separator' },
    {
      label: '🧹 立即执行后台内存垃圾回收 (GC)',
      click: () => {
        triggerMainGC();
      }
    },
    {
      label: '❌ 彻底退出并释放所有资源',
      click: () => {
        performFullExit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    openInSystemBrowser();
  });
  tray.on('double-click', () => {
    openInSystemBrowser();
  });

  openInSystemBrowser();
  setTimeout(() => triggerMainGC(), 1500);
}

// ==================== 3. 彻底退出与全链路资源销毁 ====================
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
    setTimeout(() => {
      process.exit(0);
    }, 200).unref();
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

// ==================== 4. 启动应用入口 ====================
app.whenReady().then(async () => {
  try {
    const dataRoot = resolveDataRoot();
    if (!fs.existsSync(dataRoot)) {
      fs.mkdirSync(dataRoot, { recursive: true });
    }

    process.env.DATA_ROOT = dataRoot;
    const { startServer } = require('./server');
    backendController = await startServer(0, '127.0.0.1');

    setupTrayAndLaunchBrowser(backendController.port, dataRoot);
  } catch (err) {
    dialog.showErrorBox('系统启动失败', `无法初始化后台服务或数据库：\n${err.message}`);
    performFullExit();
  }
});
