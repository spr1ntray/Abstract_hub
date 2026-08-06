import { randomUUID } from 'node:crypto';
import { request, type Dispatcher } from 'undici';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { GigaverseLoginSigner } from '../api/auth.js';
import type { HubPack } from '../hub/pack.js';
import type { MarketplaceTransactionSender } from '../marketplace/lister.js';

type PortalBadgeConfig = HubPack['modules']['abstractBadges'];
type PortalMethod = 'POST';

const PrivyAuthSchema = z
  .object({
    user: z.object({ id: z.string().min(1) }).passthrough(),
    token: z.string().min(1),
    identity_token: z.string().min(1),
  })
  .passthrough();

const BadgeClaimSchema = z
  .object({
    account: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    badgeId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
    signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
  })
  .passthrough();

export const PORTAL_BADGE_ABI = [
  {
    type: 'function',
    inputs: [
      { name: 'account', internalType: 'address', type: 'address' },
      { name: 'id', internalType: 'uint256', type: 'uint256' },
      { name: 'signature', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'mintBadge',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export interface PortalClaimHttpRequest {
  url: string;
  method: PortalMethod;
  headers: Record<string, string>;
  body: string;
}

export interface PortalClaimHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type PortalClaimTransport = (
  input: PortalClaimHttpRequest,
) => Promise<PortalClaimHttpResponse>;

export interface PortalBadgeMintResult {
  badgeId: number;
  account: Address;
  txHash?: Hex;
  validated: boolean;
}

export interface PortalAuthSession {
  address: Address;
  userId: string;
  accessToken: string;
  identityToken: string;
  capturedAt: number;
}

export class PortalBadgeClaimError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PortalBadgeClaimError';
  }
}

function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const value = headers?.['retry-after'];
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Math.max(1_000, Number(value.trim()) * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(1_000, timestamp - Date.now()) : undefined;
}

function responseMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return typeof body === 'string' && body.trim() ? body : fallback;
  }
  const object = body as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'reason', 'code']) {
    if (typeof object[key] === 'string' && object[key].trim()) return object[key];
  }
  return fallback;
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

export function makePortalClaimTransport(dispatcher: Dispatcher): PortalClaimTransport {
  return async (input) => {
    const response = await request(input.url, {
      method: input.method,
      dispatcher,
      headers: input.headers,
      body: input.body,
      headersTimeout: 20_000,
      bodyTimeout: 25_000,
    });
    const text = await response.body.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
      else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ');
    }
    return { status: response.statusCode, body, headers };
  };
}

export function buildPortalSiweMessage(
  address: string,
  nonce: string,
  issuedAt = new Date().toISOString(),
): string {
  return `portal.abs.xyz wants you to sign in with your Ethereum account:
${address}

By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.

URI: https://portal.abs.xyz
Version: 1
Chain ID: 2741
Nonce: ${nonce}
Issued At: ${issuedAt}
Resources:
- https://privy.io`;
}

export class PortalBadgeClaimClient {
  private accessToken: string | undefined;
  private identityToken: string | undefined;
  private authenticatedAddress: Address | undefined;
  private readonly analyticsId = randomUUID();

  constructor(
    private readonly config: PortalBadgeConfig,
    private readonly transport: PortalClaimTransport,
  ) {}

  private async post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<PortalClaimHttpResponse> {
    return await this.transport({
      url,
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        origin: 'https://portal.abs.xyz',
        referer: 'https://portal.abs.xyz/rewards',
        'user-agent': BROWSER_USER_AGENT,
        'sec-ch-ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'x-correlation-id': randomUUID(),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  private async privy(path: string, body: unknown): Promise<unknown> {
    const response = await this.post(`${this.config.privyApiBase}${path}`, body, {
      'privy-app-id': this.config.privyAppId,
      'privy-client-id': this.config.privyClientId,
      'privy-ca-id': this.analyticsId,
      'privy-client': this.config.privyClient,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new PortalBadgeClaimError(
        responseMessage(response.body, `Privy HTTP ${response.status}`),
        response.status,
        retryAfterMs(response.headers),
      );
    }
    return response.body;
  }

  private async backend(
    path: string,
    options: { validation?: boolean } = {},
  ): Promise<unknown | undefined> {
    if (!this.accessToken || !this.identityToken) {
      throw new Error('Abstract Portal не авторизован');
    }
    // The live Portal client authenticates badge requests with the Privy identity
    // token only. Sending the access token as a second auth mechanism causes
    // inconsistent 401/429 behaviour on the badge backend.
    const response = await this.post(
      `${this.config.apiBase}${path}`,
      {},
      {
        'x-privy-token': this.identityToken,
      },
    );
    if (response.status >= 200 && response.status < 300) return response.body;
    if (options.validation && [400, 404, 409, 425].includes(response.status)) return undefined;
    const message = responseMessage(
      response.body,
      response.status === 400
        ? 'Abstract Portal ещё не готов выдать подпись (условие индексируется или уже склеймлено)'
        : `Abstract Portal HTTP ${response.status}`,
    );
    throw new PortalBadgeClaimError(message, response.status, retryAfterMs(response.headers));
  }

  hasSession(address: string): boolean {
    return (
      this.authenticatedAddress?.toLowerCase() === address.toLowerCase() &&
      Boolean(this.accessToken && this.identityToken)
    );
  }

  restoreSession(session: PortalAuthSession, address: string): boolean {
    if (session.address.toLowerCase() !== address.toLowerCase()) return false;
    this.accessToken = session.accessToken;
    this.identityToken = session.identityToken;
    this.authenticatedAddress = session.address;
    return true;
  }

  async authenticate(signer: GigaverseLoginSigner): Promise<PortalAuthSession> {
    const address = signer.account.address;
    const initialized = z
      .object({ nonce: z.string().min(8) })
      .parse(await this.privy('/api/v1/siwe/init', { address }));
    const message = buildPortalSiweMessage(address, initialized.nonce);
    const signature = await signer.signMessage({ message });
    const auth = PrivyAuthSchema.parse(
      await this.privy('/api/v1/siwe/authenticate', {
        signature,
        message,
        chainId: 'eip155:2741',
        walletClientType: null,
        connectorType: null,
        mode: 'login-or-sign-up',
      }),
    );
    this.accessToken = auth.token;
    this.identityToken = auth.identity_token;
    this.authenticatedAddress = address;
    return {
      address,
      userId: auth.user.id,
      accessToken: auth.token,
      identityToken: auth.identity_token,
      capturedAt: Date.now(),
    };
  }

  async claimBadge(
    address: string,
    badgeId: number,
  ): Promise<{ account: Address; signature: Hex }> {
    const claim = BadgeClaimSchema.parse(
      await this.backend(`/api/badge/${badgeId.toString()}/claim`),
    );
    const normalizedAddress = address.toLowerCase();
    if (claim.account.toLowerCase() !== normalizedAddress) {
      throw new Error('Abstract Portal вернул подпись для другого аккаунта');
    }
    if (BigInt(claim.badgeId) !== BigInt(badgeId)) {
      throw new Error('Abstract Portal вернул подпись для другого бейджа');
    }
    return { account: normalizedAddress as Address, signature: claim.signature as Hex };
  }
}

export async function mintPortalBadge(input: {
  client: PortalBadgeClaimClient;
  signer: GigaverseLoginSigner;
  sender: MarketplaceTransactionSender;
  badgeContract: Address;
  badgeId: number;
  address: Address;
  validationAttempts?: number;
  validationDelayMs?: number;
  claimAttempts?: number;
  claimDelayMs?: number;
  onTransactionSubmitted?: (txHash: Hex) => void | Promise<void>;
  onAuthenticated?: (session: PortalAuthSession) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PortalBadgeMintResult> {
  if (!input.client.hasSession(input.address)) {
    const session = await input.client.authenticate(input.signer);
    await input.onAuthenticated?.(session);
  }
  // Portal often needs minutes after the Gigaverse action before /claim returns a signature.
  // Prefer a few spaced attempts per job cycle; the outer hub job waits between cycles.
  const claimAttempts = input.claimAttempts ?? 1;
  const claimDelayMs = input.claimDelayMs ?? 60_000;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let claim: Awaited<ReturnType<PortalBadgeClaimClient['claimBadge']>> | undefined;
  let claimError: unknown;
  let nextClaimDelayMs = claimDelayMs;
  for (let attempt = 0; attempt < claimAttempts; attempt++) {
    if (attempt > 0) await sleep(nextClaimDelayMs);
    try {
      claim = await input.client.claimBadge(input.address, input.badgeId);
      break;
    } catch (error) {
      claimError = error;
      if (
        !(error instanceof PortalBadgeClaimError) ||
        ![400, 404, 409, 425, 429].includes(error.status)
      ) {
        throw error;
      }
      // Stop the whole mint immediately on 429 — more SIWE/claim spam makes Privy/Portal angrier.
      if (error.status === 429) {
        throw new PortalBadgeClaimError(
          error.message || 'Abstract Portal rate limit',
          429,
          Math.max(5 * 60_000, error.retryAfterMs ?? 0),
        );
      }
      nextClaimDelayMs = Math.min(5 * 60_000, claimDelayMs * Math.min(3, attempt + 1));
    }
  }
  if (!claim) throw claimError ?? new Error('Abstract Portal не выдал подпись бейджа');
  const data = encodeFunctionData({
    abi: PORTAL_BADGE_ABI,
    functionName: 'mintBadge',
    args: [claim.account, BigInt(input.badgeId), claim.signature],
  });
  const txHash = await input.sender.sendTransaction({
    to: input.badgeContract,
    data,
    value: 0n,
  });
  await input.onTransactionSubmitted?.(txHash);

  // Public Portal profile + the on-chain transaction are authoritative. The
  // undocumented /validate endpoint creates extra rate limits and is not used
  // by the current Portal web client, so the outer durable job polls the profile.
  return { badgeId: input.badgeId, account: claim.account, txHash, validated: false };
}
