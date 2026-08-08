import { initAbstractGlobalWallet } from '@abstract-foundation/agw-web';
import { stringToHex } from 'viem';
import { abstract } from 'viem/chains';
import { normalizeWalletAddress } from '../internal/src/shared/wallet-address.js';

interface RpcProvider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

interface Eip6963ProviderDetail {
  info: {
    rdns: string;
  };
  provider: RpcProvider;
}

interface CambriaAuthOperation {
  id: string;
  accountName: string;
  expectedAddress: string;
  developerMode: boolean;
  state: 'awaiting_browser' | 'completed' | 'failed';
  error?: string;
}

interface CambriaChallenge {
  address: string;
  message: string;
}

interface CambriaApproval {
  message: string;
  signature: string;
}

const pageMatch = /^\/cambria-auth\/([a-f0-9]{48})\/([a-f0-9]{48})\/?$/.exec(
  window.location.pathname,
);
const operationId = pageMatch?.[1];
const callbackSecret = pageMatch?.[2];

const accountName = requiredElement<HTMLElement>('auth-account-name');
const accountAddress = requiredElement<HTMLElement>('auth-account-address');
const status = requiredElement<HTMLElement>('auth-status');
const statusDot = requiredElement<HTMLElement>('auth-status-dot');
const actionButton = requiredElement<HTMLButtonElement>('cambria-action');
const switchButton = requiredElement<HTMLButtonElement>('cambria-switch');

let provider: RpcProvider | undefined;
let operation: CambriaAuthOperation | undefined;
let currentAddress: string | undefined;
let challenge: CambriaChallenge | undefined;
let challengePromise: Promise<CambriaChallenge> | undefined;
let pendingAuthResponse: CambriaApproval | undefined;
let busy = false;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing Cambria auth element: ${id}`);
  return element as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAddress(value: unknown): string | undefined {
  return normalizeWalletAddress(value);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function responseError(value: unknown, fallback: string): string {
  if (isRecord(value)) {
    if (typeof value['error'] === 'string' && value['error']) return value['error'];
    if (typeof value['message'] === 'string' && value['message']) return value['message'];
  }
  return fallback;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/user rejected|rejected request|cancelled|canceled/i.test(message)) {
    return 'Действие отменено в Abstract. Нажмите кнопку и повторите.';
  }
  if (/popup|window.*blocked|failed to open|failed to initialize request/i.test(message)) {
    return 'Браузер заблокировал окно Abstract. Разрешите всплывающие окна и повторите.';
  }
  if (/failed to fetch|network|load failed/i.test(message)) {
    return 'Не удалось связаться с Abstract или Cambria. Проверьте сеть и повторите.';
  }
  if (/unauthorized|http 401|http 403/i.test(message)) {
    return 'Cambria не приняла подпись. Нажмите «Повторить», чтобы получить новый запрос входа.';
  }
  return message;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Сервер ответил HTTP ${response.status}`);
  }
}

function setStatus(message: string, tone: 'waiting' | 'ready' | 'error' | 'done'): void {
  status.textContent = message;
  status.dataset['tone'] = tone;
  statusDot.dataset['tone'] = tone;
}

function setBusy(value: boolean, label?: string): void {
  busy = value;
  actionButton.disabled = value;
  switchButton.disabled = value;
  actionButton.classList.toggle('is-busy', value);
  if (label) actionButton.textContent = label;
}

function parseOperation(value: unknown): CambriaAuthOperation {
  if (!isRecord(value)) throw new Error('Приложение вернуло некорректную ссылку Cambria');
  const expectedAddress = normalizeAddress(value['expectedAddress']);
  const state = String(value['state'] ?? '');
  if (
    typeof value['id'] !== 'string' ||
    typeof value['accountName'] !== 'string' ||
    !expectedAddress ||
    !['awaiting_browser', 'completed', 'failed'].includes(state)
  ) {
    throw new Error('Ссылка Cambria повреждена или устарела');
  }
  return {
    id: value['id'],
    accountName: value['accountName'],
    expectedAddress,
    developerMode: value['developerMode'] === true,
    state: state as CambriaAuthOperation['state'],
    ...(typeof value['error'] === 'string' ? { error: value['error'] } : {}),
  };
}

function trace(event: string, data: Record<string, unknown> = {}): void {
  if (!operation?.developerMode) return;
  void fetch('/api/developer/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'cambria-browser',
      event,
      data: { operationId, accountName: operation.accountName, ...data },
    }),
  }).catch(() => undefined);
}

async function loadOperation(): Promise<CambriaAuthOperation> {
  if (!operationId) throw new Error('Ссылка Cambria неполная');
  const response = await fetch(`/api/cambria-auth/operations/${operationId}`, {
    cache: 'no-store',
  });
  const body = await responseJson(response);
  if (!response.ok || !isRecord(body)) {
    throw new Error(responseError(body, 'Ссылка Cambria больше не действует'));
  }
  return parseOperation(body['operation']);
}

async function readConnectedAccount(): Promise<string | undefined> {
  if (!provider) throw new Error('Abstract Global Wallet не загрузился');
  const result = await provider.request({ method: 'eth_accounts' });
  return Array.isArray(result) ? normalizeAddress(result[0]) : undefined;
}

function renderAccountState(): void {
  if (!operation) return;
  accountName.textContent = operation.accountName;
  accountAddress.textContent = shortAddress(operation.expectedAddress);

  if (operation.state === 'completed') {
    setBusy(false, 'Готово');
    actionButton.disabled = true;
    switchButton.hidden = true;
    setStatus('Cambria подключена. Можно вернуться в Abstract Hub.', 'done');
    document.title = 'Cambria подключена · Abstract Hub';
    return;
  }
  if (operation.state === 'failed') {
    setBusy(false, 'Ссылка закрыта');
    actionButton.disabled = true;
    switchButton.hidden = true;
    setStatus(operation.error || 'Ссылка Cambria больше не действует.', 'error');
    return;
  }
  if (!currentAddress) {
    setBusy(false, 'Подключить Abstract');
    switchButton.hidden = true;
    setStatus('Выберите этот аккаунт в Abstract.', 'waiting');
    return;
  }
  if (currentAddress !== operation.expectedAddress) {
    setBusy(false, 'Подключить нужный аккаунт');
    switchButton.hidden = false;
    setStatus(
      `Сейчас выбран ${shortAddress(currentAddress)}, а нужен ${shortAddress(operation.expectedAddress)}.`,
      'error',
    );
    return;
  }
  switchButton.hidden = false;
  if (pendingAuthResponse !== undefined) {
    setBusy(false, 'Сохранить вход');
    setStatus('Вход получен. Осталось сохранить его в приложении.', 'ready');
    return;
  }
  if (!challenge) {
    setBusy(false, 'Подготовить Cambria');
    setStatus('Abstract подключён. Подготовьте единичную подпись Cambria.', 'ready');
    return;
  }
  setBusy(false, 'Войти в Cambria');
  setStatus('Abstract подключён. Подтвердите единичную подпись Cambria.', 'ready');
}

function prepareCambriaLogin(): Promise<CambriaChallenge> {
  if (
    !operation ||
    !operationId ||
    !callbackSecret ||
    currentAddress !== operation.expectedAddress
  ) {
    return Promise.reject(new Error('Сначала подключите нужный Abstract-аккаунт'));
  }
  if (challenge?.address === currentAddress) return Promise.resolve(challenge);
  if (challengePromise) return challengePromise;
  const address = currentAddress;
  const request = (async (): Promise<CambriaChallenge> => {
    trace('challenge_requested');
    const response = await fetch(`/api/cambria-auth/challenge/${operationId}/${callbackSecret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    const initialized = await responseJson(response);
    if (!response.ok || !isRecord(initialized) || typeof initialized['message'] !== 'string') {
      throw new Error(
        responseError(initialized, `Cambria не подготовила вход (HTTP ${response.status})`),
      );
    }
    const prepared = {
      address,
      message: initialized['message'],
    };
    if (currentAddress === address) challenge = prepared;
    trace('challenge_ready', { status: response.status });
    return prepared;
  })();
  challengePromise = request;
  void request
    .catch(() => undefined)
    .finally(() => {
      if (challengePromise === request) challengePromise = undefined;
    });
  return request;
}

async function connectAbstract(): Promise<void> {
  if (!provider) throw new Error('Abstract Global Wallet не загрузился');
  setBusy(true, 'Открываем Abstract...');
  await provider.request({ method: 'eth_requestAccounts' });
  currentAddress = await readConnectedAccount();
  challenge = undefined;
  challengePromise = undefined;
  pendingAuthResponse = undefined;
  trace('abstract_connected', { address: currentAddress });
  renderAccountState();
  if (operation && currentAddress === operation.expectedAddress) {
    try {
      await prepareCambriaLogin();
      renderAccountState();
    } catch (error) {
      setBusy(false, 'Повторить');
      setStatus(describeError(error), 'error');
    }
  }
}

async function switchAbstractAccount(): Promise<void> {
  if (!provider) throw new Error('Abstract Global Wallet не загрузился');
  setBusy(true, 'Отключаем...');
  await provider.request({
    method: 'wallet_revokePermissions',
    params: [{ eth_accounts: {} }],
  });
  currentAddress = undefined;
  challenge = undefined;
  challengePromise = undefined;
  pendingAuthResponse = undefined;
  renderAccountState();
}

async function submitSession(approval: CambriaApproval): Promise<void> {
  if (!operationId || !callbackSecret) throw new Error('Ссылка Cambria неполная');
  const response = await fetch(`/api/cambria-auth/callback/${operationId}/${callbackSecret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(approval),
  });
  const body = await responseJson(response);
  if (!response.ok) throw new Error(responseError(body, 'Приложение не приняло вход Cambria'));
}

async function completeLogin(): Promise<void> {
  if (pendingAuthResponse === undefined) throw new Error('Cambria ещё не вернула вход');
  setBusy(true, 'Сохраняем...');
  setStatus('Вход получен. Сохраняем защищённую сессию...', 'waiting');
  trace('session_save_started');
  try {
    await submitSession(pendingAuthResponse);
    operation = await loadOperation();
    pendingAuthResponse = undefined;
    trace('session_saved');
    renderAccountState();
  } catch (error) {
    pendingAuthResponse = undefined;
    challenge = undefined;
    challengePromise = undefined;
    throw error;
  }
}

async function signIntoCambria(): Promise<void> {
  if (!provider || !operation || !challenge) throw new Error('Вход Cambria ещё не готов');
  const currentChallenge = challenge;
  setBusy(true, 'Ждём Abstract...');
  setStatus('Подтвердите единичную подпись Cambria в Abstract.', 'waiting');
  trace('signature_requested');
  const signatureRequest = provider.request({
    method: 'personal_sign',
    params: [stringToHex(currentChallenge.message), currentChallenge.address],
  });
  const signature = await signatureRequest;
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    throw new Error('Abstract не вернул подпись Cambria');
  }
  trace('signature_received');
  setStatus('Подпись получена. Завершаем официальный вход Cambria...', 'waiting');
  pendingAuthResponse = { signature, message: currentChallenge.message };
  challenge = undefined;
  await completeLogin();
}

async function handleAction(): Promise<void> {
  if (busy || !operation) return;
  try {
    if (!currentAddress || currentAddress !== operation.expectedAddress) {
      await connectAbstract();
      return;
    }
    if (pendingAuthResponse !== undefined) {
      await completeLogin();
      return;
    }
    if (!challenge) {
      setBusy(true, 'Готовим Cambria...');
      setStatus('Получаем безопасный запрос входа Cambria...', 'waiting');
      await prepareCambriaLogin();
      renderAccountState();
      return;
    }
    await signIntoCambria();
  } catch (error) {
    trace('action_failed', { error: describeError(error) });
    setBusy(false);
    renderAccountState();
    setStatus(describeError(error), 'error');
    if (!pendingAuthResponse && currentAddress === operation.expectedAddress) {
      void prepareCambriaLogin()
        .then(() => renderAccountState())
        .catch(() => undefined);
    }
  }
}

async function initialize(): Promise<void> {
  try {
    if (!operationId || !callbackSecret) throw new Error('Откройте ссылку из Abstract Hub');
    const onProvider = (event: Event): void => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      if (detail?.info.rdns === 'xyz.abs.privy') provider = detail.provider;
    };
    window.addEventListener('eip6963:announceProvider', onProvider);
    const disposeProvider = initAbstractGlobalWallet({ chain: abstract });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    window.addEventListener('pagehide', disposeProvider, { once: true });

    operation = await loadOperation();
    trace('page_initialized');
    if (!provider) throw new Error('Abstract Global Wallet не загрузился');
    currentAddress = await readConnectedAccount();
    renderAccountState();
    if (operation.state === 'awaiting_browser' && currentAddress === operation.expectedAddress) {
      await prepareCambriaLogin();
      renderAccountState();
    }
  } catch (error) {
    setBusy(false, 'Повторить');
    switchButton.hidden = true;
    setStatus(describeError(error), 'error');
  }
}

actionButton.addEventListener('click', () => void handleAction());
switchButton.addEventListener('click', () => {
  void switchAbstractAccount().catch((error: unknown) => {
    setBusy(false);
    setStatus(describeError(error), 'error');
  });
});

void initialize();
