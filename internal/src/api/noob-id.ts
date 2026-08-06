import type { Logger } from 'pino';
import type { GigaClient } from './client.js';

/**
 * Extract the numeric Noob token ID from auth/profile payloads.
 *
 * Gigaverse also exposes a Mongo `_id` on `gameAccount.noob`; that value is
 * not accepted by gameplay endpoints. The usable ID is normally `docId` or
 * `accountEntity.NOOB_TOKEN_CID`.
 */
export function extractNoobTokenId(source: unknown): number | undefined {
  return extractNoobTokenIdDeep(source, new Set<unknown>());
}

export async function resolveNoobTokenId(
  client: GigaClient,
  agwAddress: string,
  gameAccount: unknown,
  log: Logger,
): Promise<number | undefined> {
  const fromLogin = extractNoobTokenId(gameAccount);
  if (fromLogin !== undefined) return fromLogin;

  if (!agwAddress) return undefined;

  try {
    const profile = await client.get<unknown>(`/api/account/${agwAddress}`, { authed: true });
    const fromProfile = extractNoobTokenId(profile);
    if (fromProfile !== undefined) {
      log.info({ noobId: fromProfile }, 'resolved noob id from account profile');
      return fromProfile;
    }
  } catch (error) {
    log.warn({ err: error }, 'could not resolve noob id from account profile');
  }

  return undefined;
}

function extractNoobTokenIdDeep(source: unknown, seen: Set<unknown>): number | undefined {
  if (!source || typeof source !== 'object' || seen.has(source)) return undefined;
  seen.add(source);
  const obj = source as Record<string, unknown>;

  const direct = pickPositiveInt(obj, [
    'NOOB_TOKEN_CID',
    'NOOB_TOKEN_ID',
    'NOOB_ID_CID',
    'TOKEN_ID_CID',
    'noobId',
    'noobID',
    'noobTokenId',
    'tokenId',
  ]);
  if (direct !== undefined) return direct;

  const noob = obj['noob'];
  if (noob && typeof noob === 'object') {
    const nested = pickPositiveInt(noob as Record<string, unknown>, [
      'docId',
      '_id',
      'NOOB_TOKEN_CID',
      'NOOB_TOKEN_ID',
      'NOOB_ID_CID',
      'TOKEN_ID_CID',
      'tokenId',
    ]);
    if (nested !== undefined) return nested;
  }

  for (const key of ['gameAccount', 'accountEntity', 'account']) {
    const nested = extractNoobTokenIdDeep(obj[key], seen);
    if (nested !== undefined) return nested;
  }

  return undefined;
}

function pickPositiveInt(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
      const parsed = Number(raw);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return undefined;
}
