const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// ==================== 0. 铬内核深度轻量化与内存压降优化（稳定优先） ====================
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-component-extensions-with-background-pages');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-translate');
app.commandLine.appendSwitch(' mute-audio');
app.commandLine.appendSwitch('disk-cache-size', '1048576'); // 限制磁盘缓存 1MB，本地回环无需重复缓存
app.commandLine.appendSwitch('media-cache-size', '1048576');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128 --expose-gc');

// ==================== 1. 强制单实例运行 (Single Instance Lock) ====================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let backendController = null;

function resolveDataRoot() {
  if (!app.isPackaged) {
    return __dirname;
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'ContractData');
  }
  return path.join(app.getPath('userData'), 'ContractData');
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

app.on('second-instance', () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ==================== 2. 创建主窗口与系统托盘 ====================
async function createWindowAndTray(port, dataRoot) {
  const appIcon = createBuiltinTrayIcon();
  const localUrl = `http://127.0.0.1:${port}`;

  mainWindow = new BrowserWindow({
    width: 1520,
    height: 920,
    minWidth: 1150,
    minHeight: 680,
    title: '企业合同台账管理系统',
    icon: appIcon,
    autoHideMenuBar: true,
    backgroundColor: '#f3f4f6',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
      enableWebSQL: false,
      v8CacheOptions: 'none',
      plugins: true // 保持内置 PDF 扫描件预览支持
    }
  });

  await mainWindow.loadURL(localUrl);

  // 点击右上角 [X] 时隐藏到系统托盘，并主动回收内存
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      mainWindow.webContents.session.clearCache().catch(() => {});
      if (typeof global.gc === 'function') {
        try { global.gc(); } catch (e) {}
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  tray = new Tray(appIcon);
  tray.setToolTip('企业合同台账管理系统 (单击唤醒窗口)');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '📂 打开合同台账主界面',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
      }
    },
    {
      label: '🗄️ 打开数据与 uploads 扫描件目录 (Excel放此目录即可点击超链接)',
      click: () => {
        shell.openPath(dataRoot);
      }
    },
    {
      label: '🌐 在系统浏览器中打开网页版',
      click: () => {
        shell.openExternal(localUrl);
      }
    },
    { type: 'separator' },
    {
      label: '❌ 彻底退出并释放所有资源',
      click: () => {
        performFullExit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ==================== 3. 彻底退出与全链路资源销毁 ====================
let isShuttingDown = false;

async function performFullExit() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  isQuitting = true;

  try {
    if (tray) {
      tray.destroy();
      tray = null;
    }

    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    }

    if (backendController && typeof backendController.shutdown === 'function') {
      await backendController.shutdown();
      backendController = null;
    }
  } catch (err) {
    console.error('退出清理异常:', err);
  } finally {
    app.releaseSingleInstanceLock();
    app.quit();
    setTimeout(() => {
      process.exit(0);
    }, 200).unref();
  }
}

app.on('before-quit', () => {
  isQuitting = true;
});

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

    await createWindowAndTray(backendController.port, dataRoot);
  } catch (err) {
    dialog.showErrorBox('系统启动失败', `无法初始化后台服务或数据库：\n${err.message}`);
    performFullExit();
  }
});
