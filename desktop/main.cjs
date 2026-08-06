const { app, BrowserWindow, dialog, session, shell } = require('electron');
const { existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createCambriaBrowserBridge } = require('./cambria-browser.cjs');
const { createTollanBrowserBridge } = require('./tollan-browser.cjs');

let mainWindow;
let serverHandle;
let cambriaBrowser;
let tollanBrowser;

if (app.isPackaged) {
  const currentDataDir = join(app.getPath('appData'), 'Abstract Hub');
  const legacyDataDir = join(app.getPath('appData'), 'Gigaverse Bot');
  app.setPath(
    'userData',
    existsSync(currentDataDir) || !existsSync(legacyDataDir) ? currentDataDir : legacyDataDir,
  );
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createApplication() {
  const appRoot = app.getAppPath();
  const dataDir = app.isPackaged ? app.getPath('userData') : appRoot;
  mkdirSync(dataDir, { recursive: true });

  process.env.GIGABOT_DESKTOP = '1';
  process.env.GIGABOT_REMEMBER = 'true';
  process.env.GIGABOT_DATA_DIR = dataDir;
  process.env.GIGABOT_APP_ROOT = appRoot;
  process.env.GIGABOT_BUILD_PLAN = join(appRoot, 'dist', 'build.yaml');
  if (app.isPackaged) process.env.GIGABOT_HOME = dataDir;

  if (!serverHandle) {
    const serverModuleUrl = pathToFileURL(join(appRoot, 'dist', 'src', 'ui', 'server.js')).href;
    const { startUiServer } = await import(serverModuleUrl);
    if (!cambriaBrowser) {
      cambriaBrowser = createCambriaBrowserBridge({ app, session });
    }
    if (!tollanBrowser) {
      tollanBrowser = createTollanBrowserBridge({ app, BrowserWindow, session });
    }
    const serverOptions = {
      dataDir,
      appRoot,
      desktop: true,
      openBrowser: false,
      childCommand: app.isPackaged ? process.execPath : 'node',
      electronRunAsNode: app.isPackaged,
      cambriaBrowser: cambriaBrowser.bridge,
      tollanBrowser: tollanBrowser.bridge,
    };
    for (const port of [3737, 3738, 3739]) {
      try {
        serverHandle = await startUiServer({ ...serverOptions, port });
        break;
      } catch (error) {
        if (!error || error.code !== 'EADDRINUSE') throw error;
      }
    }
    if (!serverHandle) serverHandle = await startUiServer({ ...serverOptions, port: 0 });
  }

  mainWindow = new BrowserWindow({
    title: 'Abstract Hub',
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 640,
    show: false,
    backgroundColor: '#eef0eb',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverHandle.url)) event.preventDefault();
  });

  await mainWindow.loadURL(serverHandle.url);
}

if (hasSingleInstanceLock) {
  app.on('second-instance', focusMainWindow);

  app
    .whenReady()
    .then(createApplication)
    .catch((error) => {
      dialog.showErrorBox(
        'Abstract Hub не запустился',
        error instanceof Error ? error.stack || error.message : String(error),
      );
      app.quit();
    });

  app.on('activate', () => {
    if (mainWindow) focusMainWindow();
    else void createApplication();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (serverHandle) void serverHandle.stop();
    if (cambriaBrowser) cambriaBrowser.dispose();
    if (tollanBrowser) tollanBrowser.dispose();
  });
}
