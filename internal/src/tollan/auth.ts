import { request } from 'undici';
import { getAddress } from 'viem';

const ACTION_QUERY = 'utm_source=abstract-portal';
const ACTION_ROUTER_STATE =
  '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%3F%7B%5C%22utm_source%5C%22%3A%5C%22abstract-portal%5C%22%7D%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D';
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface TollanAuthConfig {
  hubUrl: string;
  nonceActionId: string;
  loginActionId: string;
}

export interface TollanNonce {
  nonce: string;
  allowed: boolean;
  /** Cookies issued with the challenge. Kept only by the localhost server. */
  sessionCookies?: string[];
}

export interface TollanAuthState {
  payload: {
    sub: string;
    address: string;
    signer: string;
    [key: string]: unknown;
  };
  account: {
    accountName: string;
    defaultAccount: boolean;
    avatar?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface StoredTollanSession {
  agwAddress: string;
  signerAddress: string;
  state: TollanAuthState;
  cookies: string[];
  capturedAt: number;
}

export type StoredTollanSessions = Record<string, StoredTollanSession>;

export type TollanActionPhase = 'nonce' | 'login';

export class TollanActionError extends Error {
  constructor(
    message: string,
    readonly phase: TollanActionPhase,
    readonly status: number,
    readonly digest?: string,
  ) {
    super(message);
    this.name = 'TollanActionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAddress(value: unknown): string | undefined {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? value.toLowerCase() : undefined;
}

function wireAddress(value: string): string {
  return getAddress(value);
}

type TollanRscFrame = { kind: 'value'; value: unknown } | { kind: 'error'; message: string };

function parseRscError(encoded: string): string {
  try {
    const parsed = JSON.parse(encoded.slice(1)) as unknown;
    if (isRecord(parsed) && typeof parsed['message'] === 'string') {
      return parsed['message'];
    }
  } catch {
    // Next.js hides production error details behind a digest.
  }
  return 'Tollan отклонил запрос';
}

function resolveRscFrame(
  frame: TollanRscFrame,
  frames: ReadonlyMap<string, TollanRscFrame>,
): unknown {
  if (frame.kind === 'error') throw new Error(frame.message);
  const reference =
    Array.isArray(frame.value) && typeof frame.value[0] === 'string'
      ? /^\$@([0-9a-f]+)$/i.exec(frame.value[0])
      : null;
  if (!reference) return frame.value;
  const target = frames.get(reference[1]!);
  if (!target) throw new Error('Tollan вернул незавершённый ответ');
  return resolveRscFrame(target, frames);
}

/** Parse the resolved value returned by a Next.js server action. */
export function parseTollanActionResponse(text: string): unknown {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const frames = new Map<string, TollanRscFrame>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const id = line.slice(0, colon);
    if (!/^[0-9a-f]+$/i.test(id)) continue;
    const encoded = line.slice(colon + 1).trim();
    if (!encoded) continue;
    if (encoded.startsWith('E{')) {
      frames.set(id, { kind: 'error', message: parseRscError(encoded) });
      continue;
    }
    try {
      frames.set(id, { kind: 'value', value: JSON.parse(encoded) as unknown });
    } catch {
      // Import/module frames are not JSON values and are unrelated to the action result.
    }
  }

  // Next Flight frames can arrive out of numeric order. Frame 0 points to the
  // actual server-action result through "$@<id>"; page revalidation frames may
  // appear before both and must never be mistaken for the login payload.
  const root = frames.get('0');
  if (root) return resolveRscFrame(root, frames);
  for (const frame of frames.values()) return resolveRscFrame(frame, frames);
  throw new Error('Tollan вернул пустой ответ');
}

function responseCookies(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function cookieHeader(cookies: string[] | undefined): string | undefined {
  const pairs = (cookies ?? [])
    .map((cookie) => cookie.split(';', 1)[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie));
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

function tollanHttpError(
  text: string,
  phase: TollanActionPhase,
  status: number,
): TollanActionError {
  let message: string | undefined;
  let digest: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.indexOf(':E{');
    if (marker < 0) continue;
    try {
      const value = JSON.parse(line.slice(marker + 2)) as unknown;
      if (!isRecord(value)) continue;
      if (typeof value['message'] === 'string' && value['message'].trim()) {
        message = value['message'].trim();
      }
      if (typeof value['digest'] === 'string' && value['digest'].trim()) {
        digest = value['digest'].trim().slice(0, 80);
      }
    } catch {
      // Next.js may intentionally return a non-JSON generic 500 page.
    }
  }
  const phaseLabel = phase === 'nonce' ? 'подготовка входа' : 'завершение входа';
  const detail = message ?? `HTTP ${status}`;
  return new TollanActionError(
    `Tollan: ${phaseLabel} не выполнено (${detail}${digest ? `, код ${digest}` : ''})`,
    phase,
    status,
    digest,
  );
}

async function callTollanAction(
  config: TollanAuthConfig,
  actionId: string,
  args: unknown[],
  phase: TollanActionPhase,
  cookies?: string[],
): Promise<{ value: unknown; cookies: string[] }> {
  const actionUrl = new URL(`/?${ACTION_QUERY}`, config.hubUrl);
  const requestCookie = cookieHeader(cookies);
  const response = await request(actionUrl, {
    method: 'POST',
    headers: {
      accept: 'text/x-component',
      'content-type': 'text/plain;charset=UTF-8',
      'next-action': actionId,
      'next-router-state-tree': ACTION_ROUTER_STATE,
      origin: new URL(config.hubUrl).origin,
      referer: actionUrl.href,
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      ...(requestCookie ? { cookie: requestCookie } : {}),
    },
    body: JSON.stringify(args),
    headersTimeout: 20_000,
    bodyTimeout: 20_000,
  });
  const text = await response.body.text();
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw tollanHttpError(text, phase, response.statusCode);
  }
  try {
    return {
      value: parseTollanActionResponse(text),
      cookies: [...(cookies ?? []), ...responseCookies(response.headers['set-cookie'])],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tollan вернул некорректный ответ';
    throw new TollanActionError(`Tollan: ${message}`, phase, response.statusCode);
  }
}

export async function requestTollanNonce(
  config: TollanAuthConfig,
  signerAddress: string,
  agwAddress: string,
): Promise<TollanNonce> {
  const signer = normalizeAddress(signerAddress);
  const agw = normalizeAddress(agwAddress);
  if (!signer || !agw) throw new Error('Некорректный адрес Abstract для входа Tollan');
  const { value, cookies } = await callTollanAction(
    config,
    config.nonceActionId,
    [{ signerWalletAddress: wireAddress(signer), globalWalletAddress: wireAddress(agw) }],
    'nonce',
  );
  if (!isRecord(value) || typeof value['nonce'] !== 'string') {
    throw new Error('Tollan не выдал одноразовый код входа');
  }
  return {
    nonce: value['nonce'],
    allowed: value['allowed'] === true,
    ...(cookies.length > 0 ? { sessionCookies: cookies } : {}),
  };
}

export async function loginTollan(
  config: TollanAuthConfig,
  input: {
    signerAddress: string;
    agwAddress: string;
    signature: string;
    sessionCookies?: string[];
  },
  now = Date.now(),
): Promise<StoredTollanSession> {
  const signerAddress = normalizeAddress(input.signerAddress);
  const agwAddress = normalizeAddress(input.agwAddress);
  if (!signerAddress || !agwAddress || !/^0x[a-fA-F0-9]+$/.test(input.signature)) {
    throw new Error('Некорректная подпись входа Tollan');
  }

  const { value, cookies } = await callTollanAction(
    config,
    config.loginActionId,
    [
      {
        address: wireAddress(signerAddress),
        agwAddress: wireAddress(agwAddress),
        signature: input.signature,
      },
    ],
    'login',
    input.sessionCookies,
  );
  if (!isRecord(value) || !isRecord(value['payload']) || !isRecord(value['account'])) {
    throw new Error('Tollan не создал игровую сессию');
  }
  const payloadAddress = normalizeAddress(value['payload']['address']);
  const payloadSigner = normalizeAddress(value['payload']['signer']);
  if (payloadAddress !== agwAddress || payloadSigner !== signerAddress) {
    throw new Error('Tollan подключил другой Abstract-аккаунт');
  }
  if (
    typeof value['payload']['sub'] !== 'string' ||
    typeof value['account']['accountName'] !== 'string' ||
    typeof value['account']['defaultAccount'] !== 'boolean'
  ) {
    throw new Error('Tollan вернул неполную игровую сессию');
  }

  return {
    agwAddress,
    signerAddress,
    state: value as TollanAuthState,
    cookies,
    capturedAt: now,
  };
}

export function storedTollanSessionForAddress(
  sessions: StoredTollanSessions | undefined,
  address: string | undefined,
): StoredTollanSession | undefined {
  const normalized = normalizeAddress(address);
  if (!normalized) return undefined;
  const session = sessions?.[normalized];
  if (!session) return undefined;
  try {
    const stateAddress = normalizeAddress(session.state.payload.address);
    const stateSigner = normalizeAddress(session.state.payload.signer);
    if (
      normalizeAddress(session.agwAddress) !== normalized ||
      stateAddress !== normalized ||
      normalizeAddress(session.signerAddress) !== stateSigner
    ) {
      return undefined;
    }
    return session;
  } catch {
    return undefined;
  }
}

export function upsertStoredTollanSession(
  sessions: StoredTollanSessions | undefined,
  session: StoredTollanSession,
): StoredTollanSessions {
  return { ...(sessions ?? {}), [session.agwAddress.toLowerCase()]: session };
}
