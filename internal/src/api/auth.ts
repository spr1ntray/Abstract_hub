import { request, type Dispatcher } from 'undici';
import type { Logger } from 'pino';
import type { Account } from '../vault/schema.js';
import type { Address, Hex } from 'viem';
import { makeProxyAgent } from '../wallet/proxy-agent.js';
import { HttpError } from './errors.js';
import { buildHeaders } from './client.js';
import type { LoginResult, GameAccount, AuthUser } from './types.js';

export type { LoginResult };

/** Minimal signer surface required by the Gigaverse login endpoint. */
export interface GigaverseLoginSigner {
  account: { address: Address };
  signMessage(args: { message: string }): Promise<Hex>;
}

const BASE = 'https://gigaverse.io';
const REQUEST_TIMEOUT_MS = 20_000;

/** Raw response shape for POST /api/user/auth */
interface AuthResponse {
  success: boolean;
  jwt?: string;
  expiresAt?: number;
  message?: string;
  gameAccount?: GameAccount;
  user?: AuthUser;
}

/**
 * Signals a definitive login failure that should not be retried:
 * server rejected the request (success=false) or returned an incomplete payload.
 */
class LoginRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginRejectedError';
  }
}

/**
 * Performs a full AGW-signed login to Gigaverse.
 *
 * Sequence:
 *   1. Build message `"Login to Gigaverse at <timestamp>"`
 *   2. Ask AGW signer to produce an ERC-1271 wrapped signature
 *   3. POST to /api/user/auth with { signature, address, message, timestamp }
 *   4. Return { jwt, expiresAt } or throw on failure
 *
 * Uses the account's proxy and retries up to 3 times on 5xx / network errors.
 *
 * @param opts.dispatcher - Optional undici dispatcher override (primarily for tests via MockAgent).
 */
export async function loginToGigaverse(opts: {
  account: Account;
  agw: GigaverseLoginSigner;
  log: Logger;
  /** Override dispatcher (useful for tests with MockAgent). If absent, builds ProxyAgent from account.proxy. */
  dispatcher?: Dispatcher;
}): Promise<LoginResult> {
  const { account, agw, log } = opts;

  // Anti-sybil: real humans don't sign with sub-ms-aligned timestamps. Offset
  // by 200-3000ms so the signed `timestamp` lags behind the POST send time
  // the way a "type password + click login" flow naturally would.
  const timestamp = Date.now() - (200 + Math.floor(Math.random() * 2800));
  const message = `Login to Gigaverse at ${timestamp}`;

  log.debug({ account: account.name }, 'signing login message');
  const signature = await agw.signMessage({ message });
  const address = agw.account.address;

  const body = JSON.stringify({ signature, address, message, timestamp });
  const dispatcher = opts.dispatcher ?? makeProxyAgent(account.proxy);

  return await withRetries(
    async () => {
      log.debug({ account: account.name }, 'posting to /api/user/auth');
      // Use the same per-account header bundle as gameplay so the login and
      // subsequent game requests are fingerprint-indistinguishable.
      const res = await request(`${BASE}/api/user/auth`, {
        method: 'POST',
        headers: {
          ...buildHeaders(account.name),
          'content-type': 'application/json',
        },
        body,
        dispatcher,
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
      });

      const text = await res.body.text();
      const parsed: unknown = safeJsonParse(text);

      if (res.statusCode >= 500) {
        throw new HttpError(res.statusCode, parsed, `auth server error ${res.statusCode}`);
      }
      if (res.statusCode >= 400) {
        throw new HttpError(res.statusCode, parsed, `auth failed with status ${res.statusCode}`);
      }

      const data = parsed as AuthResponse;

      if (!data.success) {
        const detail = data.message ?? 'unknown reason';
        // Non-retryable: server explicitly rejected the credentials
        throw new LoginRejectedError(`Gigaverse login rejected: ${detail}`);
      }

      if (!data.jwt) {
        // Non-retryable: malformed response
        throw new LoginRejectedError('Gigaverse login response missing jwt field');
      }
      if (data.expiresAt === undefined) {
        // Non-retryable: malformed response
        throw new LoginRejectedError('Gigaverse login response missing expiresAt field');
      }

      log.info({ account: account.name, expiresAt: data.expiresAt }, 'login successful');
      return {
        jwt: data.jwt,
        expiresAt: data.expiresAt,
        // Provide empty objects as fallback so callers never have to handle undefined
        gameAccount: data.gameAccount ?? {},
        user: data.user ?? {},
      };
    },
    3,
    log,
    account.name,
  );
}

/** Retry helper: retries on 5xx HttpError or network errors, not on 4xx. */
async function withRetries<T>(
  fn: () => Promise<T>,
  attempts: number,
  log: Logger,
  accountName: string,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // Don't retry 4xx HTTP errors or application-level rejections
      if (e instanceof HttpError && e.status < 500) throw e;
      if (e instanceof LoginRejectedError) throw e;
      if (i < attempts - 1) {
        const base = 300 + Math.floor(Math.random() * 400);
        const delay = Math.floor(base * 2 ** i * (0.5 + Math.random()));
        log.warn({ account: accountName, attempt: i + 1, delay, err: e }, 'retrying login');
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a LoginResult from a pre-baked JWT (extracted from browser localStorage).
 *
 * For users hit by the Privy embedded-EOA problem — where the AGW they play
 * with in the browser is not derivable from any EOA we hold — pasting the
 * raw JWT bypasses the entire sign+POST login flow.
 *
 * The JWT payload contains all the fields we'd normally get from
 * /api/user/auth: `address`, `user`, `gameAccount`, `exp` (in seconds).
 */
export function decodeJwtToLoginResult(jwt: string): LoginResult {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('JWT must have 3 segments');
  let payload: { exp?: number; user?: AuthUser; gameAccount?: GameAccount; address?: string };
  try {
    const decoded = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    payload = JSON.parse(decoded);
  } catch {
    throw new Error('JWT payload is not valid base64url-encoded JSON');
  }
  if (typeof payload.exp !== 'number') {
    throw new Error('JWT payload missing exp claim');
  }
  // exp is seconds since epoch; expiresAt is millis
  return {
    jwt,
    expiresAt: payload.exp * 1000,
    gameAccount: payload.gameAccount ?? {},
    user: payload.user ?? {},
  };
}
