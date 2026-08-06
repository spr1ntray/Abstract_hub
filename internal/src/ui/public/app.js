/** @type {HTMLSpanElement} */
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const statusDetail = document.getElementById('status-detail');
const topbarStatusText = document.getElementById('topbar-status-text');
const paneTitle = document.getElementById('pane-title');
const paneEyebrow = document.getElementById('pane-eyebrow');
const platformChip = document.getElementById('platform-chip');
const panes = {
  overview: 'pane-overview',
  accounts: 'pane-accounts',
  badges: 'pane-badges',
  cambria: 'pane-cambria',
  play: 'pane-play',
  inventory: 'pane-inventory',
  skills: 'pane-skills',
  timing: 'pane-timing',
  tollan: 'pane-tollan',
  updates: 'pane-updates',
};
const paneMeta = {
  overview: { eyebrow: 'ABSTRACT HUB', title: 'Обзор' },
  accounts: { eyebrow: 'ABSTRACT ACCESS', title: 'Аккаунты' },
  badges: { eyebrow: 'ABSTRACT REWARDS', title: 'Flash-бейджи' },
  cambria: { eyebrow: 'ABSTRACT ECOSYSTEM', title: 'Cambria' },
  play: { eyebrow: 'GIGAVERSE', title: 'Запуск сессии' },
  inventory: { eyebrow: 'GIGAVERSE', title: 'Инвентарь' },
  skills: { eyebrow: 'GIGAVERSE', title: 'Скиллы' },
  timing: { eyebrow: 'GIGAVERSE', title: 'Тайминги' },
  tollan: { eyebrow: 'ABSTRACT ECOSYSTEM', title: 'Tollan Universe' },
  updates: { eyebrow: 'ABSTRACT HUB', title: 'Обновления' },
};
const tabsNavigation = document.querySelector('.tabs');
let currentTab = 'accounts';
const VAULT_SESSION_MARKER = '__abstract_hub_vault_session__';
let vaultSessionReady = false;
let vaultRestorePromise = null;
const protectedTabLoads = new Set();

const THEME_STORAGE_KEY = 'abstract-hub-theme';
const themeToggle = document.getElementById('theme-toggle');

function applyTheme(theme) {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = normalized;
  themeToggle.setAttribute('aria-checked', String(normalized === 'dark'));
  themeToggle.setAttribute(
    'aria-label',
    normalized === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему',
  );
  themeToggle.title = normalized === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
}

const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
applyTheme(
  storedTheme === 'light' || storedTheme === 'dark'
    ? storedTheme
    : window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
);

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  window.localStorage.setItem(THEME_STORAGE_KEY, next);
  applyTheme(next);
});

window.addEventListener('storage', (event) => {
  if (event.key !== THEME_STORAGE_KEY) return;
  applyTheme(
    event.newValue === 'light' || event.newValue === 'dark'
      ? event.newValue
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light',
  );
});

// ── Tab routing ──────────────────────────────────────────────────────────────

function renderAnimatedPaneTitle(title) {
  paneTitle.setAttribute('aria-label', title);
  paneTitle.replaceChildren();
  for (const [index, character] of Array.from(title).entries()) {
    const span = document.createElement('span');
    span.className = 'title-character';
    span.setAttribute('aria-hidden', 'true');
    span.style.setProperty('--character-delay', `${index * 18}ms`);
    span.textContent = character === ' ' ? '\u00a0' : character;
    paneTitle.appendChild(span);
  }
}

function updateNavigationState(name) {
  currentTab = name;
  const radio = document.getElementById('tab-' + name);
  const label = radio?.closest('label');
  if (tabsNavigation && label) {
    tabsNavigation.style.setProperty('--rail-y', `${label.offsetTop}px`);
    tabsNavigation.style.setProperty('--rail-height', `${label.offsetHeight}px`);
  }
}

function showTab(name) {
  for (const [key, id] of Object.entries(panes)) {
    document.getElementById(id).hidden = key !== name;
  }
  const activePane = document.getElementById(panes[name]);
  if (activePane) {
    activePane.classList.remove('pane--entering');
    window.requestAnimationFrame(() => activePane.classList.add('pane--entering'));
  }
  const radio = document.getElementById('tab-' + name);
  if (radio) radio.checked = true;
  const meta = paneMeta[name];
  if (meta) {
    renderAnimatedPaneTitle(meta.title);
    paneEyebrow.textContent = meta.eyebrow;
    document.title = `${meta.title} · Abstract Hub`;
  }
  window.requestAnimationFrame(() => updateNavigationState(name));
  // Lazy-load tab content on first open
  if (name === 'timing') loadTimingSettings();
  if (name === 'accounts') refreshAccountsSubpane();
  if (name === 'overview' || name === 'tollan' || name === 'updates') void loadHubInfo();
  if (name === 'badges' || name === 'cambria') void loadHubInfo();
  if (vaultSessionReady) void loadProtectedTab(name);
  else {
    if (name === 'cambria' && cambriaPassword()) void loadCambriaStatus({ quiet: true });
    if (name === 'tollan' && tollanPassword()) void loadTollanStatus({ quiet: true });
  }
}

async function loadProtectedTab(name, force = false) {
  if (!vaultSessionReady || (!force && protectedTabLoads.has(name))) return;
  protectedTabLoads.add(name);
  try {
    if (name === 'inventory') await loadInventory(VAULT_SESSION_MARKER);
    else if (name === 'skills') await loadSkillsPreview({ quiet: true });
    else if (name === 'badges') await loadRacingBadgeStatus({ quiet: true });
    else if (name === 'cambria') await loadCambriaStatus({ quiet: true });
    else if (name === 'tollan') await loadTollanStatus({ quiet: true });
  } catch (error) {
    protectedTabLoads.delete(name);
    showError(error);
  }
}

/**
 * Pick which Accounts sub-pane to show:
 *  • `accounts-setup` — first-time form (no secrets.enc yet)
 *  • `accounts-edit`  — unlock + edit (secrets.enc exists)
 */
async function refreshAccountsSubpane() {
  let hasSecrets = false;
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    hasSecrets = !!data.hasSecrets;
  } catch {
    // Treat network failure as "no secrets" — user gets the setup form, which
    // will fail with a clearer error on submit than a silent blank screen.
  }
  document.getElementById('accounts-setup').hidden = hasSecrets;
  document.getElementById('accounts-edit').hidden = !hasSecrets;
}

document.querySelectorAll('input[name="tab"]').forEach((r) => {
  r.addEventListener('change', () => showTab(r.value));
});

document.querySelectorAll('[data-open-tab]').forEach((button) => {
  button.addEventListener('click', () => showTab(button.dataset.openTab));
});

window.addEventListener('resize', () => updateNavigationState(currentTab));

// ── Status polling ───────────────────────────────────────────────────────────

/** Fetch /api/status and configure the UI accordingly. */
async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    setDot(data.running ? 'running' : 'idle');
    document.body.dataset.desktop = String(Boolean(data.desktop));
    const platformNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
    platformChip.textContent = `${platformNames[data.platform] ?? data.platform ?? 'LOCAL'} · LOCAL`;
    if (data.coreVersion) {
      document.getElementById('build-signature').textContent =
        `v${data.coreVersion} · by sprintray with love`;
    }
    if (data.vaultSession) markVaultSessionReady();
    else {
      if (vaultSessionReady) clearVaultSessionReady();
      if (data.vaultUnlocked) await restoreVaultSession();
    }
    return data;
  } catch {
    setDot('unknown');
    return null;
  }
}

function setDot(state) {
  statusDot.className = 'dot dot--' + state;
  const labels = {
    running: {
      title: 'Работает',
      name: 'Бот работает',
      detail: 'Сессия активна',
      topbar: 'Выполняем действия',
    },
    idle: {
      title: 'Готов к запуску',
      name: 'Сервер подключён',
      detail: 'Готов к запуску',
      topbar: 'Система готова',
    },
    unknown: {
      title: 'Статус неизвестен',
      name: 'Нет подключения',
      detail: 'Проверяем сервер',
      topbar: 'Соединение потеряно',
    },
  };
  const label = labels[state] ?? labels.unknown;
  statusDot.title = label.title;
  statusText.textContent = label.name;
  statusDetail.textContent = label.detail;
  topbarStatusText.textContent = label.topbar;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function apiPost(path, body, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 0;
  const controller = timeoutMs > 0 ? new window.AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (typeof body?.password === 'string' && body.password) {
      const wasReady = vaultSessionReady;
      markVaultSessionReady();
      if (!wasReady) {
        window.dispatchEvent(new window.CustomEvent('abstract-hub:vault-unlocked'));
      }
    }
    return data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Сервер не ответил за ${Math.ceil(timeoutMs / 1000)} секунд`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

function markVaultSessionReady() {
  vaultSessionReady = true;
  for (const input of sharedPasswordInputs) {
    input.value = VAULT_SESSION_MARKER;
    input.dataset.vaultUnlocked = 'true';
  }
}

function clearVaultSessionReady() {
  vaultSessionReady = false;
  protectedTabLoads.clear();
  for (const input of sharedPasswordInputs) {
    if (input.value === VAULT_SESSION_MARKER) input.value = '';
    delete input.dataset.vaultUnlocked;
  }
}

async function restoreVaultSession() {
  if (vaultSessionReady) return true;
  if (vaultRestorePromise) return await vaultRestorePromise;
  vaultRestorePromise = (async () => {
    try {
      const response = await fetch('/api/vault/session/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) return false;
      const wasReady = vaultSessionReady;
      markVaultSessionReady();
      if (!wasReady) {
        window.dispatchEvent(new window.CustomEvent('abstract-hub:vault-unlocked'));
      }
      return true;
    } catch {
      return false;
    } finally {
      vaultRestorePromise = null;
    }
  })();
  return await vaultRestorePromise;
}

async function apiGet(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function showError(err) {
  showToast('Ошибка', err instanceof Error ? err.message : String(err), 'error');
}

function showToast(title, message, type = 'success') {
  const region = document.getElementById('toast-region');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  const copy = document.createElement('div');
  const strong = document.createElement('strong');
  const small = document.createElement('small');
  strong.textContent = title;
  small.textContent = message;
  copy.append(strong, small);
  toast.appendChild(copy);
  region.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function setButtonBusy(button, busy, busyLabel = 'Загрузка') {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyLabel;
    button.classList.add('is-loading');
    button.disabled = true;
    updateActivityIndicators();
    return;
  }
  button.textContent = button.dataset.label || button.textContent;
  button.classList.remove('is-loading');
  button.disabled = false;
  updateActivityIndicators();
}

const activityTabLabels = {
  play: 'Gigaverse',
  inventory: 'Инвентарь',
  badges: 'Бейджи',
  cambria: 'Cambria',
  tollan: 'Tollan',
  skills: 'Скиллы',
  accounts: 'Аккаунты',
  updates: 'Обновления',
  timing: 'Тайминги',
};

const backgroundActivityTabs = new Set();

function setBackgroundActivity(name, active) {
  if (active) backgroundActivityTabs.add(name);
  else backgroundActivityTabs.delete(name);
  updateActivityIndicators();
}

function updateActivityIndicators() {
  const activeTabs = new Set(backgroundActivityTabs);
  for (const [name, paneId] of Object.entries(panes)) {
    const pane = document.getElementById(paneId);
    if (pane?.querySelector('.is-loading, .loading-state:not([hidden])')) activeTabs.add(name);
  }
  if (document.getElementById('run-state')?.dataset.state === 'running') activeTabs.add('play');

  for (const [name] of Object.entries(panes)) {
    const label = document.getElementById(`tab-${name}`)?.closest('label');
    label?.classList.toggle('is-running', activeTabs.has(name));
  }
  const count = activeTabs.size;
  const summary = document.getElementById('activity-summary');
  const title = document.getElementById('activity-summary-title');
  const detail = document.getElementById('activity-summary-detail');
  summary.dataset.count = String(count);
  title.textContent = count
    ? `${count} ${count === 1 ? 'задача выполняется' : 'задачи выполняются'}`
    : 'Нет активных задач';
  detail.textContent = count
    ? Array.from(activeTabs, (name) => activityTabLabels[name] || name).join(' · ')
    : 'Можно запускать действия параллельно';
}

function wireSpecularButtons(root = document) {
  root.querySelectorAll('.btn--primary:not([data-specular])').forEach((button) => {
    button.dataset.specular = 'true';
    button.addEventListener('pointermove', (event) => {
      const bounds = button.getBoundingClientRect();
      button.style.setProperty('--specular-x', `${event.clientX - bounds.left}px`);
      button.style.setProperty('--specular-y', `${event.clientY - bounds.top}px`);
    });
    button.addEventListener('pointerleave', () => {
      button.style.removeProperty('--specular-x');
      button.style.removeProperty('--specular-y');
    });
  });
}

function accountWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'аккаунт';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'аккаунта';
  return 'аккаунтов';
}

function updateAccountCount(listEl) {
  const count = listEl.querySelectorAll('.account-row').length;
  const counterId = listEl.id.startsWith('setup') ? 'setup-row-count' : 'edit-row-count';
  const counter = document.getElementById(counterId);
  if (counter) counter.textContent = `${count} ${accountWord(count)}`;
}

// ── Account rows ─────────────────────────────────────────────────────────────

function newAbstractSessionId() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function abstractAddressFromCredential(credential) {
  return credential.match(/^abstract\s*:\s*(0x[a-f0-9]{40})$/i)?.[1]?.toLowerCase() ?? '';
}

function migrateLegacyCredential(credential) {
  if (!credential.startsWith('eyJ') || credential.split('.').length !== 3) return credential;
  try {
    const encoded = credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(window.atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    return /^0x[a-f0-9]{40}$/i.test(payload.address)
      ? `abstract:${payload.address.toLowerCase()}`
      : credential;
  } catch {
    return credential;
  }
}

function updateAccountRowView(row) {
  const credential = row.querySelector('.account-input').value.trim();
  const address = abstractAddressFromCredential(credential);
  const isLegacyKey = /^0x[a-f0-9]{64}$/i.test(credential);
  const title = row.querySelector('.abstract-account-title');
  const detail = row.querySelector('.abstract-account-detail');
  const button = row.querySelector('.abstract-connect-button');

  row.classList.toggle('is-connected', Boolean(address) && row.dataset.abstractReady === 'true');
  if (address) {
    title.textContent = `${address.slice(0, 10)}…${address.slice(-4)}`;
    if (row.dataset.abstractReady === 'checking') {
      detail.textContent = 'Проверяем разрешения';
      button.textContent = 'Проверяем';
      button.disabled = true;
      button.hidden = false;
      return;
    }
    button.disabled = false;
    const gameReady = row.dataset.gameReady === 'true';
    const tollanReady = row.dataset.tollanReady === 'true';
    detail.textContent =
      row.dataset.abstractReady === 'true'
        ? gameReady && tollanReady
          ? 'Gigaverse и Tollan готовы'
          : gameReady
            ? 'Gigaverse готов · Tollan не подключён'
            : tollanReady
              ? 'Tollan готов · Gigaverse не подключён'
              : 'Нужен единичный вход в приложения'
        : 'Нужно обновить разрешения';
    button.textContent =
      row.dataset.abstractReady === 'true'
        ? gameReady && tollanReady
          ? 'Переподключить'
          : gameReady
            ? 'Подключить Tollan'
            : tollanReady
              ? 'Подключить Gigaverse'
              : 'Подключить приложения'
        : 'Переподключить';
    button.hidden = false;
    return;
  }
  if (isLegacyKey) {
    title.textContent = 'Старое подключение';
    detail.textContent = 'Работает через локальный ключ';
    button.hidden = true;
    return;
  }
  title.textContent = 'Abstract не подключён';
  detail.textContent = 'Выполните вход один раз';
  button.textContent = 'Подключить Abstract';
  button.hidden = false;
}

/** Append one Abstract account, proxy and dungeon row. */
function addAccountRow(
  listEl,
  account = '',
  proxy = '',
  dungeon = '',
  sessionId = '',
  gameSessionExpiresAt = 0,
  tollanReady = false,
) {
  const row = document.createElement('div');
  row.className = 'account-row';

  const accInput = document.createElement('input');
  accInput.type = 'hidden';
  accInput.className = 'account-input';
  accInput.value = migrateLegacyCredential(account);

  const sessionInput = document.createElement('input');
  sessionInput.type = 'hidden';
  sessionInput.className = 'abstract-session-input';
  const existingAddress = abstractAddressFromCredential(accInput.value);
  sessionInput.value = sessionId || (existingAddress ? '' : newAbstractSessionId());
  row.dataset.abstractReady = existingAddress ? 'checking' : 'false';
  row.dataset.gameReady = String(Number(gameSessionExpiresAt) > Date.now());
  row.dataset.tollanReady = String(Boolean(tollanReady));

  const accountControl = document.createElement('div');
  accountControl.className = 'abstract-account-control';
  const accountCopy = document.createElement('div');
  accountCopy.className = 'abstract-account-copy';
  const accountTitle = document.createElement('strong');
  accountTitle.className = 'abstract-account-title';
  const accountDetail = document.createElement('small');
  accountDetail.className = 'abstract-account-detail';
  accountCopy.append(accountTitle, accountDetail);
  const connectButton = document.createElement('button');
  connectButton.type = 'button';
  connectButton.className = 'btn btn--secondary abstract-connect-button';
  connectButton.addEventListener('click', () => connectAccountRow(row, connectButton));
  accountControl.append(accountCopy, connectButton);

  const proxyInput = document.createElement('input');
  proxyInput.type = 'text';
  proxyInput.className = 'proxy-input';
  proxyInput.placeholder = 'http://user:pass@host:port';
  proxyInput.value = proxy;
  proxyInput.autocomplete = 'off';
  proxyInput.spellcheck = false;

  const dungeonSelect = document.createElement('select');
  dungeonSelect.className = 'dungeon-select';
  for (const [value, label] of [
    ['', 'По умолчанию'],
    ['5000', 'Dungeon 5000'],
    ['underhaul', 'Underhaul'],
  ]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === dungeon) opt.selected = true;
    dungeonSelect.appendChild(opt);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn--remove-row';
  removeBtn.title = 'Удалить строку';
  removeBtn.setAttribute('aria-label', 'Удалить аккаунт');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    if (listEl.children.length > 1) {
      row.remove();
    } else {
      accInput.value = '';
      sessionInput.value = newAbstractSessionId();
      row.dataset.abstractReady = 'false';
      row.dataset.gameReady = 'false';
      row.dataset.tollanReady = 'false';
      proxyInput.value = '';
      dungeonSelect.value = '';
      updateAccountRowView(row);
    }
    updateAccountCount(listEl);
  });

  row.appendChild(accountControl);
  row.appendChild(accInput);
  row.appendChild(sessionInput);
  row.appendChild(proxyInput);
  row.appendChild(dungeonSelect);
  row.appendChild(removeBtn);
  listEl.appendChild(row);
  updateAccountRowView(row);
  updateAccountCount(listEl);
  if (existingAddress) {
    void apiPost('/api/abstract/check', {
      expectedAddress: existingAddress,
      ...(sessionInput.value ? { sessionId: sessionInput.value } : {}),
    })
      .then((result) => {
        row.dataset.abstractReady = String(result.availability?.state === 'ready');
      })
      .catch(() => {
        row.dataset.abstractReady = 'false';
      })
      .finally(() => updateAccountRowView(row));
  }
}

/**
 * Collect filled rows as `abstract:<address> | session=<id> | <dungeon>`.
 *
 * @param {HTMLElement} listEl
 * @returns {{ accounts: string, proxies: string }}
 */
function collectRows(listEl) {
  const accountLines = [];
  const proxyLines = [];
  let rowNumber = 0;
  for (const row of listEl.querySelectorAll('.account-row')) {
    rowNumber++;
    const acc = row.querySelector('.account-input').value.trim();
    const sessionId = row.querySelector('.abstract-session-input').value.trim();
    const proxy = row.querySelector('.proxy-input').value.trim();
    const dungeon = row.querySelector('.dungeon-select')?.value ?? '';
    if (!acc && !proxy) continue;
    if (!acc) throw new Error(`Аккаунт ${rowNumber}: сначала выполните вход через Abstract`);
    if (!proxy) throw new Error(`Аккаунт ${rowNumber}: укажите прокси`);
    const parts = [acc];
    if (abstractAddressFromCredential(acc)) {
      if (row.dataset.abstractReady !== 'true') {
        throw new Error(`Аккаунт ${rowNumber}: завершите единичный вход через Abstract`);
      }
      if (sessionId) parts.push(`session=${sessionId}`);
    }
    if (dungeon) parts.push(dungeon);
    accountLines.push(parts.join(' | '));
    proxyLines.push(proxy);
  }
  return {
    accounts: accountLines.join('\n'),
    proxies: proxyLines.join('\n'),
  };
}

/**
 * Populate a list element from two newline-delimited strings.
 * Clears existing rows first. Always renders at least one row.
 * Each account line may carry a local Abstract session and dungeon.
 *
 * @param {HTMLElement} listEl
 * @param {string} accountsStr
 * @param {string} proxiesStr
 */
function populateRows(listEl, accountsStr, proxiesStr, gameSessions = {}, tollanSessions = {}) {
  listEl.innerHTML = '';
  const accounts = accountsStr ? accountsStr.split('\n') : [];
  const proxies = proxiesStr ? proxiesStr.split('\n') : [];
  const len = Math.max(accounts.length, proxies.length, 1);
  for (let i = 0; i < len; i++) {
    const rawAcc = accounts[i] ?? '';
    const [credentialPart = '', ...optionParts] = rawAcc.split('|');
    const credential = credentialPart.trim();
    let sessionId = '';
    let dungeon = '';
    for (const rawOption of optionParts) {
      const option = rawOption.trim();
      const sessionMatch = option.match(/^session\s*=\s*([a-f0-9]{32,64})$/i);
      if (sessionMatch) {
        sessionId = sessionMatch[1].toLowerCase();
        continue;
      }
      const normalized = option.toLowerCase();
      if (/^(1|5000|d5000|dungeon5000|dungeon-5000)$/.test(normalized)) dungeon = '5000';
      else if (/^(3|underhaul|u|dungetron|dungetron-underhaul)$/.test(normalized))
        dungeon = 'underhaul';
    }
    const address = abstractAddressFromCredential(credential);
    addAccountRow(
      listEl,
      credential,
      proxies[i] ?? '',
      dungeon,
      sessionId,
      address ? (gameSessions[address] ?? 0) : 0,
      Boolean(address && tollanSessions[address]),
    );
  }
  updateAccountCount(listEl);
}

const signingKeyDialog = document.getElementById('signing-key-dialog');

function openSigningKeyHelp() {
  signingKeyDialog.showModal();
}

function closeSigningKeyHelp() {
  signingKeyDialog.close();
}

document.querySelectorAll('[data-signing-key-help]').forEach((button) => {
  button.addEventListener('click', openSigningKeyHelp);
});
document.getElementById('signing-key-dialog-close').addEventListener('click', closeSigningKeyHelp);
document.getElementById('signing-key-dialog-done').addEventListener('click', closeSigningKeyHelp);

// ── Setup form ───────────────────────────────────────────────────────────────

const setupList = document.getElementById('setup-accounts-list');
// Render one empty row on load
addAccountRow(setupList);

document.getElementById('btn-add-setup-row').addEventListener('click', () => {
  addAccountRow(setupList);
  setupList.lastElementChild.querySelector('.abstract-connect-button').focus();
});

document.getElementById('form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitButton = e.currentTarget.querySelector('button[type="submit"]');
  const password = document.getElementById('setup-password').value;
  const confirm = document.getElementById('setup-confirm').value;

  if (password.length < 8) {
    showToast('Проверьте пароль', 'Нужно не менее 8 символов.', 'error');
    return;
  }
  if (password !== confirm) {
    showToast('Проверьте пароль', 'Введённые пароли не совпадают.', 'error');
    return;
  }

  try {
    const { accounts, proxies } = collectRows(setupList);
    const capsolverApiKey = document.getElementById('setup-capsolver')?.value?.trim() ?? '';
    setButtonBusy(submitButton, true, 'Сохраняем');
    await apiPost('/api/setup', {
      password,
      accounts,
      proxies,
      ...(capsolverApiKey ? { capsolverApiKey } : {}),
    });
    setDot('idle');
    // First-time form just succeeded → secrets.enc now exists. Re-render the
    // Accounts sub-pane so the edit view takes over, then route to Play.
    await refreshAccountsSubpane();
    showTab('play');
    showToast('Аккаунты подключены', 'Зашифрованное хранилище создано.');
  } catch (err) {
    showError(err);
  } finally {
    setButtonBusy(submitButton, false);
  }
});

// ── Play form ────────────────────────────────────────────────────────────────

const logPane = document.getElementById('log-pane');
const btnPlay = document.getElementById('btn-play');
const btnStop = document.getElementById('btn-stop');
const runState = document.getElementById('run-state');
const runStateTitle = document.getElementById('run-state-title');
const runStateDescription = document.getElementById('run-state-description');
const runElapsed = document.getElementById('run-elapsed');
const runLines = document.getElementById('run-lines');
const runErrors = document.getElementById('run-errors');
const logStatus = document.getElementById('log-status');
const logWrap = document.querySelector('.log-wrap');
let evtSource = null;
let runStartedAt = 0;
let runTimer = null;
let lineCount = 0;
let errorCount = 0;
let runExited = false;

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
    : [minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function updateRunTimer() {
  if (runStartedAt) runElapsed.textContent = formatDuration(Date.now() - runStartedAt);
}

function resetRunMetrics() {
  lineCount = 0;
  errorCount = 0;
  runStartedAt = Date.now();
  runLines.textContent = '0';
  runErrors.textContent = '0';
  runElapsed.textContent = '00:00';
}

function appendLog(line, level = 'neutral') {
  const clean = line.replace(/\r?\n$/, '');
  const row = document.createElement('div');
  row.className = 'log-line';
  if (level === 'error') {
    row.classList.add('log-line--error');
    errorCount += 1;
  } else if (level === 'success') {
    row.classList.add('log-line--success');
  } else if (level === 'warning') {
    row.classList.add('log-line--warning');
  } else if (level === 'separator') {
    row.classList.add('log-line--separator');
  }
  row.textContent = clean;
  logPane.appendChild(row);
  lineCount += 1;
  runLines.textContent = String(lineCount);
  runErrors.textContent = String(errorCount);
  logPane.scrollTop = logPane.scrollHeight;
}

function setPlaying(active, outcome = '') {
  btnPlay.disabled = active;
  btnStop.disabled = !active;
  setDot(active ? 'running' : 'idle');
  logWrap.dataset.active = String(active);
  if (active) {
    if (!runStartedAt) runStartedAt = Date.now();
    window.clearInterval(runTimer);
    runTimer = window.setInterval(updateRunTimer, 1000);
    runState.dataset.state = 'running';
    runStateTitle.textContent = 'Сессия выполняется';
    runStateDescription.textContent = 'Аккаунты обрабатываются по выбранному режиму.';
    logStatus.textContent = 'Получаем события';
    updateActivityIndicators();
    return;
  }

  window.clearInterval(runTimer);
  runTimer = null;
  updateRunTimer();
  if (outcome === 'finished') {
    runState.dataset.state = errorCount > 0 ? 'error' : 'idle';
    runStateTitle.textContent = errorCount > 0 ? 'Сессия завершена с ошибками' : 'Сессия завершена';
    runStateDescription.textContent =
      errorCount > 0
        ? `В журнале отмечено ошибок: ${errorCount}. Остальные аккаунты продолжили работу.`
        : 'Все запущенные аккаунты обработаны.';
    logStatus.textContent = 'Процесс завершён';
  } else {
    runState.dataset.state = 'idle';
    logStatus.textContent = 'Ожидание запуска';
  }
  updateActivityIndicators();
}

function openEvents() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/api/events');
  evtSource.onmessage = (e) => {
    try {
      const { line, level } = JSON.parse(e.data);
      if (line === '__EXIT__') {
        runExited = true;
        setPlaying(false, 'finished');
        return;
      }
      appendLog(line, level);
    } catch {
      /* ignore malformed frames */
    }
  };
  evtSource.onerror = () => setDot('unknown');
}

document.getElementById('form-play').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('play-password').value;
  const dungeon = document.getElementById('play-dungeon').value;
  const list = document.getElementById('play-list').checked;
  const modeRadio = document.querySelector('input[name="play-mode"]:checked');
  const mode = modeRadio ? modeRadio.value : 'parallel';

  if (!password) {
    showToast('Нужен пароль', 'Введите мастер-пароль для запуска.', 'error');
    return;
  }

  try {
    logPane.replaceChildren();
    resetRunMetrics();
    runExited = false;
    setButtonBusy(btnPlay, true, 'Запускаем');
    runState.dataset.state = 'running';
    runStateTitle.textContent = 'Готовим аккаунты';
    runStateDescription.textContent =
      'Abstract автоматически обновит игровые входы при необходимости.';
    logStatus.textContent = 'Подготовка аккаунтов';
    openEvents();
    await apiPost('/api/play', { password, dungeon, list, mode });
    setButtonBusy(btnPlay, false);
    if (!runExited) setPlaying(true);
  } catch (err) {
    setButtonBusy(btnPlay, false);
    runStartedAt = 0;
    runState.dataset.state = 'error';
    runStateTitle.textContent = 'Запуск не выполнен';
    runStateDescription.textContent = err instanceof Error ? err.message : String(err);
    logStatus.textContent = 'Требуется действие';
    showError(err);
    if (evtSource) evtSource.close();
  }
});

btnStop.addEventListener('click', async () => {
  try {
    setButtonBusy(btnStop, true, 'Останавливаем');
    runStateDescription.textContent = 'Завершаем активный процесс безопасно.';
    await apiPost('/api/stop', {});
    setButtonBusy(btnStop, false);
    btnStop.disabled = true;
  } catch (err) {
    setButtonBusy(btnStop, false);
    showError(err);
    btnStop.disabled = false;
  }
});

document.getElementById('btn-clear-log').addEventListener('click', () => {
  logPane.replaceChildren();
  lineCount = 0;
  errorCount = 0;
  runLines.textContent = '0';
  runErrors.textContent = '0';
});

// ── Edit form ────────────────────────────────────────────────────────────────

let editPassword = '';
const editList = document.getElementById('edit-accounts-list');

document.getElementById('btn-add-edit-row').addEventListener('click', () => {
  addAccountRow(editList);
  editList.lastElementChild.querySelector('.abstract-connect-button').focus();
});

document.getElementById('form-unlock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitButton = e.currentTarget.querySelector('button[type="submit"]');
  editPassword = document.getElementById('edit-password').value;
  if (!editPassword) {
    showToast('Нужен пароль', 'Введите мастер-пароль хранилища.', 'error');
    return;
  }

  try {
    setButtonBusy(submitButton, true, 'Открываем');
    const data = await apiPost('/api/unlock', { password: editPassword });
    // Populate rows from the decrypted data
    populateRows(
      editList,
      data.accounts ?? '',
      data.proxies ?? '',
      data.gameSessions ?? {},
      data.tollanSessions ?? {},
    );
    const editCapsolver = document.getElementById('edit-capsolver');
    if (editCapsolver) editCapsolver.value = data.capsolverApiKey ?? '';
    document.getElementById('edit-content').hidden = false;
    showToast(
      'Хранилище открыто',
      data.migratedAccounts
        ? 'Старый формат обновлён. Один раз подключите Abstract и сохраните изменения.'
        : 'Список аккаунтов доступен для редактирования.',
    );
  } catch (err) {
    showError(err);
  } finally {
    setButtonBusy(submitButton, false);
  }
});

document.getElementById('btn-save-edit').addEventListener('click', async () => {
  const saveButton = document.getElementById('btn-save-edit');
  if (!editPassword) {
    showToast('Хранилище закрыто', 'Сначала откройте список мастер-паролем.', 'error');
    return;
  }

  try {
    const { accounts, proxies } = collectRows(editList);
    const capsolverApiKey = document.getElementById('edit-capsolver')?.value?.trim() ?? '';
    setButtonBusy(saveButton, true, 'Сохраняем');
    await apiPost('/api/setup', {
      password: editPassword,
      accounts,
      proxies,
      capsolverApiKey,
    });
    showToast('Изменения сохранены', 'Хранилище аккаунтов перешифровано.');
  } catch (err) {
    showError(err);
  } finally {
    setButtonBusy(saveButton, false);
  }
});

// ── Settings (timing) tab ────────────────────────────────────────────────────

const TIMING_DEFAULTS = {
  action: { minMs: 1500, maxMs: 5000 },
  lootThinking: { minMs: 2000, maxMs: 8000 },
  postAction: { minMs: 200, maxMs: 1500 },
  interRun: { minMs: 60000, maxMs: 240000 },
};

let timingLoaded = false;

async function loadTimingSettings() {
  if (timingLoaded) return;
  try {
    const res = await fetch('/api/timing');
    const cfg = await res.json();
    fillTimingForm(cfg);
    timingLoaded = true;
  } catch {
    fillTimingForm(TIMING_DEFAULTS);
  }
}

function fillTimingForm(cfg) {
  document.getElementById('timing-action-min').value =
    cfg.action?.minMs ?? TIMING_DEFAULTS.action.minMs;
  document.getElementById('timing-action-max').value =
    cfg.action?.maxMs ?? TIMING_DEFAULTS.action.maxMs;
  document.getElementById('timing-loot-min').value =
    cfg.lootThinking?.minMs ?? TIMING_DEFAULTS.lootThinking.minMs;
  document.getElementById('timing-loot-max').value =
    cfg.lootThinking?.maxMs ?? TIMING_DEFAULTS.lootThinking.maxMs;
  document.getElementById('timing-post-min').value =
    cfg.postAction?.minMs ?? TIMING_DEFAULTS.postAction.minMs;
  document.getElementById('timing-post-max').value =
    cfg.postAction?.maxMs ?? TIMING_DEFAULTS.postAction.maxMs;
  document.getElementById('timing-run-min').value =
    cfg.interRun?.minMs ?? TIMING_DEFAULTS.interRun.minMs;
  document.getElementById('timing-run-max').value =
    cfg.interRun?.maxMs ?? TIMING_DEFAULTS.interRun.maxMs;
}

function readTimingForm() {
  const n = (id) => Number(document.getElementById(id).value);
  return {
    action: { minMs: n('timing-action-min'), maxMs: n('timing-action-max') },
    lootThinking: { minMs: n('timing-loot-min'), maxMs: n('timing-loot-max') },
    postAction: { minMs: n('timing-post-min'), maxMs: n('timing-post-max') },
    interRun: { minMs: n('timing-run-min'), maxMs: n('timing-run-max') },
  };
}

function showTimingStatus(msg, isError = false) {
  const el = document.getElementById('timing-status');
  el.textContent = msg;
  el.classList.toggle('inline-status--error', isError);
  el.hidden = false;
  window.setTimeout(() => {
    el.hidden = true;
  }, 3000);
}

document.getElementById('form-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitButton = e.currentTarget.querySelector('button[type="submit"]');
  const cfg = readTimingForm();
  try {
    setButtonBusy(submitButton, true, 'Сохраняем');
    await apiPost('/api/timing', cfg);
    showTimingStatus('Сохранено');
    showToast('Тайминги сохранены', 'Новые диапазоны применятся к следующему действию.');
    timingLoaded = true;
  } catch (err) {
    showTimingStatus('Ошибка: ' + (err instanceof Error ? err.message : String(err)), true);
  } finally {
    setButtonBusy(submitButton, false);
  }
});

document.getElementById('btn-timing-reset').addEventListener('click', () => {
  fillTimingForm(TIMING_DEFAULTS);
  timingLoaded = false; // allow re-load on next visit
});

// ── Inventory tab ─────────────────────────────────────────────────────────────

const inventoryState = {
  accounts: [],
  marketplaceContract: '',
  selection: new Map(),
  listingResults: new Map(),
  search: '',
  sort: 'name',
  view: 'grid',
  sellableOnly: false,
};
const inventoryResults = document.getElementById('inv-results');
const inventoryLoading = document.getElementById('inv-loading');
const inventoryTools = document.getElementById('inventory-tools');
const sellDialog = document.getElementById('sell-dialog');
const sellDialogConfirm = document.getElementById('sell-dialog-confirm');
const sellDialogCancel = document.getElementById('sell-dialog-cancel');
const sellDialogClose = document.getElementById('sell-dialog-close');
const sellDiscountRow = document.getElementById('sell-discount-row');
const sellDiscountPercent = document.getElementById('sell-discount-percent');
const sellFloorStatus = document.getElementById('sell-floor-status');
const abstractApprovalDialog = document.getElementById('abstract-approval-dialog');
const abstractApprovalKicker = document.getElementById('abstract-approval-kicker');
const abstractApprovalTitle = document.getElementById('abstract-approval-title');
const abstractApprovalAccount = document.getElementById('abstract-approval-account');
const abstractApprovalStatus = document.getElementById('abstract-approval-status');
const abstractApprovalLinkRow = document.getElementById('abstract-approval-link-row');
const abstractApprovalUrl = document.getElementById('abstract-approval-url');
const abstractApprovalCopy = document.getElementById('abstract-approval-copy');
const abstractApprovalOpen = document.getElementById('abstract-approval-open');
const abstractApprovalClose = document.getElementById('abstract-approval-close');
const abstractApprovalCancel = document.getElementById('abstract-approval-cancel');
const abstractApprovalDone = document.getElementById('abstract-approval-done');
const abstractApprovalNote = document.getElementById('abstract-approval-note');
let pendingListing = null;
let activeAbstractApprovalOperationId = null;
let activeAbstractApprovalKind = 'abstract';
let abstractApprovalTerminal = true;

function inventorySelectionKey(accountAlias, itemId) {
  return `${accountAlias}:${itemId}`;
}

function parseWei(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function formatWei(value) {
  const wei = typeof value === 'bigint' ? value : parseWei(value);
  if (wei === null) return '—';
  const unit = 10n ** 18n;
  const whole = wei / unit;
  const rawFraction = String(wei % unit).padStart(18, '0');
  const fraction = rawFraction.slice(0, 8).replace(/0+$/, '');
  if (whole === 0n && !fraction && wei > 0n) return '<0.00000001 ETH';
  return `${whole}${fraction ? `.${fraction}` : ''} ETH`;
}

function weiToEthInput(value) {
  const wei = typeof value === 'bigint' ? value : parseWei(value);
  if (wei === null) return '';
  const unit = 10n ** 18n;
  const whole = wei / unit;
  const fraction = String(wei % unit)
    .padStart(18, '0')
    .replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

function parseEthToWei(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(',', '.');
  const match = normalized.match(/^(\d+)(?:\.(\d{0,18}))?$/);
  if (!match) return null;
  try {
    const whole = BigInt(match[1]);
    const fraction = BigInt((match[2] ?? '').padEnd(18, '0') || '0');
    const wei = whole * 10n ** 18n + fraction;
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

function formatLocalTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}

function rarityLabel(value) {
  if (value == null || value === '' || String(value) === '0') return '—';
  return String(value);
}

function createInventoryIcon(item) {
  const iconWrap = document.createElement('div');
  iconWrap.className = 'inv-icon-wrap';
  const placeholder = document.createElement('div');
  placeholder.className = 'inv-icon-placeholder';
  iconWrap.appendChild(placeholder);
  if (item.image) {
    const img = document.createElement('img');
    img.className = 'inv-icon';
    img.src = item.image;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());
    iconWrap.appendChild(img);
  }
  return iconWrap;
}

function reconcileInventorySelection() {
  const next = new Map();
  for (const acc of inventoryState.accounts) {
    for (const item of acc.items ?? []) {
      const key = inventorySelectionKey(acc.alias, item.itemId);
      const amount = inventoryState.selection.get(key);
      if (!item.canList || !amount) continue;
      next.set(key, Math.max(1, Math.min(Number(item.sellableCount) || 0, amount)));
    }
  }
  inventoryState.selection = next;
}

function visibleInventoryItems(acc) {
  const query = inventoryState.search.trim().toLocaleLowerCase('ru');
  const items = (acc.items ?? []).filter((item) => {
    if (inventoryState.sellableOnly && !item.canList) return false;
    if (!query) return true;
    return (
      String(item.name ?? '')
        .toLocaleLowerCase('ru')
        .includes(query) || String(item.itemId).includes(query)
    );
  });

  items.sort((left, right) => {
    if (inventoryState.sort === 'count') {
      return (Number(right.count) || 0) - (Number(left.count) || 0);
    }
    if (inventoryState.sort === 'floor') {
      const leftFloor = parseWei(left.floorWei);
      const rightFloor = parseWei(right.floorWei);
      if (leftFloor === null && rightFloor === null) return 0;
      if (leftFloor === null) return 1;
      if (rightFloor === null) return -1;
      return leftFloor === rightFloor ? 0 : leftFloor > rightFloor ? -1 : 1;
    }
    return String(left.name ?? '').localeCompare(String(right.name ?? ''), 'ru', {
      numeric: true,
      sensitivity: 'base',
    });
  });
  return items;
}

function selectedInventoryItems(acc) {
  const selected = [];
  for (const item of acc.items ?? []) {
    const key = inventorySelectionKey(acc.alias, item.itemId);
    const amount = inventoryState.selection.get(key);
    if (!item.canList || !amount) continue;
    selected.push({ item, amount });
  }
  return selected;
}

function inventorySelectionSummary(acc) {
  const selected = selectedInventoryItems(acc);
  const selectedAmount = selected.reduce((sum, entry) => sum + entry.amount, 0);
  const estimatedWei = selected.reduce((sum, entry) => {
    return sum + (parseWei(entry.item.listPriceWei) ?? 0n) * BigInt(entry.amount);
  }, 0n);
  const connectedSignerAddress = acc.abstractSigner?.connectedAddress
    ? `${acc.abstractSigner.connectedAddress.slice(0, 10)}…${acc.abstractSigner.connectedAddress.slice(-4)}`
    : '';

  return {
    selected,
    title: selected.length
      ? `Выбрано ${selected.length} тип. · ${selectedAmount} шт.`
      : 'Ничего не выбрано',
    detail: !acc.canSell
      ? `${acc.abstractSigner?.message || 'Продажа не подключена для этого аккаунта'}${acc.abstractSigner?.state === 'wrong_account' && connectedSignerAddress ? ` · ${connectedSignerAddress}` : ''}`
      : selected.length
        ? `Оценка листингов: ${formatWei(estimatedWei)}`
        : acc.abstractSigner?.state === 'ready'
          ? 'Abstract подключён · Wood и Stone защищены'
          : 'Wood и Stone всегда остаются в инвентаре',
  };
}

function renderedInventoryAccount(accountAlias) {
  return (
    Array.from(inventoryResults.children).find(
      (element) =>
        element.classList.contains('inv-account') &&
        element.dataset.accountAlias === String(accountAlias),
    ) ?? null
  );
}

function updateInventorySellToolbar(acc) {
  const block = renderedInventoryAccount(acc.alias);
  if (!block) return;
  const summary = inventorySelectionSummary(acc);
  const title = block.querySelector('.inv-sell-summary > strong');
  const detail = block.querySelector('.inv-sell-summary > small');
  const sellButton = block.querySelector('.inv-signer-actions .btn--primary');
  if (title) title.textContent = summary.title;
  if (detail) detail.textContent = summary.detail;
  if (sellButton) sellButton.disabled = !acc.canSell || summary.selected.length === 0;
}

function updateInventorySelectionControls(acc, item, control) {
  const key = inventorySelectionKey(acc.alias, item.itemId);
  const selectedAmount = inventoryState.selection.get(key);
  const itemContainer = control?.closest?.('.inv-cell, .inv-table tbody tr');
  if (itemContainer) {
    itemContainer.classList.toggle('is-selected', selectedAmount != null);
    const checkbox = itemContainer.querySelector(
      '.inv-cell-select input[type="checkbox"], .inv-select-cell input[type="checkbox"]',
    );
    const amountInput = itemContainer.querySelector('.inv-amount');
    if (checkbox) checkbox.checked = selectedAmount != null;
    if (amountInput) {
      amountInput.disabled = !item.canList || selectedAmount == null;
      amountInput.value = String(selectedAmount ?? 1);
    }
  }
  updateInventorySellToolbar(acc);
}

function setInventorySelection(acc, item, checked, requestedAmount = 1, control = null) {
  const key = inventorySelectionKey(acc.alias, item.itemId);
  if (!checked || !item.canList) {
    inventoryState.selection.delete(key);
  } else {
    const max = Math.max(1, Number(item.sellableCount) || 1);
    const amount = Math.max(1, Math.min(max, Number(requestedAmount) || 1));
    inventoryState.selection.set(key, amount);
  }
  updateInventorySelectionControls(acc, item, control);
}

function createSelectionCheckbox(acc, item) {
  const checkbox = document.createElement('input');
  const key = inventorySelectionKey(acc.alias, item.itemId);
  checkbox.type = 'checkbox';
  checkbox.checked = inventoryState.selection.has(key);
  checkbox.disabled = !item.canList;
  checkbox.setAttribute('aria-label', `Выбрать ${item.name || `item ${item.itemId}`}`);
  checkbox.addEventListener('change', () =>
    setInventorySelection(acc, item, checkbox.checked, 1, checkbox),
  );
  return checkbox;
}

function createAmountInput(acc, item) {
  const key = inventorySelectionKey(acc.alias, item.itemId);
  const amount = inventoryState.selection.get(key);
  const input = document.createElement('input');
  input.className = 'inv-amount';
  input.type = 'number';
  input.min = '1';
  input.max = String(Math.max(1, Number(item.sellableCount) || 1));
  input.step = '1';
  input.value = String(amount ?? 1);
  input.disabled = !item.canList || amount == null;
  input.setAttribute('aria-label', `Количество ${item.name || `item ${item.itemId}`}`);
  input.addEventListener('change', () =>
    setInventorySelection(acc, item, true, input.value, input),
  );
  return input;
}

function createInventoryFact(label, value) {
  const fact = document.createElement('div');
  fact.className = 'inv-cell-fact';
  const labelEl = document.createElement('span');
  const valueEl = document.createElement('strong');
  labelEl.textContent = label;
  valueEl.textContent = value;
  valueEl.title = value;
  fact.append(labelEl, valueEl);
  return fact;
}

function inventoryConditionState(condition) {
  if (!condition?.instances?.length) return null;
  if (condition.brokenCount > 0) return `Сломано: ${condition.brokenCount}`;
  if (condition.damagedCount > 0) return `Изношено: ${condition.damagedCount}`;
  return 'Полная прочность';
}

function inventoryConditionInstanceLabel(instance) {
  const durability = Number(instance.durability) || 0;
  const maximum = Number(instance.maxDurability);
  const value =
    Number.isFinite(maximum) && maximum > 0 ? `${durability}/${maximum}` : `${durability}`;
  const repair = `рем. ${Number(instance.repairCount) || 0}`;
  return `${value} · ${repair}${instance.equipped ? ' · надето' : ''}`;
}

function createInventoryCondition(condition, compact = false) {
  const block = document.createElement('div');
  block.className = compact ? 'inv-condition inv-condition--compact' : 'inv-condition';
  const state = document.createElement('div');
  state.className = 'inv-condition-state';
  const label = document.createElement('span');
  const percent = Number(condition?.minimumPercent);
  label.textContent = inventoryConditionState(condition) || 'Нет данных';
  const value = document.createElement('strong');
  value.textContent = Number.isFinite(percent) ? `${percent}% минимум` : 'Прочность';
  state.append(label, value);
  block.appendChild(state);

  if (Number.isFinite(percent)) {
    const track = document.createElement('progress');
    track.className = 'inv-condition-track';
    track.max = 100;
    track.value = Math.max(0, Math.min(100, percent));
    if (percent <= 20) track.dataset.state = 'critical';
    else if (percent <= 55) track.dataset.state = 'worn';
    block.appendChild(track);
  }

  const instances = Array.isArray(condition?.instances) ? condition.instances : [];
  const list = document.createElement('div');
  list.className = 'inv-condition-instances';
  for (const instance of instances.slice(0, compact ? 2 : 4)) {
    const chip = document.createElement('span');
    chip.textContent = inventoryConditionInstanceLabel(instance);
    list.appendChild(chip);
  }
  if (instances.length > (compact ? 2 : 4)) {
    const more = document.createElement('span');
    more.textContent = `+${instances.length - (compact ? 2 : 4)}`;
    list.appendChild(more);
  }
  block.appendChild(list);
  return block;
}

function renderInventoryGrid(acc, items) {
  const grid = document.createElement('div');
  grid.className = 'inv-grid';

  for (const item of items) {
    const key = inventorySelectionKey(acc.alias, item.itemId);
    const cell = document.createElement('article');
    cell.className = 'inv-cell';
    cell.classList.toggle('is-selected', inventoryState.selection.has(key));
    cell.classList.toggle('is-protected', Boolean(item.protected));
    cell.classList.toggle('is-disabled', !item.canList);

    const top = document.createElement('div');
    top.className = 'inv-cell-top';
    const identity = document.createElement('div');
    identity.className = 'inv-cell-identity';
    const title = document.createElement('div');
    title.className = 'inv-cell-title';
    const name = document.createElement('strong');
    const meta = document.createElement('small');
    name.textContent = item.name || `item#${item.itemId}`;
    name.title = name.textContent;
    meta.textContent = `ID ${item.itemId} · ${rarityLabel(item.rarity)}`;
    if (item.unknown) title.classList.add('inv-unknown');
    title.append(name, meta);
    identity.append(createInventoryIcon(item), title);
    const selection = document.createElement('label');
    selection.className = 'inv-cell-select';
    selection.appendChild(createSelectionCheckbox(acc, item));
    top.append(identity, selection);

    const facts = document.createElement('div');
    facts.className = 'inv-cell-facts';
    facts.append(
      createInventoryFact('Всего', String(item.count ?? 0)),
      createInventoryFact('Одето', String(item.equippedCount ?? 0)),
      createInventoryFact('Свободно', String(item.sellableCount ?? 0)),
      createInventoryFact('Редкость', rarityLabel(item.rarity)),
      createInventoryFact('Floor', formatWei(item.floorWei)),
      createInventoryFact('Листинг', formatWei(item.listPriceWei)),
    );

    const footer = document.createElement('div');
    footer.className = 'inv-cell-footer';
    const state = document.createElement('span');
    state.className = 'inv-cell-state';
    state.textContent = item.canList
      ? item.floorWei
        ? 'Можно выставить'
        : 'Доступна своя цена'
      : item.listBlockedReason || 'Недоступно';
    state.title = state.textContent;
    footer.append(state, createAmountInput(acc, item));
    cell.append(top, facts);
    if (item.condition?.instances?.length)
      cell.appendChild(createInventoryCondition(item.condition));
    cell.appendChild(footer);
    grid.appendChild(cell);
  }
  return grid;
}

function renderInventoryTable(acc, items) {
  const wrap = document.createElement('div');
  wrap.className = 'inv-table-wrap';
  const table = document.createElement('table');
  table.className = 'inv-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const heading of [
    '',
    '',
    'Предмет',
    'Всего / одето',
    'Свободно',
    'Состояние',
    'Floor',
    'Листинг',
    'Кол-во',
  ]) {
    const th = document.createElement('th');
    th.textContent = heading;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const item of items) {
    const key = inventorySelectionKey(acc.alias, item.itemId);
    const row = document.createElement('tr');
    row.classList.toggle('is-selected', inventoryState.selection.has(key));
    row.classList.toggle('is-protected', Boolean(item.protected));

    const selectCell = document.createElement('td');
    selectCell.className = 'inv-select-cell';
    selectCell.appendChild(createSelectionCheckbox(acc, item));

    const iconCell = document.createElement('td');
    iconCell.className = 'inv-icon-cell';
    iconCell.appendChild(createInventoryIcon(item));

    const nameCell = document.createElement('td');
    const itemName = document.createElement('div');
    itemName.className = 'inv-table-item';
    const strong = document.createElement('strong');
    const small = document.createElement('small');
    strong.textContent = item.name || `item#${item.itemId}`;
    small.textContent = item.canList
      ? `ID ${item.itemId} · ${rarityLabel(item.rarity)}`
      : item.listBlockedReason || `ID ${item.itemId}`;
    if (item.unknown) itemName.classList.add('inv-unknown');
    itemName.append(strong, small);
    nameCell.appendChild(itemName);

    const totalCell = document.createElement('td');
    totalCell.textContent = `${item.count ?? 0} / ${item.equippedCount ?? 0}`;
    const freeCell = document.createElement('td');
    freeCell.textContent = String(item.sellableCount ?? 0);
    const conditionCell = document.createElement('td');
    conditionCell.className = 'inv-condition-cell';
    conditionCell.appendChild(
      item.condition?.instances?.length
        ? createInventoryCondition(item.condition, true)
        : document.createTextNode('—'),
    );
    const floorCell = document.createElement('td');
    floorCell.className = 'market-price';
    floorCell.textContent = formatWei(item.floorWei);
    const priceCell = document.createElement('td');
    priceCell.className = 'market-price';
    priceCell.textContent = formatWei(item.listPriceWei);
    const amountCell = document.createElement('td');
    amountCell.appendChild(createAmountInput(acc, item));

    row.append(
      selectCell,
      iconCell,
      nameCell,
      totalCell,
      freeCell,
      conditionCell,
      floorCell,
      priceCell,
      amountCell,
    );
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderListingResult(result) {
  const block = document.createElement('div');
  block.className = 'listing-result';
  block.classList.toggle('listing-result--error', result.failed > 0);
  const heading = document.createElement('strong');
  heading.textContent = `Отправлено ${result.submitted} · ошибок ${result.failed}`;
  const list = document.createElement('ul');
  for (const item of result.items ?? []) {
    const row = document.createElement('li');
    const floorTime = formatLocalTime(item.floorCheckedAt);
    const price = formatWei(item.priceWei);
    const detail =
      item.status === 'submitted'
        ? item.txHash
          ? `${price} · tx ${item.txHash.slice(0, 10)}…${item.txHash.slice(-6)}`
          : 'транзакция отправлена'
        : item.error || 'ошибка транзакции';
    row.textContent = `${item.name} ×${item.amount}: ${detail}${floorTime ? ` · floor проверен ${floorTime}` : ''}`;
    row.classList.toggle('is-error', item.status === 'failed');
    list.appendChild(row);
  }
  block.append(heading, list);
  return block;
}

function showAbstractApprovalDialog(action, acc) {
  abstractApprovalKicker.textContent = 'ABSTRACT';
  abstractApprovalTitle.textContent =
    action === 'connect' ? 'Подтверждение подключения' : 'Подтверждение отключения';
  abstractApprovalAccount.textContent = acc.displayName || acc.name || acc.alias;
  abstractApprovalStatus.textContent = 'Готовим защищённую ссылку…';
  abstractApprovalStatus.classList.remove('is-error', 'is-complete');
  abstractApprovalUrl.value = '';
  abstractApprovalLinkRow.hidden = true;
  abstractApprovalCopy.disabled = true;
  abstractApprovalOpen.disabled = true;
  abstractApprovalCancel.disabled = true;
  abstractApprovalDone.disabled = true;
  abstractApprovalNote.textContent =
    'Приложение не откроет ссылку само. Выберите «Копировать» или «Открыть», подтвердите операцию в Abstract и вернитесь сюда.';
  activeAbstractApprovalOperationId = null;
  activeAbstractApprovalKind = 'abstract';
  abstractApprovalTerminal = false;
  if (!abstractApprovalDialog.open) abstractApprovalDialog.showModal();
}

function updateAbstractApprovalDialog(operation) {
  activeAbstractApprovalOperationId = operation.id;
  abstractApprovalTerminal = ['completed', 'failed'].includes(operation.state);
  if (operation.approvalUrl) {
    abstractApprovalUrl.value = operation.approvalUrl;
    abstractApprovalLinkRow.hidden = false;
    abstractApprovalCopy.disabled = false;
    abstractApprovalOpen.disabled = false;
  }
  abstractApprovalCancel.disabled = abstractApprovalTerminal;
  abstractApprovalDone.disabled = !abstractApprovalTerminal;
  abstractApprovalStatus.classList.remove('is-error', 'is-complete');
  if (operation.state === 'completed') {
    abstractApprovalStatus.textContent =
      operation.action === 'connect' ? 'Abstract подключён.' : 'Abstract отключён.';
    abstractApprovalStatus.classList.add('is-complete');
  } else if (operation.state === 'failed') {
    abstractApprovalStatus.textContent = operation.error || 'Abstract не завершил операцию.';
    abstractApprovalStatus.classList.add('is-error');
  } else if (operation.state === 'finalizing') {
    abstractApprovalStatus.textContent = 'Подтверждение получено. Завершаем подключение…';
    abstractApprovalCopy.disabled = true;
    abstractApprovalOpen.disabled = true;
  } else if (operation.state === 'awaiting_approval') {
    abstractApprovalStatus.textContent = 'Ссылка готова. Подтвердите операцию в Abstract.';
  } else {
    abstractApprovalStatus.textContent = 'Готовим защищённую ссылку…';
  }
}

function showAbstractApprovalFailure(error) {
  abstractApprovalTerminal = true;
  abstractApprovalStatus.textContent =
    error instanceof Error ? error.message : 'Abstract не завершил операцию.';
  abstractApprovalStatus.classList.remove('is-complete');
  abstractApprovalStatus.classList.add('is-error');
  abstractApprovalCancel.disabled = true;
  abstractApprovalDone.disabled = false;
}

async function waitForAbstractOperation(operation) {
  let current = operation;
  const deadline = Date.now() + 9 * 60 * 1000;
  updateAbstractApprovalDialog(current);
  while (!['completed', 'failed'].includes(current.state)) {
    if (Date.now() >= deadline) {
      try {
        await apiPost(`/api/abstract/operations/${current.id}/cancel`, {});
      } catch {
        // The server also owns an independent timeout; cancellation is best effort.
      }
      throw new Error('Ожидание Abstract истекло. Запустите подключение ещё раз.');
    }
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    const response = await apiGet(`/api/abstract/operations/${current.id}`);
    current = response.operation;
    updateAbstractApprovalDialog(current);
  }
  if (current.state === 'failed') {
    throw new Error(current.error || 'Abstract не завершил операцию');
  }
  return current;
}

async function waitForBrowserAccountLogin(operation) {
  let current = operation;
  const deadline = Date.now() + 11 * 60 * 1000;
  activeAbstractApprovalKind = 'game';
  activeAbstractApprovalOperationId = current.id;
  abstractApprovalTerminal = false;
  abstractApprovalKicker.textContent = 'ABSTRACT HUB';
  abstractApprovalTitle.textContent = 'Единичный вход в приложения';
  abstractApprovalUrl.value = current.loginUrl;
  abstractApprovalLinkRow.hidden = false;
  abstractApprovalCopy.disabled = false;
  abstractApprovalOpen.disabled = false;
  abstractApprovalCancel.disabled = false;
  abstractApprovalDone.disabled = true;
  abstractApprovalStatus.textContent = 'Ссылка готова. Откройте её в браузере и подтвердите вход.';
  abstractApprovalStatus.classList.remove('is-error', 'is-complete');
  abstractApprovalNote.textContent =
    operation.needsGame && operation.needsTollan
      ? 'В одной вкладке Abstract подтвердит Gigaverse и Tollan. Каждая успешная сессия сохраняется независимо.'
      : operation.needsTollan
        ? 'Gigaverse уже сохранён. Подтвердите только единичный вход Tollan.'
        : 'Tollan уже сохранён. Подтвердите только вход Gigaverse.';

  while (!['completed', 'failed'].includes(current.state)) {
    if (Date.now() >= deadline) {
      await apiPost(`/api/game-auth/operations/${current.id}/cancel`, {}).catch(() => undefined);
      throw new Error('Ожидание входа истекло. Создайте новую ссылку.');
    }
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    const response = await apiGet(`/api/game-auth/operations/${current.id}`);
    current = response.operation;
    if (current.state === 'completed') {
      abstractApprovalTerminal = true;
      abstractApprovalStatus.textContent = current.tollanConnected
        ? 'Gigaverse и Tollan подключены.'
        : 'Gigaverse подключён. Tollan пока не подтвердил вход.';
      abstractApprovalStatus.classList.add('is-complete');
      abstractApprovalCopy.disabled = true;
      abstractApprovalOpen.disabled = true;
      abstractApprovalCancel.disabled = true;
      abstractApprovalDone.disabled = false;
    } else if (current.state === 'failed') {
      abstractApprovalTerminal = true;
      abstractApprovalStatus.textContent = current.error || 'Вход не завершён.';
      abstractApprovalStatus.classList.add('is-error');
      abstractApprovalCancel.disabled = true;
      abstractApprovalDone.disabled = false;
    } else if (current.error) {
      abstractApprovalStatus.textContent = `${current.error} Повторите действие в открытой вкладке.`;
      abstractApprovalStatus.classList.add('is-error');
    }
  }
  if (current.state === 'failed') throw new Error(current.error || 'Вход не завершён');
  return current;
}

async function connectBrowserApps(address, accountLabel, requirements = {}) {
  abstractApprovalAccount.textContent = accountLabel;
  if (!abstractApprovalDialog.open) abstractApprovalDialog.showModal();
  const response = await apiPost('/api/game-auth/start', {
    expectedAddress: address,
    accountAlias: accountLabel,
    needsGame: requirements.needsGame !== false,
    needsTollan: requirements.needsTollan !== false,
  });
  return await waitForBrowserAccountLogin(response.operation);
}

async function connectAccountRow(row, button) {
  const accountInput = row.querySelector('.account-input');
  const sessionInput = row.querySelector('.abstract-session-input');
  const proxyInput = row.querySelector('.proxy-input');
  let address = abstractAddressFromCredential(accountInput.value.trim());
  const isSetupRow = setupList.contains(row);
  const password = isSetupRow ? document.getElementById('setup-password').value : editPassword;
  if (!isSetupRow && (!password || password.length < 8)) {
    showToast('Нужен мастер-пароль', 'Сначала откройте список аккаунтов мастер-паролем.', 'error');
    return;
  }
  if (!proxyInput.value.trim()) {
    showToast('Нужен прокси', 'Укажите прокси этого аккаунта перед входом.', 'error');
    return;
  }
  let accountLabel = address ? `${address.slice(0, 10)}…${address.slice(-4)}` : 'Новый аккаунт';
  let abstractConnected = false;
  let needsGame = row.dataset.gameReady !== 'true';
  let needsTollan = row.dataset.tollanReady !== 'true';

  try {
    setButtonBusy(button, true, 'Подключение…');
    let abstractReady = false;
    if (address) {
      const check = await apiPost('/api/abstract/check', {
        expectedAddress: address,
        ...(sessionInput.value ? { sessionId: sessionInput.value } : {}),
      });
      abstractReady = check.availability?.state === 'ready';
      abstractConnected = abstractReady;
    }
    if (!abstractReady) {
      if (!sessionInput.value) sessionInput.value = newAbstractSessionId();
      showAbstractApprovalDialog('connect', { displayName: accountLabel });
      const response = await apiPost(
        '/api/abstract/onboard',
        {
          sessionId: sessionInput.value,
          ...(address ? { expectedAddress: address } : {}),
        },
        { timeoutMs: 30_000 },
      );
      const operation = await waitForAbstractOperation(response.operation);
      address = operation.availability?.session?.accountAddress?.toLowerCase() ?? '';
      if (!/^0x[a-f0-9]{40}$/.test(address)) {
        throw new Error('Abstract не вернул адрес подключённого аккаунта');
      }
      accountInput.value = `abstract:${address}`;
      row.dataset.abstractReady = 'true';
      abstractConnected = true;
      accountLabel = `${address.slice(0, 10)}…${address.slice(-4)}`;
    }

    row.dataset.abstractReady = 'true';
    abstractConnected = true;
    if (!needsGame && !needsTollan) {
      // Explicit "Переподключить" refreshes both sessions.
      needsGame = true;
      needsTollan = true;
    }
    const browserLogin = await connectBrowserApps(address, accountLabel, {
      needsGame,
      needsTollan,
    });
    if (needsGame) row.dataset.gameReady = 'true';
    if (needsTollan) row.dataset.tollanReady = String(browserLogin.tollanConnected === true);
    if (!isSetupRow) {
      const { accounts, proxies } = collectRows(editList);
      await apiPost('/api/setup', { password, accounts, proxies });
      await apiPost('/api/game-auth/commit', { password });
    }
    abstractApprovalTerminal = true;
    abstractApprovalStatus.textContent =
      row.dataset.tollanReady === 'true'
        ? 'Abstract, Gigaverse и Tollan готовы к автоматизации.'
        : 'Abstract и Gigaverse готовы. Tollan потребует повторить вход.';
    abstractApprovalStatus.classList.add('is-complete');
    abstractApprovalDone.disabled = false;
    showToast(
      'Abstract подключён',
      isSetupRow
        ? 'Аккаунт готов. Завершите заполнение и сохраните список.'
        : 'Аккаунт подключён и изменения сохранены.',
    );
  } catch (error) {
    row.dataset.abstractReady = String(abstractConnected);
    if (needsGame) row.dataset.gameReady = 'false';
    showAbstractApprovalFailure(error);
    if (!(error instanceof Error) || error.message !== 'Подключение отменено') showError(error);
  } finally {
    setButtonBusy(button, false);
    updateAccountRowView(row);
  }
}

async function copyText(value) {
  if (window.navigator.clipboard?.writeText) {
    await window.navigator.clipboard.writeText(value);
    return;
  }
  abstractApprovalUrl.focus();
  abstractApprovalUrl.select();
  document.execCommand('copy');
}

abstractApprovalCopy.addEventListener('click', async () => {
  if (!abstractApprovalUrl.value) return;
  try {
    await copyText(abstractApprovalUrl.value);
    showToast('Ссылка Abstract скопирована', 'Откройте её в браузере с нужным Abstract-аккаунтом.');
  } catch (error) {
    showError(error);
  }
});

abstractApprovalOpen.addEventListener('click', () => {
  if (abstractApprovalUrl.value) window.open(abstractApprovalUrl.value, '_blank', 'noopener');
});

function closeAbstractApprovalDialog() {
  if (abstractApprovalDialog.open) abstractApprovalDialog.close();
}

async function cancelAbstractApproval() {
  if (!activeAbstractApprovalOperationId || abstractApprovalTerminal) return;
  abstractApprovalCancel.disabled = true;
  abstractApprovalStatus.textContent = 'Отменяем подключение…';
  try {
    const response = await apiPost(
      activeAbstractApprovalKind === 'game'
        ? `/api/game-auth/operations/${activeAbstractApprovalOperationId}/cancel`
        : `/api/abstract/operations/${activeAbstractApprovalOperationId}/cancel`,
      {},
    );
    if (activeAbstractApprovalKind === 'game') {
      abstractApprovalTerminal = true;
      abstractApprovalStatus.textContent = response.operation?.error || 'Вход отменён.';
      abstractApprovalStatus.classList.add('is-error');
      abstractApprovalDone.disabled = false;
    } else {
      updateAbstractApprovalDialog(response.operation);
    }
  } catch (error) {
    showAbstractApprovalFailure(error);
    showError(error);
  }
}

abstractApprovalCancel.addEventListener('click', cancelAbstractApproval);
abstractApprovalClose.addEventListener('click', async () => {
  await cancelAbstractApproval();
  closeAbstractApprovalDialog();
});
abstractApprovalDone.addEventListener('click', closeAbstractApprovalDialog);
abstractApprovalDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  void cancelAbstractApproval().finally(closeAbstractApprovalDialog);
});

function renderInventoryAccount(acc) {
  const block = document.createElement('section');
  block.className = 'inv-account';
  block.dataset.accountAlias = String(acc.alias ?? '');
  const header = document.createElement('div');
  header.className = 'inv-account-header';
  const shortAddr = acc.agwAddress
    ? acc.agwAddress.slice(0, 10) + '…' + acc.agwAddress.slice(-4)
    : '';
  const primaryName = acc.displayName || acc.name || acc.alias || shortAddr || 'Аккаунт';
  const meta = [acc.alias, acc.noobId ? `noob #${acc.noobId}` : '', shortAddr]
    .filter(Boolean)
    .join(' · ');
  const title = document.createElement('div');
  title.className = 'account-title';
  const nameEl = document.createElement('strong');
  const metaEl = document.createElement('small');
  nameEl.textContent = primaryName;
  metaEl.textContent = meta || 'Технические данные недоступны';
  title.append(nameEl, metaEl);

  const energy = document.createElement('div');
  energy.className = 'energy-pill';
  const energyLabel = document.createElement('span');
  energyLabel.textContent = acc.energy
    ? `Энергия ${acc.energy.value} / ${acc.energy.max}`
    : 'Энергия недоступна';
  const energyTrack = document.createElement('progress');
  energyTrack.className = 'energy-track';
  energyTrack.max = Math.max(1, acc.energy?.max ?? 1);
  energyTrack.value = Math.max(0, Math.min(energyTrack.max, acc.energy?.value ?? 0));
  energy.append(energyLabel, energyTrack);
  header.append(title, energy);
  block.appendChild(header);

  if (acc.error) {
    const error = document.createElement('p');
    error.className = 'hint hint--error';
    error.textContent = acc.error;
    block.appendChild(error);
  }

  const items = visibleInventoryItems(acc);
  if (!(acc.items ?? []).length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Предметы не найдены.';
    block.appendChild(empty);
  } else if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'По текущему фильтру предметов нет.';
    block.appendChild(empty);
  } else {
    block.appendChild(
      inventoryState.view === 'table'
        ? renderInventoryTable(acc, items)
        : renderInventoryGrid(acc, items),
    );
  }

  const selectionSummary = inventorySelectionSummary(acc);
  const toolbar = document.createElement('div');
  toolbar.className = 'inv-sell-toolbar';
  const summary = document.createElement('div');
  summary.className = 'inv-sell-summary';
  const summaryTitle = document.createElement('strong');
  const summaryDetail = document.createElement('small');
  summaryTitle.textContent = selectionSummary.title;
  summaryDetail.textContent = selectionSummary.detail;
  summary.append(summaryTitle, summaryDetail);
  if (!acc.canSell) {
    const helpButton = document.createElement('button');
    helpButton.type = 'button';
    helpButton.className = 'inline-help-button';
    helpButton.textContent = 'Открыть аккаунты';
    helpButton.addEventListener('click', () => showTab('accounts'));
    summary.appendChild(helpButton);
  }
  const actions = document.createElement('div');
  actions.className = 'btn-row inv-signer-actions';
  const sellButton = document.createElement('button');
  sellButton.type = 'button';
  sellButton.className = 'btn btn--primary';
  sellButton.textContent = 'Выставить выбранное';
  sellButton.disabled = !acc.canSell || selectionSummary.selected.length === 0;
  sellButton.addEventListener('click', () => openSellDialog(acc));
  actions.appendChild(sellButton);
  toolbar.append(summary, actions);
  block.appendChild(toolbar);

  const result = inventoryState.listingResults.get(acc.alias);
  if (result) block.appendChild(renderListingResult(result));
  return block;
}

function renderInventory() {
  inventoryResults.replaceChildren();
  if (!inventoryState.accounts.length) {
    const empty = document.createElement('p');
    empty.className = 'result-message';
    empty.textContent = 'Аккаунты не найдены.';
    inventoryResults.appendChild(empty);
    return;
  }
  for (const acc of inventoryState.accounts) {
    inventoryResults.appendChild(renderInventoryAccount(acc));
  }
}

async function loadInventory(password, options = {}) {
  const showLoading = options.showLoading !== false;
  if (showLoading) inventoryLoading.hidden = false;
  try {
    const data = await apiPost('/api/inventory', { password }, { timeoutMs: 90_000 });
    inventoryState.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    inventoryState.marketplaceContract = data.marketplaceContract || '';
    reconcileInventorySelection();
    inventoryTools.hidden = false;
    renderInventory();
  } finally {
    if (showLoading) inventoryLoading.hidden = true;
  }
}

document.getElementById('form-inventory').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  const password = document.getElementById('inv-password').value;
  if (!password) {
    showToast('Нужен пароль', 'Введите мастер-пароль для загрузки инвентаря.', 'error');
    return;
  }

  inventoryResults.replaceChildren();
  try {
    setButtonBusy(submitButton, true, 'Обновляем');
    await loadInventory(password);
  } catch (error) {
    inventoryResults.replaceChildren();
    showError(error);
  } finally {
    setButtonBusy(submitButton, false);
  }
});

document.getElementById('inventory-search').addEventListener('input', (event) => {
  inventoryState.search = event.currentTarget.value;
  renderInventory();
});

document.getElementById('inventory-sort').addEventListener('change', (event) => {
  inventoryState.sort = event.currentTarget.value;
  renderInventory();
});

document.querySelectorAll('input[name="inventory-view"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    inventoryState.view = input.value;
    renderInventory();
  });
});

document.getElementById('inventory-sellable-only').addEventListener('change', (event) => {
  inventoryState.sellableOnly = event.currentTarget.checked;
  renderInventory();
});

function createListingRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16);
  return `${Date.now().toString(16)}-${random}`;
}

function selectedSellPriceMode() {
  return document.querySelector('input[name="sell-price-mode"]:checked')?.value || 'floor';
}

function sellDiscountBps() {
  const percent = Number(sellDiscountPercent.value);
  if (!Number.isFinite(percent) || percent < 0 || percent >= 100) return null;
  return Math.round(percent * 100);
}

function pendingItemUnitPrice(item, mode) {
  if (mode === 'custom') return item.customPriceWei ?? null;
  const floor = parseWei(item.floorWei);
  if (floor === null) return null;
  if (mode === 'floor') return floor;
  const discountBps = sellDiscountBps();
  if (discountBps === null) return null;
  return (floor * BigInt(10_000 - discountBps)) / 10_000n;
}

function updateSellDialogTotal() {
  if (!pendingListing) return;
  const mode = selectedSellPriceMode();
  let total = 0n;
  let valid = true;
  for (const item of pendingListing.items) {
    const unitPrice = pendingItemUnitPrice(item, mode);
    if (unitPrice === null || unitPrice <= 0n) {
      valid = false;
      continue;
    }
    total += unitPrice * BigInt(item.amount);
  }
  document.getElementById('sell-dialog-total').textContent = valid
    ? formatWei(total)
    : 'Проверьте цену';
  sellDialogConfirm.disabled = !valid || pendingListing.running;
}

function renderSellDialogItems() {
  if (!pendingListing) return;
  const mode = selectedSellPriceMode();
  pendingListing.pricingMode = mode;
  sellDiscountRow.hidden = mode !== 'discount';
  const fetchedAt = formatLocalTime(pendingListing.floorFetchedAt);
  sellFloorStatus.textContent =
    mode === 'custom'
      ? 'Собственная цена за один предмет.'
      : `${mode === 'floor' ? 'Точный floor' : 'Расчёт от floor'}${fetchedAt ? ` · снимок ${fetchedAt}` : ''}`;

  const itemList = document.getElementById('sell-dialog-items');
  itemList.replaceChildren();
  for (const item of pendingListing.items) {
    const row = document.createElement('div');
    row.className = 'sell-dialog-item';
    const name = document.createElement('span');
    name.textContent = `${item.name} ×${item.amount}`;
    const editor = document.createElement('div');
    editor.className = 'sell-price-editor';

    if (mode === 'custom') {
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.value = weiToEthInput(item.customPriceWei);
      input.setAttribute('aria-label', `Цена ${item.name} в ETH`);
      const suffix = document.createElement('span');
      suffix.textContent = 'ETH';
      input.addEventListener('input', () => {
        item.customPriceWei = parseEthToWei(input.value);
        input.classList.toggle('is-invalid', item.customPriceWei === null);
        updateSellDialogTotal();
      });
      editor.append(input, suffix);
    } else {
      const unitPrice = pendingItemUnitPrice(item, mode);
      const total = unitPrice === null ? null : unitPrice * BigInt(item.amount);
      const price = document.createElement('span');
      price.textContent = formatWei(total);
      price.title = unitPrice === null ? '' : `${formatWei(unitPrice)} за предмет`;
      editor.appendChild(price);
    }
    row.append(name, editor);
    itemList.appendChild(row);
  }
  updateSellDialogTotal();
}

function openSellDialog(acc) {
  const selected = selectedInventoryItems(acc);
  if (!selected.length) return;
  pendingListing = {
    accountAlias: acc.alias,
    accountName: acc.displayName || acc.name || acc.alias,
    floorFetchedAt: acc.floorFetchedAt,
    requestId: createListingRequestId(),
    running: false,
    items: selected.map(({ item, amount }) => ({
      itemId: item.itemId,
      name: item.name || `item#${item.itemId}`,
      amount,
      floorWei: item.floorWei,
      customPriceWei: parseWei(item.listPriceWei) ?? parseWei(item.floorWei),
    })),
  };

  document.getElementById('sell-dialog-account').textContent = pendingListing.accountName;
  const floorRadio = document.querySelector('input[name="sell-price-mode"][value="floor"]');
  if (floorRadio) floorRadio.checked = true;
  sellDiscountPercent.value = '1';
  renderSellDialogItems();
  sellDialog.showModal();
}

document.querySelectorAll('input[name="sell-price-mode"]').forEach((input) => {
  input.addEventListener('change', renderSellDialogItems);
});
sellDiscountPercent.addEventListener('input', () => {
  if (selectedSellPriceMode() === 'discount') renderSellDialogItems();
});

function closeSellDialog() {
  if (pendingListing?.running) return;
  sellDialog.close();
  pendingListing = null;
}

sellDialogClose.addEventListener('click', closeSellDialog);
sellDialogCancel.addEventListener('click', closeSellDialog);
sellDialog.addEventListener('cancel', (event) => {
  if (pendingListing?.running) {
    event.preventDefault();
    return;
  }
  pendingListing = null;
});

function buildListingPricingPayload(operation) {
  const mode = operation.pricingMode || selectedSellPriceMode();
  if (mode === 'discount') {
    const discountBps = sellDiscountBps();
    if (discountBps === null) throw new Error('Укажите скидку от 0% до 99.99%');
    return { mode, discountBps };
  }
  if (mode === 'custom') {
    for (const item of operation.items) {
      if (item.customPriceWei === null || item.customPriceWei <= 0n) {
        throw new Error(`Проверьте собственную цену для ${item.name}`);
      }
    }
  }
  return { mode };
}

function setSellPricingDisabled(disabled) {
  document.querySelectorAll('input[name="sell-price-mode"]').forEach((input) => {
    input.disabled = disabled;
  });
  sellDiscountPercent.disabled = disabled;
  document.querySelectorAll('.sell-price-editor input').forEach((input) => {
    input.disabled = disabled;
  });
}

sellDialogConfirm.addEventListener('click', async () => {
  if (!pendingListing || pendingListing.running) return;
  const password = document.getElementById('inv-password').value;
  if (!password) {
    showToast('Нужен пароль', 'Введите мастер-пароль перед продажей.', 'error');
    return;
  }

  const operation = pendingListing;
  let pricing;
  try {
    pricing = buildListingPricingPayload(operation);
  } catch (error) {
    showError(error);
    return;
  }
  operation.running = true;
  sellDialogCancel.disabled = true;
  sellDialogClose.disabled = true;
  setSellPricingDisabled(true);
  try {
    setButtonBusy(sellDialogConfirm, true, 'Отправляем');
    const result = await apiPost(
      '/api/inventory/list',
      {
        password,
        accountAlias: operation.accountAlias,
        requestId: operation.requestId,
        pricing,
        items: operation.items.map((item) => ({
          itemId: item.itemId,
          amount: item.amount,
          ...(pricing.mode === 'custom' ? { priceWei: item.customPriceWei.toString() } : {}),
        })),
      },
      { timeoutMs: 180_000 },
    );
    inventoryState.listingResults.set(operation.accountAlias, result);
    for (const item of result.items ?? []) {
      if (item.status === 'submitted') {
        inventoryState.selection.delete(inventorySelectionKey(operation.accountAlias, item.itemId));
      }
    }
    sellDialog.close();
    pendingListing = null;
    renderInventory();
    const resultTitle =
      result.submitted === 0 && result.failed > 0
        ? 'Листинг не отправлен'
        : result.failed > 0
          ? 'Листинг завершён частично'
          : 'Листинг отправлен';
    showToast(
      resultTitle,
      `Транзакций отправлено: ${result.submitted}; ошибок: ${result.failed}.`,
      result.failed ? 'error' : 'success',
    );
    try {
      await loadInventory(password, { showLoading: false });
    } catch (refreshError) {
      showToast(
        'Инвентарь не обновлён',
        refreshError instanceof Error ? refreshError.message : String(refreshError),
        'error',
      );
    }
  } catch (error) {
    showError(error);
  } finally {
    if (pendingListing === operation) operation.running = false;
    setButtonBusy(sellDialogConfirm, false);
    sellDialogCancel.disabled = false;
    sellDialogClose.disabled = false;
    setSellPricingDisabled(false);
    updateSellDialogTotal();
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

// ── Skills tab ────────────────────────────────────────────────────────────────

function renderSkillsPreview(container, accounts) {
  container.replaceChildren();
  if (!accounts.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Нет аккаунтов';
    container.appendChild(p);
    return;
  }
  for (const acc of accounts) {
    const block = document.createElement('div');
    block.className = 'skill-account';

    const head = document.createElement('div');
    head.className = 'skill-account-header';
    const shortAddr = acc.agwAddress
      ? acc.agwAddress.slice(0, 10) + '…' + acc.agwAddress.slice(-4)
      : '';
    const accountName = acc.displayName || acc.name || acc.alias || 'Аккаунт';
    head.textContent = `${accountName} ${shortAddr ? '(' + shortAddr + ')' : ''}  noob #${acc.noobId || '—'}`;
    block.appendChild(head);

    if (acc.error) {
      const p = document.createElement('p');
      p.className = 'hint hint--error';
      p.textContent = acc.error;
      block.appendChild(p);
      container.appendChild(block);
      continue;
    }

    if (acc.nextUpgrade) {
      const next = document.createElement('p');
      next.className = 'hint';
      next.textContent = `След. апгрейд: ${acc.nextUpgrade.skillName} — ${acc.nextUpgrade.statName}, lvl ${acc.nextUpgrade.fromLevel}→${acc.nextUpgrade.fromLevel + 1}, цена ${acc.nextUpgrade.cost} SP`;
      block.appendChild(next);
    } else {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = '(нечего качать — всё на максимум по стратегии)';
      block.appendChild(p);
    }

    for (const skill of acc.skills) {
      const table = document.createElement('table');
      table.className = 'inv-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const h of [skill.name, 'Уровень', '/ Макс', 'Цена', 'В стратегии']) {
        const th = document.createElement('th');
        th.textContent = h;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const s of skill.stats) {
        const tr = document.createElement('tr');
        if (!s.allowed) tr.classList.add('inv-unknown');
        for (const value of [
          s.name,
          String(s.level),
          String(s.maxLevel),
          s.nextCost === -1 ? '—' : String(s.nextCost),
          s.allowed ? 'да' : '—',
        ]) {
          const td = document.createElement('td');
          td.textContent = value;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      block.appendChild(table);
    }
    container.appendChild(block);
  }
}

function formatSkillStopReason(reason) {
  const value = String(reason || 'завершено');
  const maxMatch = value.match(/^max upgrades reached \((\d+)\)$/);
  if (maxMatch) return `достигнут лимит: ${maxMatch[1]}`;
  const timeMatch = value.match(/^time limit reached \((\d+)s\)$/);
  if (timeMatch) return `остановлено по времени: ${timeMatch[1]} с`;
  if (value === 'no more allowed stats can be upgraded') return 'доступных боевых апгрейдов нет';
  if (/insufficient skill points/i.test(value)) return 'не хватает skill points';
  return value;
}

function skillTreeName(skillId) {
  if (skillId === 1) return 'Dungetron 5000';
  if (skillId === 2) return 'Underhaul';
  return `skill#${skillId}`;
}

function renderSkillsRun(container, accounts) {
  container.replaceChildren();
  for (const acc of accounts) {
    const block = document.createElement('div');
    block.className = 'skill-account';
    const head = document.createElement('div');
    head.className = 'skill-account-header';
    const accountName = acc.displayName || acc.name || acc.alias || 'Аккаунт';
    head.textContent = `${accountName} — прокачано ${acc.upgraded}; ${formatSkillStopReason(acc.stopReason)}`;
    block.appendChild(head);
    if (Array.isArray(acc.log)) {
      const ul = document.createElement('ul');
      for (const u of acc.log) {
        const li = document.createElement('li');
        li.textContent = `${skillTreeName(u.skillId)} · ${u.statName} · lvl ${u.fromLevel}→${u.fromLevel + 1} · ${u.cost} SP`;
        ul.appendChild(li);
      }
      block.appendChild(ul);
    }
    container.appendChild(block);
  }
}

async function loadSkillsPreview(options = {}) {
  const button = document.getElementById('btn-skills-preview');
  const password = document.getElementById('skills-password').value;
  if (!password) {
    if (!options.quiet) {
      showToast('Нужен пароль', 'Введите мастер-пароль для проверки скиллов.', 'error');
    }
    return null;
  }
  const loadingEl = document.getElementById('skills-loading');
  const loadingText = document.getElementById('skills-loading-text');
  const resultsEl = document.getElementById('skills-results');
  loadingText.textContent = 'Проверяем боевые скиллы';
  loadingEl.hidden = false;
  resultsEl.replaceChildren();
  try {
    setButtonBusy(button, true, 'Проверяем');
    const data = await apiPost('/api/skills/preview', { password }, { timeoutMs: 45_000 });
    renderSkillsPreview(resultsEl, data.accounts ?? []);
    return data;
  } catch (err) {
    if (!options.quiet) showError(err);
    else throw err;
  } finally {
    loadingEl.hidden = true;
    setButtonBusy(button, false);
  }
  return null;
}

document.getElementById('btn-skills-preview').addEventListener('click', async () => {
  await loadSkillsPreview();
});

document.getElementById('btn-skills-run').addEventListener('click', async () => {
  const button = document.getElementById('btn-skills-run');
  const password = document.getElementById('skills-password').value;
  const max = Number(document.getElementById('skills-max').value);
  if (!password) {
    showToast('Нужен пароль', 'Введите мастер-пароль для прокачки.', 'error');
    return;
  }
  if (!Number.isSafeInteger(max) || max < 1 || max > 50) {
    showToast('Проверьте лимит', 'Укажите целое число от 1 до 50.', 'error');
    return;
  }
  if (
    !window.confirm(
      `Запустить до ${max} боевых апгрейдов на каждом аккаунте? Это потратит skill points.`,
    )
  )
    return;
  const loadingEl = document.getElementById('skills-loading');
  const loadingText = document.getElementById('skills-loading-text');
  const resultsEl = document.getElementById('skills-results');
  loadingText.textContent = `Прокачиваем аккаунты · до ${max} апгрейдов на каждый`;
  loadingEl.hidden = false;
  resultsEl.replaceChildren();
  try {
    setButtonBusy(button, true, 'Прокачиваем');
    const data = await apiPost(
      '/api/skills/run',
      { password, maxUpgrades: max },
      { timeoutMs: 180_000 },
    );
    renderSkillsRun(resultsEl, data.accounts ?? []);
    showToast('Прокачка завершена', 'Результаты обновлены для всех аккаунтов.');
  } catch (err) {
    showError(err);
  } finally {
    loadingEl.hidden = true;
    setButtonBusy(button, false);
  }
});

// ── Abstract Hub overview / modules ─────────────────────────────────────────

let hubInfoCache = null;

function formatHubDate(value, options = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  }).format(date);
}

function formatHubTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function setExternalHref(id, href) {
  const link = document.getElementById(id);
  if (link && href) link.href = href;
}

function renderUpdateStatus(update) {
  if (!update) return;
  document.getElementById('build-signature').textContent =
    `v${update.coreVersion} · by sprintray with love`;
  document.getElementById('updates-core-version').textContent = `v${update.coreVersion}`;
  document.getElementById('updates-pack-version').textContent = update.packVersion;
  document.getElementById('overview-pack-version').textContent = update.packVersion;
  document.getElementById('updates-published-at').textContent = formatHubDate(update.publishedAt, {
    year: 'numeric',
  });
  document.getElementById('updates-pack-source').textContent =
    update.packSource === 'installed' ? 'Установлен поверх приложения' : 'Встроенный пакет';

  const overall = document.getElementById('updates-overall-state');
  const install = document.getElementById('btn-updates-install');
  const rollback = document.getElementById('btn-updates-rollback');
  const message = document.getElementById('updates-message');
  install.disabled = !update.pendingPackVersion;
  rollback.disabled = !update.canRollback;
  setExternalHref('updates-release-link', update.releaseUrl);

  if (update.pendingPackVersion) {
    overall.textContent = 'Есть data-pack';
    overall.classList.add('security-badge--attention');
    message.textContent = `Готов data-pack ${update.pendingPackVersion}. Установка не затронет аккаунты и входы.`;
  } else if (update.coreUpdateAvailable) {
    overall.textContent = 'Есть Core';
    overall.classList.add('security-badge--attention');
    message.textContent = `Доступен Abstract Hub v${update.latestCoreVersion}. Данные аккаунтов останутся в прежнем хранилище.`;
  } else if (update.warning) {
    overall.textContent = 'Офлайн';
    overall.classList.remove('security-badge--attention');
    message.textContent = update.warning;
  } else {
    overall.textContent = 'Актуально';
    overall.classList.remove('security-badge--attention');
    message.textContent = 'Установлены актуальные Core и data-pack.';
  }
}

function applyHubInfo(data) {
  hubInfoCache = data;
  renderUpdateStatus(data.update);
  setExternalHref('badge-rewards-link', data.modules?.badges?.rewardsUrl);
  applyBadgeCampaign(data.modules?.badges?.flash);
  setExternalHref('cambria-lobby-link', data.modules?.cambria?.lobbyUrl);
  setExternalHref('tollan-open-hub', data.modules?.tollan?.hubUrl);
  setExternalHref('tollan-open-missions', data.modules?.tollan?.missionsUrl);
  setExternalHref('tollan-open-inventory', data.modules?.tollan?.inventoryUrl);
  setExternalHref('tollan-open-store', data.modules?.tollan?.storeUrl);
  setExternalHref('tollan-open-practice', data.modules?.tollan?.practiceUrl);
}

async function loadHubInfo(force = false) {
  if (hubInfoCache && !force) return hubInfoCache;
  try {
    const data = await apiGet('/api/hub');
    applyHubInfo(data);
    return data;
  } catch (error) {
    document.getElementById('updates-message').textContent =
      error instanceof Error ? error.message : String(error);
    return null;
  }
}

document.getElementById('btn-updates-check').addEventListener('click', async () => {
  const button = document.getElementById('btn-updates-check');
  let update = null;
  try {
    setButtonBusy(button, true, 'Проверяем');
    const data = await apiPost('/api/hub/updates/check', {}, { timeoutMs: 35_000 });
    if (hubInfoCache) hubInfoCache.update = data.update;
    update = data.update;
  } catch (error) {
    showError(error);
  } finally {
    setButtonBusy(button, false);
  }
  if (update) renderUpdateStatus(update);
});

document.getElementById('btn-updates-install').addEventListener('click', async () => {
  const button = document.getElementById('btn-updates-install');
  let update = null;
  try {
    setButtonBusy(button, true, 'Устанавливаем');
    const data = await apiPost('/api/hub/updates/install', {});
    if (hubInfoCache) hubInfoCache.update = data.update;
    update = data.update;
  } catch (error) {
    showError(error);
  } finally {
    setButtonBusy(button, false);
  }
  if (update) {
    renderUpdateStatus(update);
    showToast('Data-pack установлен', 'Новые параметры уже используются хабом.');
  }
});

document.getElementById('btn-updates-rollback').addEventListener('click', async () => {
  const button = document.getElementById('btn-updates-rollback');
  let update = null;
  try {
    setButtonBusy(button, true, 'Откатываем');
    const data = await apiPost('/api/hub/updates/rollback', {});
    if (hubInfoCache) hubInfoCache.update = data.update;
    update = data.update;
  } catch (error) {
    showError(error);
  } finally {
    setButtonBusy(button, false);
  }
  if (update) {
    renderUpdateStatus(update);
    showToast('Откат выполнен', 'Восстановлена предыдущая конфигурация модулей.');
  }
});

// ── Abstract Discover ────────────────────────────────────────────────────────

let discoverRefreshTimer = null;

function discoverStateLabel(account) {
  if (account.error) return { text: 'Ошибка', className: 'module-state--error' };
  if (discoverAccountDone(account)) {
    return { text: 'Готово', className: 'module-state--ready' };
  }
  if (account.status === 'submitted') {
    return { text: 'Отправлено', className: 'module-state--limited' };
  }
  return { text: 'Нужен голос', className: 'module-state--attention' };
}

function discoverAccountDone(account) {
  return account.votedToday || ['confirmed', 'already_voted'].includes(account.status);
}

function renderDiscoverRows(container, accounts) {
  container.replaceChildren();
  for (const [index, account] of accounts.entries()) {
    const row = document.createElement('article');
    row.className = 'discover-account';
    row.dataset.state = account.error
      ? 'error'
      : discoverAccountDone(account)
        ? 'ready'
        : 'pending';
    row.style.setProperty('--list-delay', `${index * 70}ms`);

    const head = document.createElement('div');
    head.className = 'discover-account-head';
    const identity = document.createElement('div');
    const mark = document.createElement('span');
    mark.className = 'discover-account-mark';
    mark.textContent = 'A';
    const identityCopy = document.createElement('span');
    const name = document.createElement('strong');
    const address = document.createElement('small');
    name.textContent = account.name || 'Abstract аккаунт';
    address.textContent = account.address
      ? `${account.address.slice(0, 8)}...${account.address.slice(-6)}`
      : 'Адрес не определён';
    identityCopy.append(name, address);
    identity.append(mark, identityCopy);

    const state = discoverStateLabel(account);
    const badge = document.createElement('span');
    badge.className = `module-state ${state.className}`;
    badge.textContent = state.text;
    head.append(identity, badge);
    row.appendChild(head);

    if (account.error) {
      const error = document.createElement('p');
      error.className = 'discover-account-error';
      error.textContent = account.error;
      row.appendChild(error);
      container.appendChild(row);
      continue;
    }

    const metrics = document.createElement('div');
    metrics.className = 'discover-account-metrics';
    const values = [
      ['Текущий стрик', `${account.currentStreakDays ?? 0} дн.`],
      ['Лучший', `${account.longestStreakDays ?? account.currentStreakDays ?? 0} дн.`],
      [
        discoverAccountDone(account) ? 'Следующий день' : 'Голос до',
        formatHubTime(account.nextVoteBy),
      ],
    ];
    for (const [label, value] of values) {
      const metric = document.createElement('div');
      const small = document.createElement('span');
      const strong = document.createElement('strong');
      small.textContent = label;
      strong.textContent = value;
      metric.append(small, strong);
      metrics.appendChild(metric);
    }
    row.appendChild(metrics);

    if (account.app?.name) {
      const app = document.createElement('p');
      app.className = 'discover-vote-app';
      app.textContent = `Голос: ${account.app.name}`;
      row.appendChild(app);
    } else if (account.lastVoteAt) {
      const last = document.createElement('p');
      last.className = 'discover-vote-app';
      last.textContent = `Последний голос: ${formatHubDate(account.lastVoteAt)}`;
      row.appendChild(last);
    }

    container.appendChild(row);
  }
}

function applyDiscoverSnapshot(data) {
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  renderDiscoverRows(document.getElementById('overview-results'), accounts);

  const healthy = accounts.filter((account) => !account.error);
  const voted = healthy.filter(discoverAccountDone).length;
  const best = healthy.reduce(
    (maximum, account) =>
      Math.max(maximum, account.longestStreakDays ?? account.currentStreakDays ?? 0),
    0,
  );
  document.getElementById('overview-account-count').textContent = String(accounts.length);
  document.getElementById('overview-vote-count').textContent = `${voted}/${healthy.length}`;
  document.getElementById('overview-best-streak').textContent = `${best} дн.`;
  const errors = accounts.length - healthy.length;
  const allDone = healthy.length > 0 && voted === healthy.length;
  const state = data.state || (errors ? 'partial_error' : 'ready');
  const status = document.getElementById('overview-discover-state');
  const automationLabel = document.getElementById('overview-automation-label');
  const indicator = document.querySelector('.automation-indicator');
  indicator.dataset.state = state;

  if (state === 'locked') {
    status.textContent = 'Ожидает входа';
    status.className = 'module-state module-state--attention';
    automationLabel.textContent = 'Ожидает разблокировки';
    document.getElementById('overview-summary').textContent =
      'Введите мастер-пароль в любом рабочем разделе один раз. Дальше стрик поддерживается автоматически.';
  } else if (state === 'checking') {
    status.textContent = 'Проверяем';
    status.className = 'module-state module-state--limited';
    automationLabel.textContent = 'Проверяем аккаунты';
    document.getElementById('overview-summary').textContent =
      'Фоновая служба проверяет сегодняшний голос и при необходимости отправляет его.';
  } else if (allDone && errors === 0) {
    status.textContent = 'Готово';
    status.className = 'module-state module-state--ready';
    automationLabel.textContent = 'Стрик поддержан';
    document.getElementById('overview-summary').textContent =
      'Все подключённые аккаунты уже проголосовали сегодня.';
  } else {
    status.textContent = errors ? 'Нужна проверка' : 'В работе';
    status.className = errors
      ? 'module-state module-state--error'
      : 'module-state module-state--attention';
    automationLabel.textContent = errors ? 'Есть ошибки' : 'Голосуем';
    document.getElementById('overview-summary').textContent = errors
      ? `Готово ${voted}/${healthy.length} · ошибок ${errors}`
      : `Готово ${voted}/${healthy.length} · оставшиеся голоса отправляются автоматически.`;
  }
  document.getElementById('overview-checked-at').textContent = data.checkedAt
    ? `Последняя проверка ${formatHubDate(data.checkedAt)}`
    : 'После первого ввода мастер-пароля';
}

async function loadDiscoverMaintenance(options = {}) {
  try {
    const data = await apiGet('/api/discover/maintenance');
    applyDiscoverSnapshot(data);
    if (data.state === 'checking') {
      if (discoverRefreshTimer) window.clearTimeout(discoverRefreshTimer);
      discoverRefreshTimer = window.setTimeout(() => {
        discoverRefreshTimer = null;
        void loadDiscoverMaintenance({ quiet: true });
      }, 2_000);
    }
    return data;
  } catch (error) {
    if (!options.quiet) showError(error);
    return null;
  }
}

window.addEventListener('abstract-hub:vault-unlocked', () => {
  protectedTabLoads.clear();
  if (['inventory', 'skills', 'badges', 'cambria', 'tollan'].includes(currentTab)) {
    void loadProtectedTab(currentTab, true);
  }
  window.setTimeout(() => void loadDiscoverMaintenance({ quiet: true }), 250);
});

document.getElementById('btn-overview-refresh').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    setButtonBusy(button, true, 'Проверяем');
    await Promise.all([loadHubInfo(true), loadDiscoverMaintenance()]);
  } finally {
    setButtonBusy(button, false);
  }
});

// ── Abstract flash badges ───────────────────────────────────────────────────

let activeBadgeCampaign = null;
let badgeAccountsCache = [];
let badgeRecoveryTimer = null;
let badgeStatusLoading = false;
const BADGE_MAX_SPEND_KEY = 'abstract-hub:badge-max-spend-v1';

function badgePassword() {
  return document.getElementById('badges-password').value;
}

function badgeMaxSpendEth() {
  const input = document.getElementById('badges-max-spend');
  const value = input.value.trim().replace(',', '.');
  const amount = Number(value);
  if (
    !/^\d+(?:\.\d{1,18})?$/.test(value) ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 0.01
  ) {
    throw new Error('Лимит покупки должен быть больше 0 и не выше 0.01 ETH');
  }
  input.value = value;
  return value;
}

function applyBadgeCampaign(campaign) {
  if (!campaign) return;
  activeBadgeCampaign = campaign;
  document.querySelector('.badge-campaign-mark').dataset.badgeId = String(campaign.id);
  document.getElementById('badge-campaign-name').textContent = campaign.name;
  document.getElementById('badge-campaign-requirement').textContent =
    campaign.action === 'gigaverse_racing_consumable'
      ? 'Покупка предмета, ставка в Live Race и клейм выполняются одной операцией.'
      : campaign.requirement;
  updateBadgeCountdown();
}

function badgeCampaignClosed() {
  if (!activeBadgeCampaign) return false;
  const endsAt = new Date(activeBadgeCampaign.endsAt).getTime();
  return Number.isFinite(endsAt) && Date.now() >= endsAt;
}

function stopBadgeRecovery() {
  if (badgeRecoveryTimer) window.clearTimeout(badgeRecoveryTimer);
  badgeRecoveryTimer = null;
  setBackgroundActivity('badges', false);
}

function updateBadgeCountdown() {
  if (!activeBadgeCampaign) return;
  const now = Date.now();
  const startsAt = new Date(activeBadgeCampaign.startsAt).getTime();
  const endsAt = new Date(activeBadgeCampaign.endsAt).getTime();
  const countdown = document.getElementById('badge-campaign-countdown');
  const state = document.getElementById('badge-campaign-state');
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
    countdown.textContent = '—';
    state.textContent = 'Нет данных';
    return;
  }
  if (now < startsAt) {
    countdown.textContent = formatHubDate(activeBadgeCampaign.startsAt);
    state.textContent = 'Скоро';
    state.className = 'strategy-badge strategy-badge--amber';
    return;
  }
  if (now >= endsAt) {
    countdown.textContent = 'Завершена';
    state.textContent = 'Закрыта';
    state.className = 'strategy-badge strategy-badge--amber';
    stopBadgeRecovery();
    const runButton = document.getElementById('btn-badges-run');
    if (runButton) runButton.disabled = true;
    return;
  }
  const runButton = document.getElementById('btn-badges-run');
  if (runButton && !runButton.classList.contains('is-loading')) runButton.disabled = false;
  const remainingMinutes = Math.max(1, Math.ceil((endsAt - now) / 60_000));
  const days = Math.floor(remainingMinutes / 1_440);
  const hours = Math.floor((remainingMinutes % 1_440) / 60);
  const minutes = remainingMinutes % 60;
  countdown.textContent = days > 0 ? `${days}д ${hours}ч` : `${hours}ч ${minutes}м`;
  state.textContent = 'Активна';
  state.className = 'strategy-badge';
}

function badgeStatusMeta(account) {
  const states = {
    claimed: { label: 'Получен', className: 'module-state--ready' },
    processing: { label: 'В работе', className: 'module-state--attention' },
    ready_to_claim: { label: 'Завершаем клейм', className: 'module-state--attention' },
    action_done: { label: 'Завершаем клейм', className: 'module-state--attention' },
    claim_submitted: { label: 'Клейм отправлен', className: 'module-state--attention' },
    purchase_submitted: { label: 'Покупка отправлена', className: 'module-state--attention' },
    watching_race: { label: 'Гонка идёт', className: 'module-state--attention' },
    indexing: { label: 'Portal индексирует', className: 'module-state--attention' },
    rate_limited: { label: 'Клейм обрабатывается', className: 'module-state--attention' },
    action_unverified: { label: 'Повторить условие', className: 'module-state--limited' },
    pending_review: { label: 'Проверяем', className: 'module-state--attention' },
    needs_purchase: { label: 'Купит автоматически', className: 'module-state--attention' },
    market_empty: { label: 'Нет листингов', className: 'module-state--limited' },
    waiting_race: { label: 'Ждём Live Race', className: 'module-state--attention' },
    stopped: { label: 'Остановлено', className: 'module-state--limited' },
    ready: { label: 'Готов', className: 'module-state--ready' },
    error: { label: 'Ошибка', className: 'module-state--error' },
  };
  return states[account.status] ?? states.error;
}

function badgeAccountDetail(account) {
  if (account.status === 'error') return account.error || 'Операция завершилась с ошибкой.';
  if (account.status === 'processing') {
    return 'Подождите немного. Хаб продолжает работу автоматически.';
  }
  if (account.status === 'watching_race') {
    return 'Подождите немного. Хаб следит за применением предмета и завершением гонки.';
  }
  if (account.status === 'indexing') {
    return 'Gigaverse подтвердил применение предмета. Ждём индексацию условия в Portal перед клеймом.';
  }
  if (account.status === 'rate_limited') {
    const mins = Math.max(1, Math.ceil(Number(account.retryAfterMs || 300_000) / 60_000));
    return `Portal/Privy rate limit (429). Пауза ~${mins} мин — частые повторы только ухудшают. Хаб продолжит сам.`;
  }
  if (account.status === 'action_unverified') {
    return 'Прошлая версия остановилась на статусе ITEM QUEUED. Условие не подтверждено; хаб выполнит Racing-действие заново.';
  }
  if (account.claimError) {
    return `Клейм: ${account.claimError}. Racing-предмет повторно не тратится — хаб повторит claim и mint сам.`;
  }
  if (account.status === 'claimed') return 'Бейдж подтверждён в Abstract Portal.';
  if (['ready_to_claim', 'action_done'].includes(account.status)) {
    return 'Racing-действие подтверждено. Хаб сам запрашивает подпись в Portal и минтит бейдж on-chain.';
  }
  if (account.status === 'claim_submitted') {
    return 'Транзакция клейма отправлена. Проверяем появление бейджа в Portal.';
  }
  if (account.status === 'purchase_submitted') {
    const price = account.purchase?.priceWei ? ` за ${formatWei(account.purchase.priceWei)}` : '';
    return `Покупка отправлена${price}. Ждём предмет в инвентаре и продолжим.`;
  }
  if (account.status === 'pending_review') {
    return 'Подождите немного. Gigaverse подтверждает результат операции.';
  }
  if (account.status === 'needs_purchase') {
    const floor = account.inventory?.marketFloorWei ?? account.marketFloorWei;
    return floor
      ? `Предмета нет. Хаб купит самый дешёвый Dung/Butterfly за ${formatWei(floor)}.`
      : 'Предмета нет. Хаб найдёт минимальный листинг перед покупкой.';
  }
  if (account.status === 'market_empty') return 'Сейчас на рынке нет Dung или Butterfly.';
  if (account.status === 'waiting_race') {
    return 'Хаб ждёт подходящую Live Race и продолжит сам. Ничего делать не нужно.';
  }
  const selected = account.inventory?.selected;
  if (selected) {
    const floor = selected.floorWei ? ` · floor ${formatWei(selected.floorWei)}` : '';
    return `${selected.kind} #${selected.itemId}${floor}`;
  }
  return 'Готов к Racing-действию.';
}

function addBadgeMetric(container, label, value) {
  const metric = document.createElement('div');
  const small = document.createElement('span');
  const strong = document.createElement('strong');
  small.textContent = label;
  strong.textContent = value;
  metric.append(small, strong);
  container.appendChild(metric);
}

function renderBadgeRows(accounts) {
  const container = document.getElementById('badges-results');
  container.replaceChildren();
  for (const [index, account] of accounts.entries()) {
    const row = document.createElement('article');
    row.className = 'badge-account';
    row.dataset.state = account.status || 'error';
    row.style.setProperty('--list-delay', `${index * 70}ms`);

    const head = document.createElement('div');
    head.className = 'badge-account-head';
    const identity = document.createElement('div');
    const mark = document.createElement('span');
    mark.className = 'badge-account-mark';
    const logo = document.createElement('img');
    logo.src = 'assets/gigaverse-logo.png';
    logo.alt = '';
    mark.appendChild(logo);
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    const address = document.createElement('small');
    name.textContent = account.displayName || account.name || account.alias || 'Abstract аккаунт';
    address.textContent = account.address
      ? `${account.address.slice(0, 8)}...${account.address.slice(-6)}`
      : 'Адрес не определён';
    copy.append(name, address);
    identity.append(mark, copy);
    const meta = badgeStatusMeta(account);
    const state = document.createElement('span');
    state.className = `module-state ${meta.className}`;
    state.textContent = meta.label;
    head.append(identity, state);

    const metrics = document.createElement('div');
    metrics.className = 'badge-account-metrics';
    addBadgeMetric(metrics, 'Dung', String(account.inventory?.dung ?? 0));
    addBadgeMetric(metrics, 'Butterfly', String(account.inventory?.butterfly ?? 0));
    addBadgeMetric(metrics, 'Live Race', String(account.liveRaces ?? 0));

    const detail = document.createElement('p');
    detail.className = account.status === 'error' ? 'badge-account-error' : 'badge-account-detail';
    detail.textContent = badgeAccountDetail(account);

    const actionSlot = document.createElement('div');
    actionSlot.className = 'badge-account-action';
    const automaticStates = new Set(['ready', 'needs_purchase', 'action_unverified', 'error']);
    const campaignClosed =
      account.status === 'error' && /кампания .*завершена/i.test(String(account.error || ''));
    if (automaticStates.has(account.status) && !campaignClosed) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className =
        account.status === 'ready' || account.status === 'needs_purchase'
          ? 'btn btn--primary'
          : 'btn btn--secondary';
      const labels = {
        ready: 'Получить',
        needs_purchase: 'Купить и получить',
        action_unverified: 'Повторить условие',
        error: 'Повторить',
      };
      action.textContent = labels[account.status] || 'Продолжить';
      action.addEventListener('click', () => void runRacingBadge(account.alias, action));
      actionSlot.appendChild(action);
    }

    row.append(head, metrics, detail, actionSlot);
    container.appendChild(row);
  }
  wireSpecularButtons(container);
}

function mergeBadgeAccounts(changes) {
  if (badgeAccountsCache.length === 0) return changes;
  const merged = badgeAccountsCache.map((existing) => {
    const replacement = changes.find(
      (account) =>
        (account.address &&
          existing.address &&
          account.address.toLowerCase() === existing.address.toLowerCase()) ||
        account.alias === existing.alias,
    );
    if (!replacement) return existing;
    const displayName =
      replacement.displayName && replacement.displayName !== replacement.alias
        ? replacement.displayName
        : existing.displayName;
    return { ...existing, ...replacement, ...(displayName ? { displayName } : {}) };
  });
  for (const account of changes) {
    if (!merged.some((existing) => existing.alias === account.alias)) merged.push(account);
  }
  return merged;
}

function applyBadgeSnapshot(data, merge = false) {
  if (data.campaign) applyBadgeCampaign(data.campaign);
  setExternalHref('badge-rewards-link', data.rewardsUrl);
  setExternalHref('badge-marketplace-link', data.marketplaceUrl);
  const incoming = Array.isArray(data.accounts) ? data.accounts : [];
  badgeAccountsCache = merge ? mergeBadgeAccounts(incoming) : incoming;
  renderBadgeRows(badgeAccountsCache);
  const claimed = badgeAccountsCache.filter((account) => account.status === 'claimed').length;
  const inProgress = badgeAccountsCache.filter((account) =>
    [
      'ready_to_claim',
      'action_done',
      'claim_submitted',
      'purchase_submitted',
      'processing',
      'pending_review',
      'waiting_race',
      'watching_race',
      'indexing',
      'rate_limited',
      'action_unverified',
    ].includes(account.status),
  ).length;
  const errors = badgeAccountsCache.filter((account) => account.status === 'error').length;
  const campaignClosed = badgeCampaignClosed();
  document.getElementById('badge-status-text').textContent = campaignClosed
    ? `Кампания завершена · получено ${claimed}/${badgeAccountsCache.length}`
    : `Получено ${claimed}/${badgeAccountsCache.length} · в работе ${inProgress}` +
      (errors ? ` · ошибок ${errors}` : '');
  setBackgroundActivity('badges', !campaignClosed && inProgress > 0);
  if (campaignClosed) stopBadgeRecovery();
  else scheduleBadgeRecovery();
}

function scheduleBadgeRecovery() {
  if (badgeRecoveryTimer) window.clearTimeout(badgeRecoveryTimer);
  badgeRecoveryTimer = null;
  if (badgeCampaignClosed()) {
    setBackgroundActivity('badges', false);
    return;
  }
  const pending = badgeAccountsCache.filter((account) =>
    [
      'ready_to_claim',
      'action_done',
      'claim_submitted',
      'processing',
      'pending_review',
      'waiting_race',
      'purchase_submitted',
      'watching_race',
      'indexing',
      'rate_limited',
    ].includes(account.status),
  );
  if (pending.length === 0 || !badgePassword()) return;
  const rateLimited = pending.some((account) => account.status === 'rate_limited');
  // Never poll faster than 90s; rate-limited accounts force a multi-minute cool-down.
  const delay = Math.max(
    rateLimited ? 5 * 60_000 : 90_000,
    Math.min(
      30 * 60_000,
      ...pending.map((account) => {
        const requested = Number(account.retryAfterMs);
        if (account.status === 'rate_limited') {
          return Number.isFinite(requested) && requested > 0 ? requested : 5 * 60_000;
        }
        return Number.isFinite(requested) && requested > 0 ? requested : 90_000;
      }),
    ),
  );
  badgeRecoveryTimer = window.setTimeout(() => {
    badgeRecoveryTimer = null;
    void loadRacingBadgeStatus({ quiet: true });
  }, delay);
}

async function loadRacingBadgeStatus(options = {}) {
  if (badgeStatusLoading) return null;
  const password = badgePassword();
  if (!password) {
    if (!options.quiet) {
      showToast('Нужен пароль', 'Введите мастер-пароль для проверки бейджей.', 'error');
    }
    return null;
  }
  badgeStatusLoading = true;
  const loading = document.getElementById('badges-loading');
  loading.hidden = false;
  updateActivityIndicators();
  document.getElementById('badges-loading-text').textContent = 'Проверяем Racing и Portal';
  try {
    const data = await apiPost('/api/badges/racing/status', { password }, { timeoutMs: 330_000 });
    applyBadgeSnapshot(data);
    return data;
  } catch (error) {
    if (!options.quiet) showError(error);
    else scheduleBadgeRecovery();
    return null;
  } finally {
    badgeStatusLoading = false;
    loading.hidden = true;
    updateActivityIndicators();
  }
}

async function runRacingBadge(accountAlias, button) {
  if (badgeCampaignClosed()) {
    showToast('Кампания завершена', 'Эта кампания больше не принимает действия.', 'error');
    stopBadgeRecovery();
    return null;
  }
  const password = badgePassword();
  if (!password) {
    showToast('Нужен пароль', 'Введите мастер-пароль для выполнения Racing.', 'error');
    return null;
  }
  let maxSpendEth;
  try {
    maxSpendEth = badgeMaxSpendEth();
  } catch (error) {
    showError(error);
    return null;
  }
  const cachedAccount = accountAlias
    ? badgeAccountsCache.find((account) => account.alias === accountAlias)
    : null;
  const recoveryOnly = Boolean(
    (cachedAccount?.localAction?.state === 'completed' && cachedAccount?.localAction?.verifiedAt) ||
    ['ready_to_claim', 'action_done', 'claim_submitted'].includes(cachedAccount?.status),
  );
  const scope = accountAlias ? 'для выбранного аккаунта' : 'для каждого подходящего аккаунта';
  const confirmation = recoveryOnly
    ? 'Повторить только Portal-клейм? Предмет не будет куплен или потрачен повторно.'
    : `Хаб может купить один Dung/Butterfly до ${maxSpendEth} ETH ${scope}, поставить его в Live Race и заклеймить бейдж. Продолжить?`;
  if (!window.confirm(confirmation)) {
    return null;
  }
  const mainButton = document.getElementById('btn-badges-run');
  const activeButton = button || mainButton;
  const loading = document.getElementById('badges-loading');
  loading.hidden = false;
  updateActivityIndicators();
  document.getElementById('badges-loading-text').textContent = recoveryOnly
    ? 'Повторяем Portal-клейм без расхода предмета'
    : 'Покупаем предмет, проводим Live Race и клеймим бейдж';
  try {
    setButtonBusy(activeButton, true, 'Получаем');
    const data = await apiPost(
      '/api/badges/racing/run',
      { password, maxSpendEth, ...(accountAlias ? { accountAlias } : {}) },
      { timeoutMs: 360_000 },
    );
    applyBadgeSnapshot(data, true);
    const completed = data.accounts.filter((account) => account.status === 'claimed').length;
    const pending = data.accounts.filter((account) =>
      [
        'claim_submitted',
        'purchase_submitted',
        'ready_to_claim',
        'action_done',
        'processing',
        'pending_review',
        'waiting_race',
        'watching_race',
        'indexing',
        'rate_limited',
      ].includes(account.status),
    ).length;
    const failures = data.accounts.filter((account) => account.status === 'error').length;
    if (completed > 0) {
      showToast('Бейдж получен', `${completed} аккаунт(ов) подтверждено в Abstract Portal.`);
    } else if (pending > 0) {
      showToast('Операция отправлена', `${pending} аккаунт(ов) ожидают подтверждения.`);
      scheduleBadgeRecovery();
    } else if (failures > 0) {
      showToast(
        'Получение завершено с ошибками',
        `${failures} аккаунт(ов) требуют проверки.`,
        'error',
      );
    } else {
      showToast('Изменений нет', 'Проверьте статусы аккаунтов в таблице.');
    }
    return data;
  } catch (error) {
    showError(error);
    return null;
  } finally {
    loading.hidden = true;
    setButtonBusy(activeButton, false);
    updateActivityIndicators();
  }
}

document.getElementById('btn-badges-refresh').addEventListener('click', () => {
  void loadRacingBadgeStatus();
});

document.getElementById('form-badges').addEventListener('submit', (event) => {
  event.preventDefault();
  void runRacingBadge();
});

const badgeMaxSpendInput = document.getElementById('badges-max-spend');
badgeMaxSpendInput.value = window.localStorage.getItem(BADGE_MAX_SPEND_KEY) || '0.00005';
badgeMaxSpendInput.addEventListener('input', () => {
  const value = badgeMaxSpendInput.value.trim();
  if (value) window.localStorage.setItem(BADGE_MAX_SPEND_KEY, value);
  else window.localStorage.removeItem(BADGE_MAX_SPEND_KEY);
});

// ── Cambria Genesis loot ────────────────────────────────────────────────────

const CAMBRIA_INVITE_KEY = 'abstract-hub:cambria-invite-v1';
let cambriaAccountsCache = [];
let cambriaRecoveryTimer = null;
let cambriaRequestInFlight = false;

function setCambriaRequestInFlight(active) {
  cambriaRequestInFlight = active;
  for (const id of ['btn-cambria-refresh', 'btn-cambria-claim']) {
    const button = document.getElementById(id);
    if (!button) continue;
    if (active) button.disabled = true;
    else if (!button.classList.contains('is-loading')) button.disabled = false;
  }
  updateActivityIndicators();
}

function rejectConcurrentCambria(options = {}) {
  if (!cambriaRequestInFlight) return false;
  if (!options.quiet) {
    showToast(
      'Cambria уже работает',
      'Дождитесь текущей проверки. Хаб не будет отправлять второй набор запросов.',
      'error',
    );
  }
  return true;
}

function cambriaPassword() {
  return document.getElementById('cambria-password')?.value ?? '';
}

function cambriaInviteCode() {
  return document.getElementById('cambria-invite')?.value.trim() ?? '';
}

function formatHubNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(number);
}

function cambriaStatusMeta(account) {
  const states = {
    ready: { label: 'Можно забрать', className: 'module-state--attention' },
    claimed: { label: 'Получено', className: 'module-state--ready' },
    already_claimed: { label: 'Получено', className: 'module-state--ready' },
    not_eligible: { label: 'Нет аллокации', className: 'module-state--limited' },
    empty: { label: 'Нет сундуков', className: 'module-state--limited' },
    disabled: { label: 'Клейм закрыт', className: 'module-state--limited' },
    needs_invite: { label: 'Нужен инвайт', className: 'module-state--attention' },
    needs_verification: { label: 'Нужна проверка', className: 'module-state--attention' },
    rate_limited: { label: 'Ждём Cambria', className: 'module-state--limited' },
    error: { label: 'Ошибка', className: 'module-state--error' },
  };
  return states[account.status] ?? states.error;
}

function cambriaChestSummary(loot) {
  if (!loot?.chests) return '—';
  return `${loot.chests.common ?? 0} / ${loot.chests.epic ?? 0} / ${loot.chests.legendary ?? 0}`;
}

function cambriaAccountDetail(account) {
  if (account.status === 'rate_limited') {
    const mins = Math.max(1, Math.ceil(Number(account.retryAfterMs || 180_000) / 60_000));
    return `Cambria/Privy rate limit (429). Пауза ~${mins} мин. Не жми «Проверить» — хаб повторит сам.`;
  }
  if (account.status === 'needs_verification') {
    return 'Нужна Cloudflare Turnstile. Добавь CapSolver API key или заверши проверку один раз в обычном браузере.';
  }
  if (account.error) return account.error;
  if (account.status === 'ready') return 'Аллокация подтверждена, сундуки готовы к получению.';
  if (['claimed', 'already_claimed'].includes(account.status)) {
    return 'Genesis Loot уже получен на этом аккаунте.';
  }
  if (account.status === 'not_eligible')
    return 'Cambria не нашла подходящую активность для этой раздачи.';
  if (account.status === 'empty') return 'Аккаунт подходит, но в текущем расчёте нет сундуков.';
  if (account.status === 'disabled') return 'Cambria временно не принимает запросы на получение.';
  if (account.status === 'needs_invite') {
    return 'Введите инвайт-код первого входа. После регистрации он больше не понадобится.';
  }
  return 'Статус Cambria не определён.';
}

function addCambriaMetric(container, label, value) {
  const metric = document.createElement('div');
  const small = document.createElement('span');
  const strong = document.createElement('strong');
  small.textContent = label;
  strong.textContent = value;
  metric.append(small, strong);
  container.appendChild(metric);
}

function renderCambriaRows(accounts) {
  const container = document.getElementById('cambria-results');
  container.replaceChildren();
  for (const [index, account] of accounts.entries()) {
    const row = document.createElement('article');
    row.className = 'cambria-account';
    row.dataset.state = account.status || 'error';
    row.style.setProperty('--list-delay', `${index * 70}ms`);

    const head = document.createElement('div');
    head.className = 'cambria-account-head';
    const identity = document.createElement('div');
    const mark = document.createElement('span');
    mark.className = 'cambria-account-mark';
    const logo = document.createElement('img');
    logo.src = 'assets/cambria-logo.png';
    logo.alt = '';
    mark.appendChild(logo);
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    const address = document.createElement('small');
    name.textContent = account.name || account.alias || 'Abstract аккаунт';
    address.textContent = account.address
      ? `${account.address.slice(0, 8)}...${account.address.slice(-6)}`
      : 'Адрес не определён';
    copy.append(name, address);
    identity.append(mark, copy);
    const meta = cambriaStatusMeta(account);
    const state = document.createElement('span');
    state.className = `module-state ${meta.className}`;
    state.textContent = meta.label;
    head.append(identity, state);

    const metrics = document.createElement('div');
    metrics.className = 'cambria-account-metrics';
    addCambriaMetric(metrics, 'Points', formatHubNumber(account.points?.points));
    addCambriaMetric(
      metrics,
      'Rank',
      account.points?.rank ? `#${formatHubNumber(account.points.rank)}` : '—',
    );
    addCambriaMetric(metrics, 'Score', formatHubNumber(account.loot?.scores?.total));
    addCambriaMetric(metrics, 'C / E / L', cambriaChestSummary(account.loot));

    const detail = document.createElement('p');
    detail.className = account.error ? 'cambria-account-error' : 'cambria-account-detail';
    detail.textContent = cambriaAccountDetail(account);

    const quests = document.createElement('span');
    quests.className = 'cambria-quest-progress';
    const questList = Array.isArray(account.quests) ? account.quests : [];
    const completed = questList.filter((quest) => quest.completed).length;
    quests.textContent =
      questList.length > 0 ? `Квесты ${completed}/${questList.length}` : 'Квесты —';

    const actionSlot = document.createElement('div');
    actionSlot.className = 'cambria-account-action';
    if (account.status === 'ready') {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'btn btn--primary';
      action.textContent = 'Забрать';
      action.addEventListener('click', () => void runCambriaClaim(account.alias, action));
      actionSlot.appendChild(action);
    } else if (account.status === 'needs_verification') {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'btn btn--secondary';
      action.textContent = 'Завершить вход';
      action.addEventListener('click', () => void verifyCambriaAccount(account.alias, action));
      actionSlot.appendChild(action);
    }

    row.append(head, metrics, detail, quests, actionSlot);
    container.appendChild(row);
  }
}

function mergeCambriaAccounts(changes) {
  if (cambriaAccountsCache.length === 0) return changes;
  const merged = cambriaAccountsCache.map((existing) => {
    const replacement = changes.find(
      (account) =>
        (account.address &&
          existing.address &&
          account.address.toLowerCase() === existing.address.toLowerCase()) ||
        account.alias === existing.alias,
    );
    return replacement ? { ...existing, ...replacement } : existing;
  });
  for (const account of changes) {
    if (!merged.some((existing) => existing.alias === account.alias)) merged.push(account);
  }
  return merged;
}

function applyCambriaSnapshot(data, merge = false) {
  const incoming = Array.isArray(data.accounts) ? data.accounts : [];
  cambriaAccountsCache = merge ? mergeCambriaAccounts(incoming) : incoming;
  renderCambriaRows(cambriaAccountsCache);
  const claimed = cambriaAccountsCache.filter((account) =>
    ['claimed', 'already_claimed'].includes(account.status),
  ).length;
  const ready = cambriaAccountsCache.filter((account) => account.status === 'ready').length;
  const errors = cambriaAccountsCache.filter((account) =>
    ['error', 'needs_invite', 'needs_verification'].includes(account.status),
  ).length;
  const rateLimited = cambriaAccountsCache.filter(
    (account) => account.status === 'rate_limited',
  ).length;
  document.getElementById('cambria-status-text').textContent =
    `Получено ${claimed}/${cambriaAccountsCache.length} · доступно ${ready}` +
    (errors ? ` · требуют внимания ${errors}` : '');
  const overviewState = document.getElementById('overview-cambria-state');
  overviewState.textContent = errors
    ? 'Нужна проверка'
    : rateLimited
      ? 'Ожидаем API'
      : ready
        ? `${ready} доступно`
        : 'Проверено';
  overviewState.className = errors
    ? 'module-state module-state--error'
    : rateLimited
      ? 'module-state module-state--limited'
      : ready
        ? 'module-state module-state--attention'
        : 'module-state module-state--ready';
  setBackgroundActivity('cambria', rateLimited > 0);
  scheduleCambriaRecovery();
}

function scheduleCambriaRecovery() {
  if (cambriaRecoveryTimer) window.clearTimeout(cambriaRecoveryTimer);
  cambriaRecoveryTimer = null;
  const pending = cambriaAccountsCache.filter((account) => account.status === 'rate_limited');
  if (pending.length === 0 || !cambriaPassword()) return;
  // Auto-retry was re-logging into Privy every ~10–60s and deepening the 429 hole.
  const delay = Math.max(
    3 * 60_000,
    Math.min(
      15 * 60_000,
      ...pending.map((account) => {
        const requested = Number(account.retryAfterMs);
        return Number.isFinite(requested) && requested > 0 ? requested : 3 * 60_000;
      }),
    ),
  );
  cambriaRecoveryTimer = window.setTimeout(() => {
    cambriaRecoveryTimer = null;
    void loadCambriaStatus({ quiet: true });
  }, delay);
}

async function verifyCambriaAccount(accountAlias, button) {
  if (rejectConcurrentCambria()) return null;
  const password = cambriaPassword();
  if (!password) {
    showToast('Нужен пароль', 'Введите мастер-пароль для Cambria.', 'error');
    return null;
  }
  const loading = document.getElementById('cambria-loading');
  loading.hidden = false;
  setCambriaRequestInFlight(true);
  document.getElementById('cambria-loading-text').textContent =
    'Открываем Cambria в обычном браузере';
  try {
    setButtonBusy(button, true, 'Подключаем');
    const inviteCode = cambriaInviteCode();
    const data = await apiPost(
      '/api/cambria/status',
      { password, accountAlias, ...(inviteCode ? { inviteCode } : {}) },
      { timeoutMs: 360_000 },
    );
    applyCambriaSnapshot(data, true);
    const verified = data.accounts.some(
      (account) => !['error', 'needs_verification'].includes(account.status),
    );
    showToast(
      verified ? 'Cambria подключена' : 'Проверка не завершена',
      verified ? 'Постоянная сессия сохранена.' : 'Завершите проверку в официальном окне.',
      verified ? 'success' : 'error',
    );
    return data;
  } catch (error) {
    showError(error);
    return null;
  } finally {
    loading.hidden = true;
    setButtonBusy(button, false);
    setCambriaRequestInFlight(false);
  }
}

async function loadCambriaStatus(options = {}) {
  if (rejectConcurrentCambria(options)) return null;
  const password = cambriaPassword();
  if (!password) {
    if (!options.quiet) showToast('Нужен пароль', 'Введите мастер-пароль для Cambria.', 'error');
    return null;
  }
  const loading = document.getElementById('cambria-loading');
  loading.hidden = false;
  setCambriaRequestInFlight(true);
  document.getElementById('cambria-loading-text').textContent = 'Проверяем Genesis Loot';
  try {
    const inviteCode = cambriaInviteCode();
    const data = await apiPost(
      '/api/cambria/status',
      { password, ...(inviteCode ? { inviteCode } : {}) },
      { timeoutMs: 360_000 },
    );
    applyCambriaSnapshot(data);
    return data;
  } catch (error) {
    if (!options.quiet) showError(error);
    return null;
  } finally {
    loading.hidden = true;
    setCambriaRequestInFlight(false);
  }
}

async function runCambriaClaim(accountAlias, button) {
  if (rejectConcurrentCambria()) return null;
  const password = cambriaPassword();
  if (!password) {
    showToast('Нужен пароль', 'Введите мастер-пароль для получения сундуков.', 'error');
    return null;
  }
  const scope = accountAlias ? 'на выбранном аккаунте' : 'на всех подходящих аккаунтах';
  if (!window.confirm(`Забрать доступные сундуки Cambria ${scope}?`)) return null;
  const activeButton = button || document.getElementById('btn-cambria-claim');
  const loading = document.getElementById('cambria-loading');
  loading.hidden = false;
  setCambriaRequestInFlight(true);
  document.getElementById('cambria-loading-text').textContent = 'Получаем сундуки';
  try {
    setButtonBusy(activeButton, true, 'Получаем');
    const inviteCode = cambriaInviteCode();
    const data = await apiPost(
      '/api/cambria/claim',
      {
        password,
        ...(inviteCode ? { inviteCode } : {}),
        ...(accountAlias ? { accountAlias } : {}),
      },
      { timeoutMs: 360_000 },
    );
    applyCambriaSnapshot(data, true);
    const claimed = data.accounts.filter((account) => account.status === 'claimed').length;
    const failures = data.accounts.filter((account) =>
      ['error', 'needs_verification', 'needs_invite'].includes(account.status),
    ).length;
    if (claimed > 0) {
      showToast('Сундуки получены', `${claimed} аккаунт(ов) обработано.`);
    } else if (failures > 0) {
      showToast(
        'Cambria завершена с ошибками',
        `${failures} аккаунт(ов) требуют проверки.`,
        'error',
      );
    } else {
      showToast('Новых сундуков нет', 'Статусы аккаунтов обновлены.');
    }
    window.setTimeout(() => void loadCambriaStatus({ quiet: true }), 1_500);
    return data;
  } catch (error) {
    showError(error);
    return null;
  } finally {
    loading.hidden = true;
    setButtonBusy(activeButton, false);
    setCambriaRequestInFlight(false);
  }
}

document.getElementById('btn-cambria-refresh').addEventListener('click', () => {
  void loadCambriaStatus();
});

document.getElementById('form-cambria').addEventListener('submit', (event) => {
  event.preventDefault();
  void runCambriaClaim();
});

const cambriaInviteInput = document.getElementById('cambria-invite');
cambriaInviteInput.value = window.localStorage.getItem(CAMBRIA_INVITE_KEY) ?? '';
cambriaInviteInput.addEventListener('input', () => {
  const value = cambriaInviteInput.value.trim();
  if (value) window.localStorage.setItem(CAMBRIA_INVITE_KEY, value);
  else window.localStorage.removeItem(CAMBRIA_INVITE_KEY);
});

// ── Tollan Practice ─────────────────────────────────────────────────────────

let tollanAccountsCache = [];
let tollanPollTimer;

function tollanPassword() {
  return document.getElementById('tollan-password')?.value ?? '';
}

function tollanStateMeta(state) {
  return (
    {
      idle: ['Готов', 'ready'],
      queued: ['В очереди', 'active'],
      loading: ['Загрузка', 'active'],
      starting: ['Запуск', 'active'],
      playing: ['В забеге', 'active'],
      completed: ['Готово', 'success'],
      failed: ['Ошибка', 'error'],
      stopped: ['Остановлен', 'neutral'],
      needs_auth: ['Нужен вход', 'warning'],
    }[state] ?? ['Ожидание', 'neutral']
  );
}

function hasActiveTollanRuns() {
  return tollanAccountsCache.some((account) =>
    ['queued', 'loading', 'starting', 'playing'].includes(account.state),
  );
}

function scheduleTollanPoll() {
  window.clearTimeout(tollanPollTimer);
  if (!hasActiveTollanRuns()) return;
  tollanPollTimer = window.setTimeout(() => void loadTollanStatus({ quiet: true }), 2_500);
}

function renderTollanRows(accounts) {
  const container = document.getElementById('tollan-results');
  container.replaceChildren();
  for (const account of accounts) {
    const row = document.createElement('article');
    row.className = `tollan-account tollan-account--${account.state || 'idle'}`;

    const head = document.createElement('div');
    head.className = 'tollan-account-head';
    const mark = document.createElement('span');
    mark.className = 'tollan-account-mark';
    mark.textContent = String(account.displayName || account.alias || 'T')
      .slice(0, 1)
      .toUpperCase();
    const identity = document.createElement('div');
    identity.className = 'tollan-account-identity';
    const name = document.createElement('strong');
    name.textContent = account.displayName || account.alias || 'Abstract account';
    const address = document.createElement('small');
    const rawAddress = String(account.address || '');
    address.textContent = rawAddress
      ? `${rawAddress.slice(0, 8)}...${rawAddress.slice(-6)}`
      : 'Abstract';
    identity.append(name, address);
    const [stateLabel, stateTone] = tollanStateMeta(account.state);
    const badge = document.createElement('span');
    badge.className = `tollan-account-state tollan-account-state--${stateTone}`;
    badge.textContent = stateLabel;
    head.append(mark, identity, badge);

    const progress = document.createElement('div');
    progress.className = 'tollan-run-progress';
    const progressCopy = document.createElement('div');
    const progressTitle = document.createElement('strong');
    progressTitle.textContent =
      account.state === 'playing'
        ? `Волна ${account.wave || 1}`
        : account.message || tollanStateMeta(account.state)[0];
    const progressDetail = document.createElement('small');
    progressDetail.textContent =
      account.reward ||
      account.error ||
      (account.connected ? 'Practice · официальный клиент' : 'Tollan');
    progressCopy.append(progressTitle, progressDetail);
    const track = document.createElement('div');
    track.className = 'tollan-wave-track';
    const fill = document.createElement('span');
    fill.style.width = `${Math.min(100, Math.max(4, Number(account.wave || 0) * 7))}%`;
    track.append(fill);
    progress.append(progressCopy, track);

    const actions = document.createElement('div');
    actions.className = 'tollan-account-actions';
    if (account.state === 'needs_auth') {
      const reconnect = document.createElement('button');
      reconnect.type = 'button';
      reconnect.className = 'btn btn--secondary';
      reconnect.textContent = 'Подключить Tollan';
      reconnect.addEventListener('click', () => {
        showTab('accounts');
        showToast(
          'Единичное подтверждение',
          `Переподключите ${account.displayName || 'этот аккаунт'} через Abstract.`,
        );
      });
      actions.append(reconnect);
    } else if (['queued', 'loading', 'starting', 'playing'].includes(account.state)) {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'btn btn--quiet';
      stop.textContent = 'Остановить';
      stop.addEventListener('click', () => void stopTollan(account.alias, stop));
      actions.append(stop);
    } else {
      const run = document.createElement('button');
      run.type = 'button';
      run.className = 'btn btn--secondary';
      run.textContent = account.state === 'completed' ? 'Ещё забег' : 'Запустить';
      run.addEventListener('click', () => void runTollan(account.alias, run));
      actions.append(run);
    }

    row.append(head, progress, actions);
    container.append(row);
  }
}

function applyTollanSnapshot(data) {
  tollanAccountsCache = Array.isArray(data.accounts) ? data.accounts : [];
  renderTollanRows(tollanAccountsCache);
  const active = tollanAccountsCache.filter((account) =>
    ['queued', 'loading', 'starting', 'playing'].includes(account.state),
  ).length;
  const completed = tollanAccountsCache.filter((account) => account.state === 'completed').length;
  const needsAuth = tollanAccountsCache.filter((account) => account.state === 'needs_auth').length;
  const status = document.getElementById('tollan-status-text');
  const dot = document.getElementById('tollan-status-dot');
  status.textContent = active
    ? `Активно ${active} · завершено ${completed}`
    : needsAuth
      ? `Готово ${tollanAccountsCache.length - needsAuth}/${tollanAccountsCache.length} · нужен вход ${needsAuth}`
      : `Готово аккаунтов ${tollanAccountsCache.length} · завершено ${completed}`;
  dot.dataset.tone = active ? 'active' : needsAuth ? 'warning' : 'ready';
  document.getElementById('tollan-hero-status').textContent = active
    ? 'Practice выполняется в фоне · можно переключаться между разделами'
    : 'Официальный клиент · подтверждение результата сервером';
  const overview = document.getElementById('overview-tollan-state');
  if (overview) {
    overview.textContent = active ? `${active} в работе` : needsAuth ? 'Нужен вход' : 'Practice';
    overview.className = `module-state ${needsAuth ? 'module-state--attention' : 'module-state--ready'}`;
  }
  setBackgroundActivity('tollan', active > 0);
  scheduleTollanPoll();
}

async function loadTollanStatus(options = {}) {
  const password = tollanPassword();
  if (!password) {
    if (!options.quiet) showToast('Нужен пароль', 'Введите мастер-пароль.', 'error');
    return null;
  }
  const loading = document.getElementById('tollan-loading');
  if (!options.quiet) loading.hidden = false;
  try {
    const data = await apiPost('/api/tollan/status', { password });
    applyTollanSnapshot(data);
    return data;
  } catch (error) {
    if (!options.quiet) showError(error);
    return null;
  } finally {
    if (!options.quiet) loading.hidden = true;
  }
}

async function runTollan(accountAlias, button) {
  const password = tollanPassword();
  if (!password) {
    showToast('Нужен пароль', 'Введите мастер-пароль.', 'error');
    return;
  }
  const activeButton = button || document.getElementById('btn-tollan-run');
  setButtonBusy(activeButton, true, 'Запускаем');
  try {
    const data = await apiPost('/api/tollan/run', {
      password,
      ...(accountAlias ? { accountAlias } : {}),
    });
    applyTollanSnapshot(data);
    showToast(
      'Tollan запущен',
      accountAlias
        ? `${tollanAccountsCache.find((account) => account.alias === accountAlias)?.displayName || 'Аккаунт'} добавлен в очередь.`
        : 'Аккаунты добавлены в очередь.',
    );
  } catch (error) {
    showError(error);
  } finally {
    setButtonBusy(activeButton, false);
  }
}

async function stopTollan(accountAlias, button) {
  const password = tollanPassword();
  if (!password) return;
  setButtonBusy(button || document.getElementById('btn-tollan-stop'), true, 'Останавливаем');
  try {
    const data = await apiPost('/api/tollan/stop', {
      password,
      ...(accountAlias ? { accountAlias } : {}),
    });
    applyTollanSnapshot(data);
  } catch (error) {
    showError(error);
  } finally {
    setButtonBusy(button || document.getElementById('btn-tollan-stop'), false);
  }
}

document.getElementById('btn-tollan-refresh').addEventListener('click', () => {
  void loadTollanStatus();
});
document.getElementById('form-tollan').addEventListener('submit', (event) => {
  event.preventDefault();
  void runTollan();
});
document.getElementById('btn-tollan-stop').addEventListener('click', () => {
  void stopTollan();
});

// ── Init ─────────────────────────────────────────────────────────────────────

// Keep the current master password in memory while the window is open so the
// operator does not have to retype it on every tab. Nothing is persisted.
const sharedPasswordInputs = [
  'edit-password',
  'badges-password',
  'cambria-password',
  'tollan-password',
  'play-password',
  'inv-password',
  'skills-password',
]
  .map((id) => document.getElementById(id))
  .filter(Boolean);
for (const input of sharedPasswordInputs) {
  input.addEventListener('input', () => {
    for (const other of sharedPasswordInputs) {
      if (other !== input) other.value = input.value;
    }
  });
}

wireSpecularButtons();
new window.MutationObserver(() => wireSpecularButtons()).observe(document.body, {
  childList: true,
  subtree: true,
});
updateActivityIndicators();

(async () => {
  const status = await refreshStatus();
  if (!status) {
    showTab('accounts');
    await refreshAccountsSubpane();
    return;
  }
  if (status.hasSecrets) {
    showTab('overview');
    void loadDiscoverMaintenance({ quiet: true });
    if (!vaultSessionReady) {
      // Keychain restoration starts with the localhost server and can finish a
      // fraction later than the first renderer status request.
      for (const delay of [250, 750, 1_500]) {
        window.setTimeout(() => {
          if (!vaultSessionReady) void refreshStatus();
        }, delay);
      }
    }
    // If already running, open the SSE stream immediately so the log updates
    if (status.running) {
      openEvents();
      setPlaying(true);
    }
  } else {
    showTab('accounts');
    await refreshAccountsSubpane();
  }
  window.setInterval(() => void refreshStatus(), 10_000);
  window.setInterval(() => void loadDiscoverMaintenance({ quiet: true }), 10_000);
  window.setInterval(updateBadgeCountdown, 60_000);
})();
