const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_SESSION_QUERY_LENGTH = 128 * 1024;

export class AbstractCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbstractCallbackError';
  }
}

export interface AbstractCallbackBridge {
  approvalUrl: string;
  callbackTarget: string;
}

function parseUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new AbstractCallbackError(`${label} имеет некорректный формат`);
  }
}

function assertLoopbackHttpUrl(url: URL, label: string): void {
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new AbstractCallbackError(`${label} должен вести на локальный HTTP-адрес`);
  }
}

/**
 * Replaces the short-lived CLI callback with the app's persistent localhost
 * endpoint. The original callback remains private and is used only server-side.
 */
export function bridgeAbstractApprovalUrl(input: {
  approvalUrl: string;
  appBaseUrl: string;
  operationId: string;
  callbackSecret: string;
  allowedApprovalOrigins: ReadonlySet<string>;
}): AbstractCallbackBridge {
  const approvalUrl = parseUrl(input.approvalUrl, 'Ссылка подтверждения Abstract');
  if (!input.allowedApprovalOrigins.has(approvalUrl.origin)) {
    throw new AbstractCallbackError(
      `Abstract вернул ссылку с неподдерживаемого адреса ${approvalUrl.origin}`,
    );
  }

  const callbackValue = approvalUrl.searchParams.get('callback_url');
  if (!callbackValue) {
    throw new AbstractCallbackError('В ссылке Abstract отсутствует callback_url');
  }
  const callbackTarget = parseUrl(callbackValue, 'Callback Abstract CLI');
  assertLoopbackHttpUrl(callbackTarget, 'Callback Abstract CLI');
  if (!callbackTarget.port || !callbackTarget.pathname.startsWith('/callback/')) {
    throw new AbstractCallbackError('Abstract CLI вернул неожиданный callback-адрес');
  }
  if (!callbackTarget.searchParams.get('state')) {
    throw new AbstractCallbackError('В callback Abstract отсутствует защитный state');
  }

  const appBaseUrl = parseUrl(input.appBaseUrl, 'Адрес приложения');
  assertLoopbackHttpUrl(appBaseUrl, 'Адрес приложения');
  const bridgeUrl = new URL(
    `/api/abstract/callback/${input.operationId}/${input.callbackSecret}`,
    appBaseUrl,
  );
  bridgeUrl.searchParams.set('state', callbackTarget.searchParams.get('state')!);
  approvalUrl.searchParams.set('callback_url', bridgeUrl.toString());

  return {
    approvalUrl: approvalUrl.toString(),
    callbackTarget: callbackTarget.toString(),
  };
}

/** Validates the browser payload and reconstructs the CLI's private callback. */
export function buildAbstractCallbackTarget(
  callbackTarget: string,
  browserCallbackUrl: string,
): URL {
  const target = parseUrl(callbackTarget, 'Callback Abstract CLI');
  assertLoopbackHttpUrl(target, 'Callback Abstract CLI');
  const browserCallback = parseUrl(browserCallbackUrl, 'Ответ Abstract');
  const session = browserCallback.searchParams.get('session');
  if (!session?.trim()) {
    throw new AbstractCallbackError('Abstract не передал данные подтверждённой сессии');
  }
  if (session.length > MAX_SESSION_QUERY_LENGTH) {
    throw new AbstractCallbackError('Ответ Abstract слишком большой');
  }

  const expectedState = target.searchParams.get('state');
  const receivedState = browserCallback.searchParams.get('state');
  if (!expectedState || receivedState !== expectedState) {
    throw new AbstractCallbackError('Abstract вернул ответ с некорректным state');
  }

  target.searchParams.set('session', session);
  return target;
}
