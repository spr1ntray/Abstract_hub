/* global module, setInterval, setTimeout, clearInterval, clearTimeout */

const { URL } = require('node:url');
const { answerProxyLogin } = require('./proxy-login.cjs');

const LOAD_TIMEOUT_MS = 2 * 60_000;
const PRACTICE_LINK_FALLBACK_MS = 15_000;
const PRACTICE_WINDOW_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 30 * 60_000;
const INPUT_INTERVAL_MS = 2_400;
const ASSIST_INTERVAL_MS = 3_200;
const PRACTICE_START_TIMEOUT_MS = 90_000;
const PRACTICE_REQUEST_GRACE_MS = 20_000;

function tollanPracticeStartPlan(cycle = 0) {
  const common = [
    { type: 'key', keyCode: 'Escape', waitMs: 350 },
    { type: 'click', xRatio: 0.69, yRatio: 0.045, waitMs: 100 },
    { type: 'click', xRatio: 0.95, yRatio: 0.055, waitMs: 250 },
  ];

  if (cycle % 2 === 0) {
    return [
      ...common,
      {
        type: 'click',
        xRatio: 0.226,
        yRatio: 0.42,
        waitMs: 1_200,
        message: 'Открываем меню Practice',
      },
      {
        type: 'click',
        xRatio: 0.412,
        yRatio: 0.716,
        waitMs: 350,
        message: 'Выбираем бесплатный множитель x1',
      },
      {
        type: 'click',
        xRatio: 0.5,
        yRatio: 0.882,
        waitMs: 4_500,
        message: 'Ждём подтверждение Tollan',
      },
    ];
  }

  // Unity's current navigation graph is deterministic: Main menu Down selects
  // PLAY; Preplay Right selects 1x; Down then selects START GAME.
  return [
    ...common,
    { type: 'key', keyCode: 'Down', waitMs: 180, message: 'Открываем меню Practice' },
    { type: 'key', keyCode: 'Enter', waitMs: 1_200 },
    { type: 'key', keyCode: 'Right', waitMs: 180, message: 'Выбираем бесплатный множитель x1' },
    { type: 'key', keyCode: 'Enter', waitMs: 350 },
    { type: 'key', keyCode: 'Down', waitMs: 180, message: 'Запускаем бесплатный Practice' },
    { type: 'key', keyCode: 'Enter', waitMs: 4_500, message: 'Ждём подтверждение Tollan' },
  ];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TRANSIENT_LOAD_ERROR_CODES = new Set([
  'ERR_NETWORK_CHANGED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_PROXY_CONNECTION_FAILED',
]);

function isTransientTollanLoadError(error) {
  const code = String(error?.code || error?.errno || '').toUpperCase();
  const message = String(error?.message || error || '').toUpperCase();
  return (
    TRANSIENT_LOAD_ERROR_CODES.has(code) ||
    [...TRANSIENT_LOAD_ERROR_CODES].some((candidate) => message.includes(candidate)) ||
    [-21, -101, -118, -7, -106, -109, -130].includes(Number(error?.errno))
  );
}

function tollanClientEndpoint(value) {
  try {
    const path = new URL(String(value)).pathname.replace(/\/+$/, '');
    const match = /\/api\/client\/(practice-start|wave-started|practice-score)$/.exec(path);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function successfulTollanResponse(status, body) {
  return status >= 200 && status < 300 && body?.success !== false;
}

async function readTollanResponseBody(debug, requestId, status) {
  if (status === 204 || status === 205) return {};
  try {
    const response = await debug.sendCommand('Network.getResponseBody', { requestId });
    if (!response?.body) return {};
    try {
      return JSON.parse(response.body);
    } catch {
      return { raw: String(response.body).slice(0, 2_000) };
    }
  } catch {
    // Chromium legitimately has no response body for some successful 2xx calls.
    // The HTTP status remains authoritative for those endpoints.
    return {};
  }
}

function safePartitionKey(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .slice(0, 80) || 'account'
  );
}

function diagnosticUrl(value) {
  try {
    const url = new URL(String(value));
    return {
      origin: url.origin,
      path: url.pathname,
      queryKeys: [...url.searchParams.keys()],
    };
  } catch {
    return { path: String(value || '').slice(0, 500) };
  }
}

function currentWindowUrl(window) {
  try {
    return diagnosticUrl(window?.webContents?.getURL?.() || '');
  } catch {
    return { path: '' };
  }
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
  constructor({ app, BrowserWindow, session, diagnostics }) {
    this.app = app;
    this.BrowserWindow = BrowserWindow;
    this.session = session;
    this.diagnostics = diagnostics;
    this.states = new Map();
    this.queue = Promise.resolve();
    this.handleLogin = (event, webContents, _details, authInfo, callback) => {
      answerProxyLogin(this.states, event, webContents, authInfo, callback);
    };
    this.app.on('login', this.handleLogin);
    this.diagnostics?.record('tollan', 'runner_initialized');
  }

  trace(state, event, data = {}) {
    this.diagnostics?.record('tollan', event, {
      ...(state
        ? {
            accountAlias: state.snapshot?.accountAlias,
            address: state.snapshot?.address,
            runState: state.snapshot?.state,
          }
        : {}),
      ...data,
    });
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
        practiceStartRequestedAt: 0,
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
    const previousState = state.snapshot.state;
    const previousMessage = state.snapshot.message;
    Object.assign(state.snapshot, patch, { updatedAt: Date.now() });
    if (state.snapshot.state !== previousState || state.snapshot.message !== previousMessage) {
      this.trace(state, 'state_changed', {
        previousState,
        state: state.snapshot.state,
        message: state.snapshot.message,
        ...(state.snapshot.error ? { error: state.snapshot.error } : {}),
      });
    }
  }

  wireWindowDiagnostics(state, window, role) {
    if (!this.diagnostics) return;
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      this.trace(state, 'window_load_failed', {
        role,
        code,
        description,
        url: diagnosticUrl(url),
        isMainFrame,
      });
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      this.trace(state, 'window_process_gone', { role, details });
    });
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      this.trace(state, 'window_console', {
        role,
        level,
        message,
        line,
        source: diagnosticUrl(sourceId),
      });
    });
    window.on('unresponsive', () => this.trace(state, 'window_unresponsive', { role }));
  }

  async captureFailure(state, window, label = 'failure') {
    if (!this.diagnostics?.status?.().enabled || !window || window.isDestroyed()) return;
    try {
      const image = await window.webContents.capturePage();
      this.diagnostics.saveImage?.(
        'tollan',
        `${state.snapshot.accountAlias}-${label}`,
        image.toPNG(),
      );
    } catch (error) {
      this.trace(state, 'screenshot_failed', { error });
    }
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
    this.trace(state, 'proxy_configured', { type: proxy.type, host: proxy.host, port: proxy.port });
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

  async loadUrlWithRetries(state, window, url, retryDelays = [1_000, 2_000, 4_000]) {
    let lastError;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      if (state.stopRequested) throw new Error('Остановлено пользователем');
      if (window.isDestroyed()) throw new Error('Окно Tollan было закрыто');
      try {
        await window.loadURL(url);
        this.trace(state, 'page_loaded', { url: diagnosticUrl(url), attempt: attempt + 1 });
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientTollanLoadError(error) || attempt >= retryDelays.length) throw error;
        this.update(state, {
          state: 'loading',
          message: `Сеть изменилась. Повторяем загрузку Tollan (${attempt + 1}/${retryDelays.length})`,
        });
        this.trace(state, 'page_load_retry', {
          url: diagnosticUrl(url),
          attempt: attempt + 1,
          error,
        });
        await delay(retryDelays[attempt]);
      }
    }
    throw lastError;
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
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
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

    const requested = new Map();
    const tracked = new Map();
    const processResponse = async (requestId, trackedResponse) => {
      const { endpoint, status } = trackedResponse;
      const body = await readTollanResponseBody(debug, requestId, status);
      requested.delete(requestId);
      if (endpoint === 'practice-start') state.practiceStartRequestedAt = 0;
      this.trace(state, 'practice_response', {
        endpoint,
        status,
        body,
      });
      try {
        if (status === 401 || /unauthorized/i.test(String(body?.message || body?.error || ''))) {
          throw new Error('Tollan-сессия истекла. Переподключите аккаунт один раз.');
        }
        if (endpoint === 'practice-start' && successfulTollanResponse(status, body)) {
          this.update(state, {
            state: 'playing',
            message: 'Забег идёт автоматически',
            sessionId: String(body.sessionId || body.practiceModeUserGameSessionId || ''),
            wave: 1,
          });
        } else if (endpoint === 'practice-start') {
          const message = String(body?.message || body?.error || `HTTP ${status}`);
          if (status === 408 || status === 429 || status >= 500) {
            this.update(state, {
              state: 'starting',
              message: 'Tollan временно не ответил. Повторяем запуск',
            });
          } else {
            throw new Error(message);
          }
        } else if (endpoint === 'wave-started' && successfulTollanResponse(status, body)) {
          const wave = Math.max(1, Number(state.snapshot.wave || 0) + 1);
          this.update(state, { state: 'playing', wave, message: `Волна ${wave}` });
        } else if (endpoint === 'practice-score') {
          if (successfulTollanResponse(status, body)) {
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
        if (
          endpoint === 'practice-start' ||
          endpoint === 'practice-score' ||
          /сессия истекла/i.test(String(error?.message))
        ) {
          this.update(state, {
            state: 'failed',
            message:
              endpoint === 'practice-start'
                ? 'Tollan отклонил запуск Practice'
                : endpoint === 'practice-score'
                  ? 'Tollan не подтвердил награду'
                  : 'Нужно переподключить Tollan',
            error: error.message || String(error),
            completedAt: Date.now(),
          });
        }
      }
    };
    const handleMessage = (_event, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const url = params?.request?.url || '';
        const endpoint = tollanClientEndpoint(url);
        if (!endpoint) return;
        requested.set(params.requestId, endpoint);
        this.trace(state, 'practice_request', {
          endpoint,
          method: params?.request?.method,
          url: diagnosticUrl(url),
        });
        if (endpoint === 'practice-start') {
          state.practiceStartRequestedAt = Date.now();
          this.update(state, {
            state: 'starting',
            message: 'Tollan принял запуск. Ждём подтверждение',
          });
        }
        return;
      }
      if (method === 'Network.responseReceived') {
        const url = params?.response?.url || '';
        const endpoint = tollanClientEndpoint(url);
        if (endpoint || ['Fetch', 'XHR'].includes(String(params?.type || ''))) {
          this.trace(state, 'network_response', {
            endpoint,
            status: Number(params?.response?.status || 0),
            type: params?.type,
            url: diagnosticUrl(url),
          });
        }
        if (endpoint) {
          const response = {
            endpoint,
            status: Number(params.response.status || 0),
          };
          if ([204, 205].includes(response.status))
            void processResponse(params.requestId, response);
          else tracked.set(params.requestId, response);
        }
        return;
      }
      if (method === 'Network.loadingFinished') {
        const response = tracked.get(params?.requestId);
        if (!response) return;
        tracked.delete(params.requestId);
        void processResponse(params.requestId, response);
      }
      if (method === 'Network.loadingFailed') {
        const endpoint = requested.get(params?.requestId);
        requested.delete(params?.requestId);
        tracked.delete(params?.requestId);
        if (endpoint === 'practice-start') {
          state.practiceStartRequestedAt = 0;
          this.update(state, {
            state: 'starting',
            message: 'Связь с Tollan прервалась. Повторяем запуск',
          });
        }
      }
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
      if (rect) {
        this.trace(state, 'canvas_ready', { rect, url: currentWindowUrl(window) });
        return rect;
      }
      await delay(1_000);
    }
    throw new Error('Tollan не загрузил игровой экран за 2 минуты');
  }

  async waitForPracticeLink(
    input,
    state,
    window,
    timeoutMs = PRACTICE_LINK_FALLBACK_MS,
    pollMs = 750,
  ) {
    const startedAt = Date.now();
    const expectedPath = new URL(input.practicePath, input.hubUrl).pathname;
    const expectedHref = new URL(input.practicePath, input.hubUrl).href;
    while (Date.now() - startedAt < timeoutMs) {
      if (state.stopRequested) throw new Error('Остановлено пользователем');
      if (window.isDestroyed()) throw new Error('Лаунчер Tollan был закрыт');
      try {
        await this.injectAuthState(input, window);
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const expectedPath = ${JSON.stringify(expectedPath)};
            const links = [...document.querySelectorAll('a[href]')];
            const link = links.find((candidate) => {
              try { return new URL(candidate.href, location.href).pathname === expectedPath; }
              catch { return false; }
            }) || links.find((candidate) => /\\bpractice\\b/i.test(candidate.textContent || ''));
            if (!link) return null;
            return { href: link.href, text: (link.textContent || '').trim(), direct: false };
          })()`,
          true,
        );
        if (result?.href) return result;
      } catch {
        // Next.js can replace the document while auth state is being restored.
      }
      await delay(pollMs);
    }
    return { href: expectedHref, text: 'Practice', direct: true };
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
      this.wireWindowDiagnostics(state, gameWindow, 'practice');
      this.trace(state, 'practice_window_created', {
        url: currentWindowUrl(gameWindow),
      });
      resolvePopup(gameWindow);
    });

    try {
      await this.waitForPracticeLink(input, state, launcherWindow);
      await launcherWindow.webContents.executeJavaScript(
        `(() => {
          const expectedPath = ${JSON.stringify(expectedPath)};
          const expectedHref = ${JSON.stringify(new URL(input.practicePath, input.hubUrl).href)};
          const links = [...document.querySelectorAll('a[href]')];
          const link = links.find((candidate) => {
            try { return new URL(candidate.href, location.href).pathname === expectedPath; }
            catch { return false; }
          }) || links.find((candidate) => /\\bpractice\\b/i.test(candidate.textContent || ''));
          if (link) {
            link.click();
            return 'link';
          }
          window.open(expectedHref, '_blank');
          return 'direct';
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
    let cycle = 0;
    this.update(state, { state: 'starting', message: 'Запускаем Practice' });
    while (
      Date.now() - startedAt < PRACTICE_START_TIMEOUT_MS &&
      state.snapshot.state !== 'playing'
    ) {
      if (state.stopRequested) throw new Error('Остановлено пользователем');
      if (state.snapshot.state === 'failed') {
        throw new Error(state.snapshot.error || 'Tollan отклонил запуск Practice');
      }
      if (state.practiceStartRequestedAt) {
        if (Date.now() - state.practiceStartRequestedAt < PRACTICE_REQUEST_GRACE_MS) {
          await delay(500);
          continue;
        }
        this.trace(state, 'practice_start_response_timeout', {
          elapsedMs: Date.now() - state.practiceStartRequestedAt,
        });
        state.practiceStartRequestedAt = 0;
      }
      try {
        window.webContents.focus();
      } catch {
        // A hidden Electron window can already own focus in off-screen mode.
      }
      const plan = tollanPracticeStartPlan(cycle);
      for (const action of plan) {
        if (state.snapshot.state === 'playing' || state.practiceStartRequestedAt) break;
        if (action.message) {
          this.update(state, { state: 'starting', message: action.message });
        }
        if (action.type === 'click') {
          this.click(window, rect, action.xRatio, action.yRatio);
        } else {
          this.tapKey(window, action.keyCode);
        }
        await delay(action.waitMs);
      }
      cycle++;
      if (cycle === 1 || cycle % 4 === 0) {
        this.trace(state, 'practice_start_attempt', {
          cycle,
          elapsedMs: Date.now() - startedAt,
          url: currentWindowUrl(window),
        });
      }
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
    state.practiceStartRequestedAt = 0;
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
    this.wireWindowDiagnostics(state, launcherWindow, 'launcher');
    let gameWindow;
    let stopMonitor = () => undefined;

    try {
      this.update(state, { state: 'loading', message: 'Входим в Tollan' });
      await this.loadUrlWithRetries(state, launcherWindow, input.hubUrl);
      gameWindow = await this.openPractice(input, state, launcherWindow);
      state.window = gameWindow;
      stopMonitor = await this.startNetworkMonitor(state, gameWindow);
      this.update(state, { state: 'loading', message: 'Загружаем игру' });
      const rect = await this.waitForCanvas(input, state, gameWindow);
      if (!launcherWindow.isDestroyed()) launcherWindow.destroy();
      await this.enterPractice(state, gameWindow, rect);
      await this.playUntilComplete(state, gameWindow, rect);
    } catch (error) {
      await this.captureFailure(state, gameWindow || launcherWindow, 'run-failed');
      this.trace(state, 'run_failed', { error });
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
      state.practiceStartRequestedAt = 0;
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

module.exports = {
  TollanBrowserSessions,
  createTollanBrowserBridge,
  isTransientTollanLoadError,
  successfulTollanResponse,
  tollanClientEndpoint,
  readTollanResponseBody,
  tollanPracticeStartPlan,
};
