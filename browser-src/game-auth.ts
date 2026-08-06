import { initAbstractGlobalWallet } from '@abstract-foundation/agw-web';
import { stringToHex } from 'viem';
import { abstract } from 'viem/chains';
import {
  normalizeWalletAddress,
  preserveWalletAddress,
} from '../internal/src/shared/wallet-address.js';

interface RpcProvider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

interface Eip6963ProviderDetail {
  info: {
    rdns: string;
  };
  provider: RpcProvider;
}

interface GameAuthOperation {
  id: string;
  accountAlias: string;
  expectedAddress: string;
  state: 'awaiting_browser' | 'completed' | 'failed';
  needsGame: boolean;
  needsTollan: boolean;
  error?: string;
}

interface TollanChallenge {
  signerAddress: string;
  nonce: string;
}

const pageMatch = /^\/game-auth\/([a-f0-9]{48})\/([a-f0-9]{48})\/?$/.exec(window.location.pathname);
const operationId = pageMatch?.[1];
const callbackSecret = pageMatch?.[2];

const accountName = requiredElement<HTMLElement>('auth-account-name');
const accountAddress = requiredElement<HTMLElement>('auth-account-address');
const status = requiredElement<HTMLElement>('auth-status');
const statusDot = requiredElement<HTMLElement>('auth-status-dot');
const actionButton = requiredElement<HTMLButtonElement>('auth-action');
const switchButton = requiredElement<HTMLButtonElement>('auth-switch');

let provider: RpcProvider | undefined;
let operation: GameAuthOperation | undefined;
let currentAddress: string | undefined;
let currentSignerAddress: string | undefined;
let busy = false;
let tollanChallenge: TollanChallenge | undefined;
let tollanChallengePromise: Promise<TollanChallenge> | undefined;
let pendingGameAuthResponse: unknown;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing browser auth element: ${id}`);
  return element as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAddress(value: unknown): string | undefined {
  return normalizeWalletAddress(value);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/user rejected|rejected request|cancelled|canceled/i.test(message)) {
    return 'Действие отменено в Abstract. Нажмите кнопку и повторите.';
  }
  if (/popup|window.*blocked|failed to open|failed to initialize request/i.test(message)) {
    return 'Браузер заблокировал окно Abstract. Разрешите всплывающие окна для этой страницы и повторите.';
  }
  if (/failed to fetch|network|load failed/i.test(message)) {
    return 'Не удалось связаться с Abstract или Gigaverse. Проверьте сеть и повторите.';
  }
  return message;
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

function parseOperation(value: unknown): GameAuthOperation {
  if (!isRecord(value)) throw new Error('Приложение вернуло некорректные данные входа');
  const id = value['id'];
  const accountAliasValue = value['accountAlias'];
  const expectedAddress = normalizeAddress(value['expectedAddress']);
  const state = value['state'];
  if (
    typeof id !== 'string' ||
    typeof accountAliasValue !== 'string' ||
    !expectedAddress ||
    !['awaiting_browser', 'completed', 'failed'].includes(String(state))
  ) {
    throw new Error('Одноразовая ссылка повреждена или устарела');
  }
  return {
    id,
    accountAlias: accountAliasValue,
    expectedAddress,
    state: state as GameAuthOperation['state'],
    needsGame: value['needsGame'] !== false,
    needsTollan: value['needsTollan'] !== false,
    ...(typeof value['error'] === 'string' ? { error: value['error'] } : {}),
  };
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

function responseError(body: unknown, fallback: string): string {
  if (isRecord(body)) {
    if (typeof body['message'] === 'string' && body['message']) return body['message'];
    if (typeof body['error'] === 'string' && body['error']) return body['error'];
  }
  return fallback;
}

async function loadOperation(): Promise<GameAuthOperation> {
  if (!operationId || !callbackSecret) {
    throw new Error('Одноразовая ссылка входа неполная');
  }
  const response = await fetch(`/api/game-auth/operations/${operationId}`, {
    cache: 'no-store',
  });
  const body = await responseJson(response);
  if (!response.ok || !isRecord(body)) {
    throw new Error(responseError(body, 'Одноразовая ссылка больше не действует'));
  }
  return parseOperation(body['operation']);
}

async function readConnectedAccount(): Promise<{
  address?: string;
  signerAddress?: string;
}> {
  if (!provider) throw new Error('Abstract Global Wallet не загрузился');
  const result = await provider.request({ method: 'eth_accounts' });
  if (!Array.isArray(result)) return {};
  const address = normalizeAddress(result[0]);
  // AGW compares this signer address case-sensitively when deciding whether
  // personal_sign belongs to the EOA or the smart account. Preserve it exactly.
  const signerAddress = preserveWalletAddress(result[1]);
  return {
    ...(address ? { address } : {}),
    ...(signerAddress ? { signerAddress } : {}),
  };
}

function renderAccountState(): void {
  if (!operation) return;
  const expected = operation.expectedAddress;
  actionButton.disabled = false;
  switchButton.disabled = false;
  accountName.textContent = operation.accountAlias;
  accountAddress.textContent = shortAddress(expected);

  if (operation.needsGame && pendingGameAuthResponse !== undefined && operation.needsTollan) {
    actionButton.textContent = 'Подключить Tollan';
    switchButton.hidden = true;
    setStatus('Gigaverse подключён. Нажмите кнопку и подтвердите вход в Tollan.', 'ready');
    return;
  }

  if (!currentAddress) {
    actionButton.textContent = 'Подключить Abstract';
    switchButton.hidden = true;
    setStatus('Выберите этот аккаунт в Abstract.', 'waiting');
    return;
  }

  if (currentAddress !== expected) {
    actionButton.textContent = 'Подключить нужный аккаунт';
    switchButton.hidden = false;
    setStatus(
      `Сейчас выбран ${shortAddress(currentAddress)}, а нужен ${shortAddress(expected)}.`,
      'error',
    );
    return;
  }

  actionButton.textContent = operation.needsGame ? 'Подключить Gigaverse' : 'Подключить Tollan';
  switchButton.hidden = false;
  setStatus(
    operation.needsGame
      ? 'Abstract подключён. Осталось подтвердить Gigaverse.'
      : 'Gigaverse уже сохранён. Осталось подтвердить только Tollan.',
    'ready',
  );
}

async function connectAbstract(): Promise<void> {
  if (!provider) throw new Error('Abstract Global Wallet не загрузился');
  setBusy(true, 'Открываем Abstract...');
  await provider.request({ method: 'eth_requestAccounts' });
  const connected = await readConnectedAccount();
  currentAddress = connected.address;
  currentSignerAddress = connected.signerAddress;
  if (operation?.needsTollan) void prepareTollanLogin().catch(() => undefined);
  setBusy(false);
  renderAccountState();
}

async function switchAbstractAccount(): Promise<void> {
  if (!provider) throw new Error('Abstract Global Wallet не загрузился');
  setBusy(true, 'Отключаем...');
  await provider.request({
    method: 'wallet_revokePermissions',
    params: [{ eth_accounts: {} }],
  });
  currentAddress = undefined;
  currentSignerAddress = undefined;
  tollanChallenge = undefined;
  tollanChallengePromise = undefined;
  pendingGameAuthResponse = undefined;
  setBusy(false);
  renderAccountState();
}

interface TollanApproval extends TollanChallenge {
  signature: string;
}

function prepareTollanLogin(): Promise<TollanChallenge> {
  if (!provider || !operationId || !callbackSecret) {
    return Promise.reject(new Error('Вход Tollan ещё не готов'));
  }
  if (!currentSignerAddress) {
    return Promise.reject(
      new Error(
        'Abstract не передал signer-адрес для Tollan. Переподключите аккаунт в Abstract и повторите.',
      ),
    );
  }
  if (tollanChallenge?.signerAddress === currentSignerAddress) {
    return Promise.resolve(tollanChallenge);
  }
  if (tollanChallengePromise) return tollanChallengePromise;

  const signerAddress = currentSignerAddress;
  const request = (async (): Promise<TollanChallenge> => {
    const nonceResponse = await fetch(
      `/api/game-auth/tollan/nonce/${operationId}/${callbackSecret}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signerAddress }),
      },
    );
    const nonceBody = await responseJson(nonceResponse);
    if (!nonceResponse.ok || !isRecord(nonceBody)) {
      throw new Error(responseError(nonceBody, 'Tollan не подготовил вход'));
    }
    if (nonceBody['allowed'] !== true || typeof nonceBody['nonce'] !== 'string') {
      throw new Error(
        'Tollan не разрешил автоматический вход для этого Abstract-аккаунта. Повторите подключение.',
      );
    }
    const challenge = { signerAddress, nonce: nonceBody['nonce'] };
    if (currentSignerAddress === signerAddress) tollanChallenge = challenge;
    return challenge;
  })();
  tollanChallengePromise = request;
  void request.catch(() => {
    if (tollanChallengePromise === request) tollanChallengePromise = undefined;
  });
  return request;
}

async function completeLogin(authResponse?: unknown, tollanAuth?: TollanApproval): Promise<void> {
  if (!operation || !operationId || !callbackSecret) throw new Error('Вход ещё не готов');
  setStatus('Подтверждения получены. Сохраняем вход...', 'waiting');
  const callbackResponse = await fetch(`/api/game-auth/callback/${operationId}/${callbackSecret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(authResponse !== undefined ? { authResponse } : {}),
      ...(tollanAuth ? { tollanAuth } : {}),
    }),
  });
  const callbackBody = await responseJson(callbackResponse);
  if (!callbackResponse.ok) {
    if (tollanAuth) {
      // A Tollan nonce is single-use even when its server action finishes with
      // an ambiguous response. Never offer the same challenge on the next click.
      tollanChallenge = undefined;
      tollanChallengePromise = undefined;
      void prepareTollanLogin().catch(() => undefined);
    }
    throw new Error(
      responseError(callbackBody, `Приложение ответило HTTP ${callbackResponse.status}`),
    );
  }

  const tollanConnected = isRecord(callbackBody) && callbackBody['tollanConnected'] === true;
  const tollanWarning =
    isRecord(callbackBody) && typeof callbackBody['tollanWarning'] === 'string'
      ? callbackBody['tollanWarning']
      : undefined;

  pendingGameAuthResponse = undefined;
  operation.state = 'completed';
  setBusy(false, 'Готово');
  actionButton.disabled = true;
  switchButton.hidden = true;
  setStatus(
    tollanConnected
      ? 'Аккаунт подключён к Gigaverse и Tollan. Можно вернуться в Abstract Hub.'
      : `Gigaverse сохранён. Tollan можно повторить отдельно.${tollanWarning ? ` ${tollanWarning}` : ''}`,
    'done',
  );
  document.title = 'Аккаунт подключён · Abstract Hub';
}

async function signIntoGigaverse(): Promise<void> {
  if (!provider || !operation || !operationId || !callbackSecret) {
    throw new Error('Вход ещё не готов');
  }

  setBusy(true, 'Ждём подтверждение...');
  setStatus('Подтвердите подпись сообщения в Abstract.', 'waiting');

  const timestamp = Date.now();
  const message = `Login to Gigaverse at ${timestamp}`;
  const signature = await provider.request({
    method: 'personal_sign',
    params: [stringToHex(message), operation.expectedAddress],
  });
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    throw new Error('Abstract не вернул подпись входа');
  }

  setStatus('Подпись получена. Завершаем вход...', 'waiting');
  const gameResponse = await fetch('https://gigaverse.io/api/user/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      signature,
      address: operation.expectedAddress,
      message,
      timestamp,
    }),
    credentials: 'omit',
  });
  const authResponse = await responseJson(gameResponse);
  if (!gameResponse.ok) {
    throw new Error(responseError(authResponse, `Gigaverse ответил HTTP ${gameResponse.status}`));
  }
  if (isRecord(authResponse) && authResponse['success'] === false) {
    throw new Error(responseError(authResponse, 'Gigaverse отклонил вход'));
  }

  pendingGameAuthResponse = authResponse;
  if (!operation.needsTollan) {
    await completeLogin(authResponse);
    return;
  }
  try {
    await prepareTollanLogin();
  } catch (error) {
    setBusy(false, 'Подключить Tollan');
    switchButton.hidden = true;
    throw error;
  }

  setBusy(false, 'Подключить Tollan');
  switchButton.hidden = true;
  setStatus('Gigaverse подключён. Нажмите кнопку и подтвердите вход в Tollan.', 'ready');
}

async function signIntoTollan(): Promise<void> {
  if (!provider || !operation) throw new Error('Вход Tollan ещё не готов');
  if (operation.needsGame && pendingGameAuthResponse === undefined) {
    throw new Error('Сначала завершите вход Gigaverse');
  }
  const challenge = tollanChallenge;
  if (!challenge) {
    setBusy(true, 'Готовим Tollan...');
    const prepared = await prepareTollanLogin();
    setBusy(false, 'Подключить Tollan');
    tollanChallenge = prepared;
    setStatus('Tollan готов. Нажмите кнопку ещё раз для подтверждения.', 'ready');
    return;
  }

  setBusy(true, 'Ждём Abstract...');
  setStatus('Подтвердите единичный вход в Tollan.', 'waiting');
  // The wallet request must start in the click handler before any await. Otherwise
  // browsers block Abstract's second popup as a non-user-initiated window.
  const signatureRequest = provider.request({
    method: 'personal_sign',
    params: [stringToHex(`Login in Tollan Hub - ${challenge.nonce}`), challenge.signerAddress],
  });
  const signature = await signatureRequest;
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    throw new Error('Abstract не вернул подпись входа Tollan');
  }
  if (!/^0x[a-fA-F0-9]{130}$/.test(signature)) {
    tollanChallenge = undefined;
    tollanChallengePromise = undefined;
    throw new Error(
      'Abstract вернул smart-wallet подпись вместо обычной подписи Tollan. Переключите аккаунт и подключите его заново.',
    );
  }
  await completeLogin(pendingGameAuthResponse, { ...challenge, signature });
}

async function handleAction(): Promise<void> {
  if (busy || !operation) return;
  try {
    if (!currentAddress || currentAddress !== operation.expectedAddress) {
      await connectAbstract();
      return;
    }
    if (operation.needsGame && pendingGameAuthResponse === undefined) {
      await signIntoGigaverse();
      return;
    }
    await signIntoTollan();
  } catch (error) {
    setBusy(false);
    renderAccountState();
    setStatus(describeError(error), 'error');
  }
}

async function initialize(): Promise<void> {
  try {
    if (!operationId || !callbackSecret) {
      throw new Error('Откройте одноразовую ссылку из Abstract Hub');
    }

    const onProvider = (event: Event): void => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      if (detail?.info.rdns === 'xyz.abs.privy') provider = detail.provider;
    };
    window.addEventListener('eip6963:announceProvider', onProvider);
    const disposeProvider = initAbstractGlobalWallet({ chain: abstract });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    window.addEventListener('pagehide', disposeProvider, { once: true });

    operation = await loadOperation();
    accountName.textContent = operation.accountAlias;
    accountAddress.textContent = shortAddress(operation.expectedAddress);
    if (operation.state === 'completed') {
      actionButton.textContent = 'Готово';
      actionButton.disabled = true;
      setStatus('Этот аккаунт уже подключён. Можно вернуться в Abstract Hub.', 'done');
      return;
    }
    if (operation.state === 'failed') {
      throw new Error(operation.error ?? 'Одноразовая ссылка больше не действует');
    }
    if (!provider) throw new Error('Abstract Global Wallet не загрузился');

    setStatus('Проверяем подключение Abstract...', 'waiting');
    const connected = await readConnectedAccount();
    currentAddress = connected.address;
    currentSignerAddress = connected.signerAddress;
    if (operation.needsTollan) void prepareTollanLogin().catch(() => undefined);
    renderAccountState();
  } catch (error) {
    actionButton.disabled = true;
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
