import type { Account } from '../vault/schema.js';
import type { AuthUser, GameAccount, LoginResult } from './types.js';

export interface StoredGameSession extends LoginResult {
  address: string;
  capturedAt: number;
}

export type StoredGameSessions = Record<string, StoredGameSession>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Gigaverse вернул некорректную игровую сессию');
  try {
    const parsed = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error('payload is not an object');
    return parsed;
  } catch {
    throw new Error('Gigaverse вернул повреждённую игровую сессию');
  }
}

function normalizedAddress(value: unknown): string | undefined {
  return typeof value === 'string' && /^0x[a-f0-9]{40}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

/** Validate the authResponse object captured from gigaverse.io localStorage. */
export function parseBrowserGameSession(
  raw: unknown,
  expectedAddress?: string,
  now = Date.now(),
): StoredGameSession {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  } catch {
    throw new Error('Gigaverse вернул повреждённую игровую сессию');
  }
  if (!isRecord(parsed) || typeof parsed.jwt !== 'string') {
    throw new Error('Gigaverse ещё не завершил вход через Abstract');
  }

  const payload = decodeJwtPayload(parsed.jwt);
  const address = normalizedAddress(payload.address);
  if (!address) throw new Error('В игровой сессии Gigaverse отсутствует адрес аккаунта');
  if (expectedAddress && address !== expectedAddress.toLowerCase()) {
    throw new Error(`В браузере открыт другой Abstract-аккаунт: ${address}`);
  }

  const payloadExpiry =
    typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : undefined;
  const responseExpiry =
    typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)
      ? parsed.expiresAt
      : undefined;
  const expiresAt = responseExpiry ?? payloadExpiry;
  if (!expiresAt || expiresAt <= now) {
    throw new Error('Игровая сессия Gigaverse уже истекла');
  }

  return {
    address,
    jwt: parsed.jwt,
    expiresAt,
    gameAccount: (isRecord(parsed.gameAccount) ? parsed.gameAccount : {}) as GameAccount,
    user: (isRecord(parsed.user) ? parsed.user : {}) as AuthUser,
    capturedAt: now,
  };
}

export function storedGameSessionForAccount(
  sessions: StoredGameSessions | undefined,
  account: Pick<Account, 'agwAddress'>,
  now = Date.now(),
): StoredGameSession | undefined {
  const address = account.agwAddress?.toLowerCase();
  if (!address) return undefined;
  const stored = sessions?.[address];
  if (!stored) return undefined;
  try {
    return parseBrowserGameSession(stored, address, now);
  } catch {
    return undefined;
  }
}

/** Add a valid browser-acquired JWT to an in-memory account object only. */
export function hydrateAccountGameSession(
  account: Account,
  sessions: StoredGameSessions | undefined,
  now = Date.now(),
): Account {
  const stored = storedGameSessionForAccount(sessions, account, now);
  return stored ? { ...account, jwt: stored.jwt } : account;
}

export function upsertStoredGameSession(
  sessions: StoredGameSessions | undefined,
  session: StoredGameSession,
): StoredGameSessions {
  return { ...(sessions ?? {}), [session.address.toLowerCase()]: session };
}
