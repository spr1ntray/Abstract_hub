/* global AbortController, AbortSignal, WebSocket, clearTimeout, fetch, module, setTimeout */

const { spawn } = require('node:child_process');
const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { homedir, platform } = require('node:os');
const { basename, join } = require('node:path');
const { URL } = require('node:url');
const { answerProxyLogin } = require('./proxy-login.cjs');

const AUTH_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 900;
const REQUEST_TIMEOUT_MS = 25_000;
const PROBE_TIMEOUT_MS = 8_000;
const DEVTOOLS_TIMEOUT_MS = 20_000;
const DEVTOOLS_COMMAND_TIMEOUT_MS = 15_000;
const PROFILE_SEED_VERSION = 1;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
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

function hostForProxy(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function proxySignature(proxy) {
  return `${proxy.type}:${proxy.host}:${proxy.port}:${proxy.username || ''}`;
}

function browserCandidates() {
  if (platform() === 'darwin') {
    return [
      {
        name: 'Google Chrome',
        executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        userDataDir: join(homedir(), 'Library/Application Support/Google/Chrome'),
      },
      {
        name: 'Comet',
        executable: '/Applications/Comet.app/Contents/MacOS/Comet',
        userDataDir: join(homedir(), 'Library/Application Support/Comet'),
      },
      {
        name: 'Microsoft Edge',
        executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        userDataDir: join(homedir(), 'Library/Application Support/Microsoft Edge'),
      },
      {
        name: 'Brave',
        executable: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        userDataDir: join(homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser'),
      },
      {
        name: 'Google Chrome',
        executable: join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        userDataDir: join(homedir(), 'Library/Application Support/Google/Chrome'),
      },
      {
        name: 'Comet',
        executable: join(homedir(), 'Applications/Comet.app/Contents/MacOS/Comet'),
        userDataDir: join(homedir(), 'Library/Application Support/Comet'),
      },
      {
        name: 'Microsoft Edge',
        executable: join(
          homedir(),
          'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ),
        userDataDir: join(homedir(), 'Library/Application Support/Microsoft Edge'),
      },
      {
        name: 'Brave',
        executable: join(homedir(), 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
        userDataDir: join(homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser'),
      },
    ];
  }
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    const roots = [local, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(
      Boolean,
    );
    return roots.flatMap((root) => [
      {
        name: 'Google Chrome',
        executable: join(root, 'Google/Chrome/Application/chrome.exe'),
        userDataDir: join(local, 'Google/Chrome/User Data'),
      },
      {
        name: 'Microsoft Edge',
        executable: join(root, 'Microsoft/Edge/Application/msedge.exe'),
        userDataDir: join(local, 'Microsoft/Edge/User Data'),
      },
      {
        name: 'Brave',
        executable: join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
        userDataDir: join(local, 'BraveSoftware/Brave-Browser/User Data'),
      },
    ]);
  }
  return [
    {
      name: 'Google Chrome',
      executable: '/usr/bin/google-chrome',
      userDataDir: join(homedir(), '.config/google-chrome'),
    },
    {
      name: 'Google Chrome',
      executable: '/usr/bin/google-chrome-stable',
      userDataDir: join(homedir(), '.config/google-chrome'),
    },
    {
      name: 'Microsoft Edge',
      executable: '/usr/bin/microsoft-edge',
      userDataDir: join(homedir(), '.config/microsoft-edge'),
    },
    {
      name: 'Microsoft Edge',
      executable: '/usr/bin/microsoft-edge-stable',
      userDataDir: join(homedir(), '.config/microsoft-edge'),
    },
    {
      name: 'Brave',
      executable: '/usr/bin/brave-browser',
      userDataDir: join(homedir(), '.config/BraveSoftware/Brave-Browser'),
    },
    {
      name: 'Chromium',
      executable: '/usr/bin/chromium',
      userDataDir: join(homedir(), '.config/chromium'),
    },
    {
      name: 'Chromium',
      executable: '/usr/bin/chromium-browser',
      userDataDir: join(homedir(), '.config/chromium'),
    },
  ];
}

function profileActivity(candidate) {
  try {
    return statSync(join(candidate.userDataDir, 'Local State')).mtimeMs;
  } catch {
    return 0;
  }
}

function findExternalBrowser(candidates = browserCandidates()) {
  return candidates
    .filter((candidate) => existsSync(candidate.executable))
    .sort((left, right) => profileActivity(right) - profileActivity(left))[0];
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function sourceProfileName(userDataDir) {
  const localState = readJson(join(userDataDir, 'Local State'));
  const names = [
    localState?.profile?.last_used,
    ...(Array.isArray(localState?.profile?.last_active_profiles)
      ? localState.profile.last_active_profiles
      : []),
    'Default',
  ];
  return names.find(
    (name) =>
      typeof name === 'string' &&
      !name.includes('/') &&
      !name.includes('\\') &&
      existsSync(join(userDataDir, name)),
  );
}

function copyProfileEntry(source, destination) {
  if (!existsSync(source)) return;
  cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: (entry) => {
      const name = basename(entry);
      return name !== 'LOCK' && !name.startsWith('Singleton') && name !== 'DevToolsActivePort';
    },
  });
}

function normalizeManagedPreferences(profileDir) {
  const preferencesPath = join(profileDir, 'Preferences');
  const preferences = readJson(preferencesPath);
  if (!preferences || typeof preferences !== 'object') return;
  preferences.profile = {
    ...(preferences.profile || {}),
    exit_type: 'Normal',
    exited_cleanly: true,
  };
  preferences.session = {
    ...(preferences.session || {}),
    restore_on_startup: 5,
    startup_urls: [],
  };
  writeFileSync(preferencesPath, JSON.stringify(preferences), { mode: 0o600 });
}

function seedExternalProfile(browser, targetRoot) {
  const markerPath = join(targetRoot, '.abstract-hub-profile.json');
  const existing = readJson(markerPath);
  if (
    existing?.version === PROFILE_SEED_VERSION &&
    existing.seeded === true &&
    typeof existing.profileName === 'string' &&
    existsSync(join(targetRoot, existing.profileName))
  ) {
    return { profileName: existing.profileName, seeded: true };
  }

  const profileName = sourceProfileName(browser.userDataDir) || 'Default';
  const sourceProfile = join(browser.userDataDir, profileName);
  const seeded = existsSync(sourceProfile);
  const targetProfile = join(targetRoot, profileName);
  mkdirSync(targetProfile, { recursive: true });

  copyProfileEntry(join(browser.userDataDir, 'Local State'), join(targetRoot, 'Local State'));
  for (const name of [
    'Cookies',
    'Cookies-journal',
    'Cookies-shm',
    'Cookies-wal',
    'Preferences',
    'Secure Preferences',
    'Local Storage',
    'Session Storage',
    'WebStorage',
  ]) {
    copyProfileEntry(join(sourceProfile, name), join(targetProfile, name));
  }
  normalizeManagedPreferences(targetProfile);

  const indexedDbSource = join(sourceProfile, 'IndexedDB');
  if (existsSync(indexedDbSource)) {
    mkdirSync(join(targetProfile, 'IndexedDB'), { recursive: true });
    for (const name of readdirSync(indexedDbSource)) {
      if (!/(cambria\.gg|abs\.xyz|privy\.io)/i.test(name)) continue;
      copyProfileEntry(join(indexedDbSource, name), join(targetProfile, 'IndexedDB', name));
    }
  }

  writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        version: PROFILE_SEED_VERSION,
        browser: browser.name,
        source: browser.userDataDir,
        profileName,
        seeded,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { profileName, seeded };
}

function proxyRule(proxy) {
  const scheme = proxy.type === 'socks5' ? 'socks5' : proxy.type;
  return `${scheme}://${hostForProxy(proxy.host)}:${proxy.port}`;
}

function electronSameSite(value) {
  if (value === 'Strict') return 'strict';
  if (value === 'Lax') return 'lax';
  if (value === 'None') return 'no_restriction';
  return undefined;
}

function collectWalletAddresses(value, addresses = new Set()) {
  if (typeof value === 'string') {
    if (/^0x[a-f0-9]{40}$/i.test(value)) addresses.add(value.toLowerCase());
    return addresses;
  }
  if (!value || typeof value !== 'object') return addresses;
  if (Array.isArray(value)) {
    for (const entry of value) collectWalletAddresses(entry, addresses);
    return addresses;
  }
  for (const entry of Object.values(value)) collectWalletAddresses(entry, addresses);
  return addresses;
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = () => undefined;
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('Chrome DevTools недоступен')), {
        once: true,
      });
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(new Error(message.error.message || 'Ошибка Chrome DevTools'));
        else pending.resolve(message.result || {});
        return;
      }
      this.onEvent(message);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Браузер Cambria был закрыт'));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools не ответил на ${method}`));
      }, DEVTOOLS_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // The browser can close the DevTools socket first.
    }
  }
}

function cookieDomain(url) {
  const hostname = new URL(url).hostname;
  const labels = hostname.split('.');
  return labels.length >= 2 ? `.${labels.slice(-2).join('.')}` : hostname;
}

function loginRequired(message) {
  const error = new Error(message);
  error.code = 'CAMBRIA_LOGIN_REQUIRED';
  return error;
}

function browserRequestHeaders(request) {
  const source = request.headers || {};
  return {
    accept: source.accept || 'application/json',
    ...(source.origin ? { origin: source.origin } : {}),
    ...(source['x-privy-token'] ? { 'x-privy-token': source['x-privy-token'] } : {}),
    ...(request.body !== undefined
      ? { 'content-type': source['content-type'] || 'application/json' }
      : {}),
  };
}

class CambriaBrowserSessions {
  constructor({ app, session }) {
    this.app = app;
    this.session = session;
    this.states = new Map();
    this.pending = new Map();
    this.authQueue = Promise.resolve();
    this.handleLogin = (event, webContents, _details, authInfo, callback) => {
      answerProxyLogin(this.states, event, webContents, authInfo, callback);
    };
    this.app.on('login', this.handleLogin);
  }

  stateFor(input) {
    const key = safePartitionKey(input.sessionKey || input.address);
    let state = this.states.get(key);
    if (!state) {
      const partition = `persist:abstract-hub-cambria-${key}`;
      state = {
        key,
        partition,
        browserSession: this.session.fromPartition(partition),
        proxy: input.proxy,
        proxySignature: '',
        externalProcess: null,
        devtools: null,
      };
      this.states.set(key, state);
    }
    state.proxy = input.proxy;
    return state;
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

  async fetch(state, request, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await state.browserSession.fetch(request.url, {
        method: request.method,
        headers: browserRequestHeaders(request),
        credentials: 'include',
        signal: controller.signal,
        ...(request.body !== undefined ? { body: request.body } : {}),
      });
      const body = parseBody(await response.text());
      return {
        status: response.status,
        body,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Cambria не ответила вовремя (${Math.ceil(timeoutMs / 1000)}с)`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(input, state) {
    try {
      const response = await this.fetch(
        state,
        {
          url: `${input.apiBase}/user/current`,
          method: 'GET',
          headers: { accept: 'application/json' },
        },
        PROBE_TIMEOUT_MS,
      );
      // 404 means an authenticated wallet still needs onboarding. 429 keeps the
      // existing session in cooldown. A 401 is never a usable Cambria session.
      return response.status === 200 || response.status === 404 || response.status === 429;
    } catch {
      return false;
    }
  }

  async isReady(input) {
    const state = this.stateFor(input);
    await this.configureProxy(state, input.proxy);
    return await this.probe(input, state);
  }

  async seedCookies(input, state) {
    if (!input.seed) return;
    const domain = cookieDomain(input.lobbyUrl);
    for (const cookie of input.seed.cookies) {
      if (!cookie?.name || !/privy/i.test(cookie.name) || typeof cookie.value !== 'string')
        continue;
      await state.browserSession.cookies.set({
        url: input.lobbyUrl,
        domain,
        path: '/',
        name: cookie.name,
        value: cookie.value,
        secure: true,
        sameSite: 'no_restriction',
      });
    }
  }

  async waitForDevtools(profileDir, child) {
    const portFile = join(profileDir, 'DevToolsActivePort');
    const startedAt = Date.now();
    while (Date.now() - startedAt < DEVTOOLS_TIMEOUT_MS) {
      if (existsSync(portFile)) {
        const [portLine] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        const port = Number(portLine);
        if (Number.isInteger(port) && port > 0) return port;
      }
      if (child.exitCode !== null && Date.now() - startedAt > 3_000) break;
      await delay(200);
    }
    throw loginRequired('Не удалось запустить внешний браузер для Cambria');
  }

  async waitForPageTarget(port, preferredUrl = 'about:blank') {
    const startedAt = Date.now();
    while (Date.now() - startedAt < DEVTOOLS_TIMEOUT_MS) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(2_000),
        });
        const targets = await response.json();
        const pages = Array.isArray(targets)
          ? targets.filter((target) => target?.type === 'page' && target.webSocketDebuggerUrl)
          : [];
        const page = pages.find((target) => target.url === preferredUrl) || pages[0];
        if (page) return page;
      } catch {
        // Chromium can publish the port before its first page target is ready.
      }
      await delay(200);
    }
    throw loginRequired('Внешний браузер запустился, но Cambria не открылась');
  }

  async importCambriaCookies(state, cookies) {
    let imported = 0;
    for (const cookie of cookies || []) {
      const domain = String(cookie?.domain || '').replace(/^\./, '');
      if (!/(^|\.)cambria\.gg$/i.test(domain) || !cookie?.name) continue;
      const path =
        typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
      const sameSite = electronSameSite(cookie.sameSite);
      try {
        await state.browserSession.cookies.set({
          url: `${cookie.secure === false ? 'http' : 'https'}://${domain}${path}`,
          domain: cookie.domain,
          path,
          name: cookie.name,
          value: String(cookie.value || ''),
          secure: cookie.secure !== false,
          httpOnly: cookie.httpOnly === true,
          ...(sameSite ? { sameSite } : {}),
          ...(Number(cookie.expires) > 0 ? { expirationDate: Number(cookie.expires) } : {}),
        });
        imported++;
      } catch {
        // Ignore unsupported Chromium cookie attributes and keep the rest.
      }
    }
    return imported;
  }

  async openExternalAuth(input, state) {
    const browser = findExternalBrowser();
    if (!browser) {
      throw loginRequired(
        'Для Cambria нужен Chrome, Edge, Brave или Comet. Установите один браузер и повторите.',
      );
    }
    const profileDir = join(this.app.getPath('userData'), 'cambria-browser-v2', state.key);
    mkdirSync(profileDir, { recursive: true });
    const { profileName } = seedExternalProfile(browser, profileDir);
    const portFile = join(profileDir, 'DevToolsActivePort');
    try {
      if (existsSync(portFile)) unlinkSync(portFile);
    } catch {
      // A stale marker is harmless when Chromium replaces it itself.
    }

    const child = spawn(
      browser.executable,
      [
        `--user-data-dir=${profileDir}`,
        `--profile-directory=${profileName}`,
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--disable-background-timer-throttling',
        `--proxy-server=${proxyRule(input.proxy)}`,
        '--new-window',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    state.externalProcess = child;
    let cdp;
    try {
      const port = await this.waitForDevtools(profileDir, child);
      const target = await this.waitForPageTarget(port);
      cdp = new CdpConnection(target.webSocketDebuggerUrl);
      state.devtools = cdp;
      cdp.onEvent = (message) => {
        if (message.method === 'Fetch.requestPaused') {
          void cdp
            .send('Fetch.continueRequest', { requestId: message.params.requestId })
            .catch(() => undefined);
        } else if (message.method === 'Fetch.authRequired') {
          const hasCredentials = Boolean(input.proxy.username);
          void cdp
            .send('Fetch.continueWithAuth', {
              requestId: message.params.requestId,
              authChallengeResponse: hasCredentials
                ? {
                    response: 'ProvideCredentials',
                    username: input.proxy.username || '',
                    password: input.proxy.password || '',
                  }
                : { response: 'Default' },
            })
            .catch(() => undefined);
        }
      };
      const targets = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
      for (const other of targets.targetInfos || []) {
        if (other.type !== 'page' || other.targetId === target.id) continue;
        await cdp.send('Target.closeTarget', { targetId: other.targetId }).catch(() => undefined);
      }
      await cdp.send('Page.enable');
      await cdp.send('Network.enable');
      await cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
        handleAuthRequests: true,
      });
      await cdp.send('Page.navigate', { url: input.lobbyUrl });

      const currentUserUrl = `${input.apiBase}/user/current`;
      const privySessionUrl = `${input.privyApiBase}/api/v1/sessions`;
      const startedAt = Date.now();
      let lastStatus = 0;
      while (Date.now() - startedAt < AUTH_TIMEOUT_MS) {
        if (child.exitCode !== null) {
          throw loginRequired('Браузер Cambria был закрыт до завершения входа');
        }
        const evaluated = await cdp.send('Runtime.evaluate', {
          expression: `(async () => {
            try {
              const response = await fetch(${JSON.stringify(currentUserUrl)}, {
                credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' }
              });
              let currentUser = null;
              try { currentUser = await response.json(); } catch {}
              let privySession = null;
              let privyStatus = 0;
              if ([200, 404, 429].includes(response.status)) {
                const privyResponse = await fetch(${JSON.stringify(privySessionUrl)}, {
                  method: 'POST',
                  credentials: 'include',
                  cache: 'no-store',
                  headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                    'privy-app-id': ${JSON.stringify(input.privyAppId)},
                    'privy-client': ${JSON.stringify(input.privyClient)}
                  },
                  body: '{}'
                });
                privyStatus = privyResponse.status;
                try { privySession = await privyResponse.json(); } catch {}
              }
              return {
                status: response.status,
                href: location.href,
                currentUser,
                privyStatus,
                privySession
              };
            } catch (error) {
              return { status: 0, href: location.href, error: String(error?.message || error) };
            }
          })()`,
          awaitPromise: true,
          returnByValue: true,
        });
        const result = evaluated?.result?.value;
        lastStatus = Number(result?.status || 0);
        if ([200, 404, 429].includes(lastStatus)) {
          const connectedAddresses = collectWalletAddresses([
            result?.currentUser,
            result?.privySession?.user,
          ]);
          if (!connectedAddresses.has(input.address.toLowerCase())) {
            const connected = connectedAddresses.values().next().value;
            throw loginRequired(
              connected
                ? `В Cambria выбран другой Abstract-аккаунт (${connected.slice(0, 8)}...${connected.slice(-6)}). Выберите ${input.accountLabel || input.address}.`
                : 'Cambria не передала адрес Abstract-аккаунта. Переподключите Abstract в браузере.',
            );
          }
          const cookieResult = await cdp.send('Network.getAllCookies');
          const imported = await this.importCambriaCookies(state, cookieResult.cookies);
          if (imported === 0) {
            throw loginRequired('Cambria вошла, но браузер не передал сессию приложению');
          }
          if (await this.probe(input, state)) return;
          throw loginRequired('Cambria вошла, но сохранённая сессия не прошла проверку');
        }
        await delay(POLL_INTERVAL_MS);
      }
      throw loginRequired(
        `Cambria не завершила вход за 5 минут${lastStatus ? ` (HTTP ${lastStatus})` : ''}`,
      );
    } finally {
      if (cdp) {
        try {
          await cdp.send('Browser.close');
        } catch {
          // The user may have already closed the external browser.
        }
        cdp.close();
      }
      if (state.devtools === cdp) state.devtools = null;
      if (child.exitCode === null) child.kill();
      if (state.externalProcess === child) state.externalProcess = null;
    }
  }

  async prepareInternal(input) {
    const state = this.stateFor(input);
    await this.configureProxy(state, input.proxy);
    await this.seedCookies(input, state);
  }

  async prepare(input) {
    const key = safePartitionKey(input.sessionKey || input.address);
    const existing = this.pending.get(key);
    if (existing) return await existing;

    const operation = this.authQueue.then(() => this.prepareInternal(input));
    this.authQueue = operation.catch(() => undefined);
    this.pending.set(key, operation);
    try {
      await operation;
    } finally {
      this.pending.delete(key);
    }
  }

  async verifyInternal(input) {
    const state = this.stateFor(input);
    await this.configureProxy(state, input.proxy);
    await this.seedCookies(input, state);
    if (await this.probe(input, state)) return;
    await this.openExternalAuth(input, state);
  }

  async verify(input) {
    const key = safePartitionKey(input.sessionKey || input.address);
    const existing = this.pending.get(key);
    if (existing) return await existing;

    const operation = this.authQueue.then(() => this.verifyInternal(input));
    this.authQueue = operation.catch(() => undefined);
    this.pending.set(key, operation);
    try {
      await operation;
    } finally {
      this.pending.delete(key);
    }
  }

  async request(input) {
    const state = this.stateFor(input);
    await this.configureProxy(state, input.proxy);
    return await this.fetch(state, input.request);
  }

  dispose() {
    this.app.removeListener('login', this.handleLogin);
    for (const state of this.states.values()) {
      if (state.devtools) state.devtools.close();
      if (state.externalProcess && state.externalProcess.exitCode === null) {
        state.externalProcess.kill();
      }
    }
    this.states.clear();
  }
}

function createCambriaBrowserBridge(dependencies) {
  const manager = new CambriaBrowserSessions(dependencies);
  return {
    bridge: {
      isReady: manager.isReady.bind(manager),
      prepare: manager.prepare.bind(manager),
      verify: manager.verify.bind(manager),
      request: manager.request.bind(manager),
    },
    dispose: manager.dispose.bind(manager),
  };
}

module.exports = {
  browserCandidates,
  browserRequestHeaders,
  collectWalletAddresses,
  CambriaBrowserSessions,
  CdpConnection,
  createCambriaBrowserBridge,
  findExternalBrowser,
  seedExternalProfile,
  sourceProfileName,
};
