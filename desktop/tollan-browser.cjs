/* global module, setInterval, setTimeout, clearInterval, clearTimeout */

const { URL } = require('node:url');
const { answerProxyLogin } = require('./proxy-login.cjs');

const LOAD_TIMEOUT_MS = 2 * 60_000;
const LAUNCHER_TIMEOUT_MS = 45_000;
const PRACTICE_WINDOW_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 30 * 60_000;
const INPUT_INTERVAL_MS = 2_400;
const ASSIST_INTERVAL_MS = 3_200;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safePartitionKey(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .slice(0, 80) || 'account'
  );
}

function hostForProxy(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function proxySignature(proxy) {
  return `${proxy.type}:${proxy.host}:${proxy.port}:${proxy.username || ''}`;
}

function snapshotCopy(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

function rewardSummary(body) {
  const transfers = Array.isArray(body?.transfers) ? body.transfers : [];
  if (transfers.length === 0) return 'Забег подтверждён';
  return transfers
    .map((entry) => {
      const count = Number(entry?.rewardCount ?? 0);
      const inventory = String(entry?.rewardInventory ?? 'награда');
      if (inventory === 'GATCHA_CHEST') return `сундук ×${Math.max(1, count)}`;
      return `${inventory} ×${Math.max(1, count)}`;
    })
    .join(' · ');
}

function parseSetCookie(header) {
  const parts = String(header)
    .split(';')
    .map((part) => part.trim());
  const first = parts.shift() || '';
  const separator = first.indexOf('=');
  if (separator <= 0) return null;
  const cookie = {
    name: first.slice(0, separator),
    value: first.slice(separator + 1),
    path: '/',
    secure: true,
  };
  for (const part of parts) {
    const [rawName, ...rawValue] = part.split('=');
    const name = rawName.toLowerCase();
    const value = rawValue.join('=');
    if (name === 'domain' && value) cookie.domain = value;
    if (name === 'path' && value) cookie.path = value;
    if (name === 'httponly') cookie.httpOnly = true;
    if (name === 'secure') cookie.secure = true;
    if (name === 'samesite') {
      const normalized = value.toLowerCase();
      cookie.sameSite =
        normalized === 'strict' ? 'strict' : normalized === 'lax' ? 'lax' : 'no_restriction';
    }
  }
  return cookie;
}

class TollanBrowserSessions {
  constructor({ app, BrowserWindow, session }) {
    this.app = app;
    this.BrowserWindow = BrowserWindow;
    this.session = session;
    this.states = new Map();
    this.queue = Promise.resolve();
    this.handleLogin = (event, webContents, _details, authInfo, callback) => {
      answerProxyLogin(this.states, event, webContents, authInfo, callback);
    };
    this.app.on('login', this.handleLogin);
  }

  stateFor(input) {
    const key = safePartitionKey(input.sessionKey || input.address);
    let state = this.states.get(key);
    if (!state) {
      const partition = `persist:abstract-hub-tollan-${key}`;
      state = {
        key,
        partition,
        browserSession: this.session.fromPartition(partition),
        proxy: input.proxy,
        proxySignature: '',
        window: null,
        stopRequested: false,
        runVersion: 0,
        runPromise: null,
        snapshot: {
          accountAlias: input.accountAlias,
          address: input.address,
          state: 'idle',
          message: 'Готов к запуску',
          wave: 0,
          updatedAt: Date.now(),
        },
      };
      this.states.set(key, state);
    }
    state.proxy = input.proxy;
    state.snapshot.accountAlias = input.accountAlias;
    state.snapshot.address = input.address;
    return state;
  }

  update(state, patch) {
    Object.assign(state.snapshot, patch, { updatedAt: Date.now() });
  }

  async configureProxy(state, proxy) {
    const signature = proxySignature(proxy);
    if (state.proxySignature === signature) return;
    const scheme = proxy.type === 'socks5' ? 'socks5' : proxy.type;
    await state.browserSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: `${scheme}://${hostForProxy(proxy.host)}:${proxy.port}`,
    });
    state.proxySignature = signature;
  }

  async seedCookies(input, state) {
    const origin = new URL(input.hubUrl).origin;
    for (const header of input.session.cookies || []) {
      const parsed = parseSetCookie(header);
      if (!parsed) continue;
      try {
        await state.browserSession.cookies.set({ url: origin, ...parsed });
      } catch {
        // The Zustand auth state is authoritative; cookies are optional hints.
      }
    }
  }

  async injectAuthState(input, window) {
    const serializedState = JSON.stringify(input.session.state);
    const moduleId = Number(input.authStoreModuleId);
    return await window.webContents.executeJavaScript(
      `(() => {
        let assigned = false;
        try {
          const chunks = self.webpackChunk_N_E = self.webpackChunk_N_E || [];
          chunks.push([["abstract-hub-auth-" + Date.now()], {}, (require) => {
            try {
              const store = require(${moduleId})?.t;
              if (store?.getState()?.assign) {
                store.getState().assign(${serializedState});
                assigned = store.getState().state?.payload?.address?.toLowerCase() === ${JSON.stringify(
                  input.address.toLowerCase(),
                )};
              }
            } catch {}
          }]);
        } catch {}
        return assigned;
      })()`,
      true,
    );
  }

  async canvasRect(window) {
    return await window.webContents.executeJavaScript(
      `(() => {
        const canvas = [...document.querySelectorAll('canvas')]
          .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        if (rect.width < 320 || rect.height < 240) return null;
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()`,
      true,
    );
  }

  click(window, rect, xRatio, yRatio) {
    if (!rect || window.isDestroyed()) return;
    const x = Math.round(rect.x + rect.width * xRatio);
    const y = Math.round(rect.y + rect.height * yRatio);
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  tapKey(window, keyCode) {
    if (window.isDestroyed()) return;
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    setTimeout(() => {
      if (!window.isDestroyed()) window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    }, 140);
  }

  holdKeys(window, keys, duration = 1_900) {
    if (window.isDestroyed()) return;
    for (const keyCode of keys) window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    setTimeout(() => {
      if (window.isDestroyed()) return;
      for (const keyCode of keys) window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    }, duration);
  }

  async startNetworkMonitor(state, window) {
    const debug = window.webContents.debugger;
    try {
      debug.attach('1.3');
      await debug.sendCommand('Network.enable');
    } catch (error) {
      throw new Error(`Не удалось включить контроль Tollan: ${error.message || error}`, {
        cause: error,
      });
    }

    const tracked = new Map();
    const processResponse = async (requestId, trackedResponse) => {
      const { url, status } = trackedResponse;
      try {
        const response = await debug.sendCommand('Network.getResponseBody', { requestId });
        const body = JSON.parse(response.body || '{}');
        if (status === 401 || /unauthorized/i.test(String(body?.message || body?.error || ''))) {
          throw new Error('Tollan-сессия истекла. Переподключите аккаунт один раз.');
        }
        if (url.endsWith('/practice-start') && body?.success) {
          this.update(state, {
            state: 'playing',
            message: 'Забег идёт автоматически',
            sessionId: String(body.sessionId || ''),
            wave: 1,
          });
        } else if (url.endsWith('/wave-started')) {
          const wave = Math.max(1, Number(state.snapshot.wave || 0) + 1);
          this.update(state, { state: 'playing', wave, message: `Волна ${wave}` });
        } else if (url.endsWith('/practice-score')) {
          if (body?.success) {
            this.update(state, {
              state: 'completed',
              message: 'Награда подтверждена Tollan',
              reward: rewardSummary(body),
              completedAt: Date.now(),
            });
          } else {
            throw new Error(body?.message || body?.error || 'Tollan не подтвердил результат');
          }
        }
      } catch (error) {
        if (url.endsWith('/practice-score') || /сессия истекла/i.test(String(error?.message))) {
          this.update(state, {
            state: 'failed',
            message: url.endsWith('/practice-score')
              ? 'Tollan не подтвердил награду'
              : 'Нужно переподключить Tollan',
            error: error.message || String(error),
            completedAt: Date.now(),
          });
        }
      }
    };
    const handleMessage = (_event, method, params) => {
      if (method === 'Network.responseReceived') {
        const url = params?.response?.url || '';
        if (/\/api\/client\/(practice-start|wave-started|practice-score)$/.test(url)) {
          tracked.set(params.requestId, { url, status: Number(params.response.status || 0) });
        }
        return;
      }
      if (method === 'Network.loadingFinished') {
        const response = tracked.get(params?.requestId);
        if (!response) return;
        tracked.delete(params.requestId);
        void processResponse(params.requestId, response);
      }
      if (method === 'Network.loadingFailed') tracked.delete(params?.requestId);
    };
    debug.on('message', handleMessage);
    return () => {
      debug.removeListener('message', handleMessage);
      try {
        if (debug.isAttached()) debug.detach();
      } catch {
        // The debugger can already be detached when Electron closes the hidden window.
      }
    };
  }

  async waitForCanvas(input, state, window) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < LOAD_TIMEOUT_MS) {
      if (state.stopRequested) throw new Error('Остановлено пользователем');
      if (window.isDestroyed()) throw new Error('Игровое окно Tollan было закрыто');
      await this.injectAuthState(input, window);
      const rect = await this.canvasRect(window);
      if (rect) return rect;
      await delay(1_000);
    }
    throw new Error('Tollan не загрузил игровой экран за 2 минуты');
  }

  async waitForPracticeLink(input, state, window) {
    const startedAt = Date.now();
    const expectedPath = new URL(input.practicePath, input.hubUrl).pathname;
    let authInjected = false;
    while (Date.now() - startedAt < LAUNCHER_TIMEOUT_MS) {
      if (state.stopRequested) throw new Error('Остановлено пользователем');
      if (window.isDestroyed()) throw new Error('Лаунчер Tollan был закрыт');
      authInjected = (await this.injectAuthState(input, window)) || authInjected;
      const result = await window.webContents.executeJavaScript(
        `(() => {
          const expectedPath = ${JSON.stringify(expectedPath)};
          const link = [...document.querySelectorAll('a[href]')].find((candidate) => {
            try { return new URL(candidate.href, location.href).pathname === expectedPath; }
            catch { return false; }
          });
          if (!link) return null;
          return { href: link.href, text: (link.textContent || '').trim() };
        })()`,
        true,
      );
      if (result?.href) return result;
      await delay(750);
    }
    if (!authInjected) {
      throw new Error('Tollan не принял сохранённый вход. Переподключите Tollan в Аккаунтах.');
    }
    throw new Error('Tollan не показал кнопку Practice. Официальный лаунчер мог измениться.');
  }

  async openPractice(input, state, launcherWindow) {
    this.update(state, { state: 'loading', message: 'Открываем Practice' });
    const expectedOrigin = new URL(input.hubUrl).origin;
    const expectedPath = new URL(input.practicePath, input.hubUrl).pathname;
    let resolvePopup;
    let rejectPopup;
    const popup = new Promise((resolve, reject) => {
      resolvePopup = resolve;
      rejectPopup = reject;
    });
    const popupTimer = setTimeout(
      () => rejectPopup(new Error('Tollan не открыл игровую вкладку Practice')),
      PRACTICE_WINDOW_TIMEOUT_MS,
    );

    launcherWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url, input.hubUrl);
        if (target.origin !== expectedOrigin || target.pathname !== expectedPath) {
          return { action: 'deny' };
        }
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            title: `Tollan Practice · ${input.accountAlias}`,
            width: 1280,
            height: 720,
            show: process.env.TOLLAN_SHOW_WINDOW === '1',
            backgroundColor: '#111714',
            autoHideMenuBar: true,
            webPreferences: {
              partition: state.partition,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              backgroundThrottling: false,
            },
          },
        };
      } catch {
        return { action: 'deny' };
      }
    });
    launcherWindow.webContents.once('did-create-window', (gameWindow) => {
      clearTimeout(popupTimer);
      gameWindow.setMenu(null);
      gameWindow.webContents.setAudioMuted(true);
      resolvePopup(gameWindow);
    });

    try {
      await this.waitForPracticeLink(input, state, launcherWindow);
      await launcherWindow.webContents.executeJavaScript(
        `(() => {
          const expectedPath = ${JSON.stringify(expectedPath)};
          const link = [...document.querySelectorAll('a[href]')].find((candidate) => {
            try { return new URL(candidate.href, location.href).pathname === expectedPath; }
            catch { return false; }
          });
          if (!link) return false;
          link.click();
          return true;
        })()`,
        true,
      );
      return await popup;
    } finally {
      clearTimeout(popupTimer);
    }
  }

  async enterPractice(state, window, rect) {
    const startedAt = Date.now();
    this.update(state, { state: 'starting', message: 'Запускаем Practice' });
    while (Date.now() - startedAt < 90_000 && state.snapshot.state !== 'playing') {
      if (state.stopRequested) throw new Error('Остановлено пользователем');
      // Close campaign/pass overlays, press Play, choose Monk, then Start.
      this.click(window, rect, 0.69, 0.045);
      await delay(250);
      this.click(window, rect, 0.22, 0.42);
      await delay(750);
      this.click(window, rect, 0.23, 0.53);
      await delay(250);
      this.click(window, rect, 0.82, 0.86);
      await delay(2_500);
    }
    if (state.snapshot.state !== 'playing') {
      throw new Error('Tollan не подтвердил запуск Practice');
    }
  }

  async playUntilComplete(state, window, rect) {
    const directions = [
      ['W', 'D'],
      ['S', 'D'],
      ['S', 'A'],
      ['W', 'A'],
    ];
    let directionIndex = 0;
    const movement = setInterval(() => {
      if (state.snapshot.state !== 'playing') return;
      this.holdKeys(window, directions[directionIndex % directions.length]);
      directionIndex++;
      this.tapKey(window, 'Space');
    }, INPUT_INTERVAL_MS);
    const assist = setInterval(() => {
      if (state.snapshot.state !== 'playing') return;
      // Upgrade cards and blocking ritual/item prompts. Clicks are inert in combat.
      this.click(window, rect, 0.5, 0.5);
      this.click(window, rect, 0.43, 0.91);
      this.click(window, rect, 0.25, 0.72);
    }, ASSIST_INTERVAL_MS);

    try {
      const startedAt = Date.now();
      while (
        state.snapshot.state === 'playing' &&
        Date.now() - startedAt < RUN_TIMEOUT_MS &&
        !state.stopRequested
      ) {
        await delay(1_000);
      }
      if (state.stopRequested) throw new Error('Остановлено пользователем');
      if (state.snapshot.state === 'playing') {
        throw new Error('Practice не завершился за 30 минут');
      }
    } finally {
      clearInterval(movement);
      clearInterval(assist);
      for (const keyCode of ['W', 'A', 'S', 'D', 'Space']) {
        if (!window.isDestroyed()) window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      }
    }
  }

  async run(input, state) {
    state.stopRequested = false;
    this.update(state, {
      state: 'loading',
      message: 'Загружаем официальный клиент Tollan',
      wave: 0,
      startedAt: Date.now(),
      completedAt: undefined,
      sessionId: undefined,
      reward: undefined,
      error: undefined,
    });
    await this.configureProxy(state, input.proxy);
    await this.seedCookies(input, state);

    const launcherWindow = new this.BrowserWindow({
      title: `Tollan · ${input.accountAlias}`,
      width: 1280,
      height: 720,
      show: process.env.TOLLAN_SHOW_WINDOW === '1',
      backgroundColor: '#111714',
      autoHideMenuBar: true,
      webPreferences: {
        partition: state.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    state.window = launcherWindow;
    state.launcherWindow = launcherWindow;
    launcherWindow.setMenu(null);
    launcherWindow.webContents.setAudioMuted(true);
    let gameWindow;
    let stopMonitor = () => undefined;

    try {
      this.update(state, { state: 'loading', message: 'Входим в Tollan' });
      await launcherWindow.loadURL(input.hubUrl);
      gameWindow = await this.openPractice(input, state, launcherWindow);
      state.window = gameWindow;
      stopMonitor = await this.startNetworkMonitor(state, gameWindow);
      this.update(state, { state: 'loading', message: 'Загружаем игру' });
      const rect = await this.waitForCanvas(input, state, gameWindow);
      if (!launcherWindow.isDestroyed()) launcherWindow.destroy();
      await this.enterPractice(state, gameWindow, rect);
      await this.playUntilComplete(state, gameWindow, rect);
    } catch (error) {
      if (state.snapshot.state !== 'completed') {
        const stopped = state.stopRequested || /остановлено/i.test(String(error?.message || error));
        this.update(state, {
          state: stopped ? 'stopped' : 'failed',
          message: stopped ? 'Остановлено' : 'Забег остановлен',
          error: stopped ? undefined : error.message || String(error),
          completedAt: Date.now(),
        });
      }
    } finally {
      stopMonitor();
      if (gameWindow && !gameWindow.isDestroyed()) gameWindow.destroy();
      if (!launcherWindow.isDestroyed()) launcherWindow.destroy();
      if (state.window === gameWindow || state.window === launcherWindow) state.window = null;
      if (state.launcherWindow === launcherWindow) state.launcherWindow = null;
      state.runPromise = null;
    }
  }

  async start(input) {
    const state = this.stateFor(input);
    if (state.runPromise) return snapshotCopy(state.snapshot);
    const runVersion = ++state.runVersion;
    this.update(state, { state: 'queued', message: 'В очереди на запуск', wave: 0 });
    const operation = this.queue.then(async () => {
      if (state.runVersion !== runVersion) return;
      await this.run(input, state);
    });
    this.queue = operation.catch(() => undefined);
    state.runPromise = operation;
    void operation.finally(() => {
      if (state.runPromise === operation) state.runPromise = null;
    });
    return snapshotCopy(state.snapshot);
  }

  async stop(sessionKey) {
    const targetKey = sessionKey ? safePartitionKey(sessionKey) : null;
    for (const state of this.states.values()) {
      if (targetKey && state.key !== targetKey) continue;
      state.stopRequested = true;
      state.runVersion++;
      if (state.window && !state.window.isDestroyed()) state.window.destroy();
      if (state.launcherWindow && !state.launcherWindow.isDestroyed()) {
        state.launcherWindow.destroy();
      }
      if (state.snapshot.state === 'queued') {
        this.update(state, { state: 'stopped', message: 'Остановлено', completedAt: Date.now() });
      }
    }
    return await this.status(sessionKey);
  }

  async status(sessionKey) {
    const targetKey = sessionKey ? safePartitionKey(sessionKey) : null;
    return Array.from(this.states.values())
      .filter((state) => !targetKey || state.key === targetKey)
      .map((state) => snapshotCopy(state.snapshot));
  }

  dispose() {
    this.app.removeListener('login', this.handleLogin);
    for (const state of this.states.values()) {
      state.stopRequested = true;
      if (state.window && !state.window.isDestroyed()) state.window.destroy();
      if (state.launcherWindow && !state.launcherWindow.isDestroyed()) {
        state.launcherWindow.destroy();
      }
    }
    this.states.clear();
  }
}

function createTollanBrowserBridge(dependencies) {
  const manager = new TollanBrowserSessions(dependencies);
  return {
    bridge: {
      start: manager.start.bind(manager),
      stop: manager.stop.bind(manager),
      status: manager.status.bind(manager),
    },
    dispose: manager.dispose.bind(manager),
  };
}

module.exports = { TollanBrowserSessions, createTollanBrowserBridge };
