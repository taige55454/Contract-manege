const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// ==================== 1. 强制单实例运行 (Single Instance Lock) ====================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 如果已有实例在运行，立即退出当前新拉起的进程，绝不重复占用资源
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let backendController = null;

// 确定数据存储根目录：
// - 如果是 Portable 便携版 .exe，存储在 .exe 所在目录的 ContractData 文件夹下，方便拷贝备份
// - 如果是安装版或开发环境，存储在 userData 或项目根目录
function resolveDataRoot() {
  if (!app.isPackaged) {
    return __dirname;
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'ContractData');
  }
  return path.join(app.getPath('userData'), 'ContractData');
}

// 动态生成 16x16 像素的系统托盘图标（无需外部 ico 文件，100% 稳定）
function createBuiltinTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const isBorder = x === 1 || x === size - 2 || y === 1 || y === size - 2;
      const isLine = (y === 5 || y === 8 || y === 11) && x >= 4 && x <= 11;
      if (x === 0 || x === size - 1 || y === 0 || y === size - 1) {
        // 透明外边距
        buf[idx] = 0; buf[idx + 1] = 0; buf[idx + 2] = 0; buf[idx + 3] = 0;
      } else if (isBorder || isLine) {
        // 白色文档边框与纹理 (BGRA)
        buf[idx] = 255; buf[idx + 1] = 255; buf[idx + 2] = 255; buf[idx + 3] = 255;
      } else {
        // 商务蓝底色 (#2563EB -> B:235, G:99, R:37)
        buf[idx] = 235; buf[idx + 1] = 99; buf[idx + 2] = 37; buf[idx + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// 当用户尝试第二次双击 .exe 时，自动唤醒并聚焦已有窗口（包括从最小化/托盘恢复）
app.on('second-instance', () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ==================== 2. 创建主窗口与系统托盘 ====================
async function createWindowAndTray(port, dataRoot) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 1100,
    minHeight: 680,
    title: '企业合同台账管理系统',
    icon: createBuiltinTrayIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      plugins: true // 开启内置 PDF Viewer 插件支持
    }
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);

  // 点击右上角 [X] 关闭按钮时：不退出程序，而是隐藏到系统托盘并释放页面缓存
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      // 隐藏到后台托盘时主动清理渲染层视觉缓存，降低后台内存占用
      mainWindow.webContents.session.clearCache().catch(() => {});
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 初始化系统托盘 (System Tray)
  tray = new Tray(createBuiltinTrayIcon());
  tray.setToolTip('企业合同台账管理系统 (后台运行中)');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '📂 打开合同台账主界面',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: '🗄️ 打开本地数据与扫描件目录',
      click: () => {
        shell.openPath(dataRoot);
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

  // 单击或双击托盘图标均可唤醒主窗口
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
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
    // 1. 销毁系统托盘图标，防止任务栏残留幽灵图标
    if (tray) {
      tray.destroy();
      tray = null;
    }

    // 2. 销毁所有窗口及 Chromium WebContents 子进程
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    }

    // 3. 关闭 Express HTTP 服务、强制中断所有 Socket 连接、刷盘并关闭 SQLite 数据库、清理临时目录
    if (backendController && typeof backendController.shutdown === 'function') {
      await backendController.shutdown();
      backendController = null;
    }
  } catch (err) {
    console.error('退出清理异常:', err);
  } finally {
    // 4. 释放 Electron 单实例锁并彻底结束操作系统进程
    app.releaseSingleInstanceLock();
    app.quit();
    setTimeout(() => {
      process.exit(0);
    }, 200).unref();
  }
}

// 捕获操作系统关机、注销、任务管理器结束或终端信号
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

    // 注入数据目录环境变量，再启动内嵌服务端（使用端口 0 自动分配空闲本地端口，彻底避免端口冲突）
    process.env.DATA_ROOT = dataRoot;
    const { startServer } = require('./server');
    backendController = await startServer(0, '127.0.0.1');

    await createWindowAndTray(backendController.port, dataRoot);
  } catch (err) {
    dialog.showErrorBox('系统启动失败', `无法初始化后台服务或数据库：\n${err.message}`);
    performFullExit();
  }
});
