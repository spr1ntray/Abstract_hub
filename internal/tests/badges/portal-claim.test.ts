import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import packJson from '../../../hub-pack.json';
import type { GigaverseLoginSigner } from '../../src/api/auth.js';
import {
  buildPortalSiweMessage,
  mintPortalBadge,
  PortalBadgeClaimClient,
  PORTAL_BADGE_ABI,
  type PortalClaimHttpRequest,
} from '../../src/badges/portal-claim.js';
import { HubPackSchema } from '../../src/hub/pack.js';

const config = HubPackSchema.parse(packJson).modules.abstractBadges;
const address = `0x${'a'.repeat(40)}` as Address;
const signature = `0x${'b'.repeat(130)}` as Hex;
const claimSignature = `0x${'c'.repeat(130)}` as Hex;

function signer(): GigaverseLoginSigner {
  return {
    account: { address },
    signMessage: vi.fn().mockResolvedValue(signature),
  };
}

describe('Abstract Portal badge claim', () => {
  it('uses the official Portal SIWE domain and chain', () => {
    const message = buildPortalSiweMessage(address, 'portal-nonce', '2026-08-01T12:00:00.000Z');
    expect(message).toContain('portal.abs.xyz wants you to sign in');
    expect(message).toContain('URI: https://portal.abs.xyz');
    expect(message).toContain('Chain ID: 2741');
  });

  it('authenticates, verifies the signed claim and submits one mint transaction', async () => {
    const requests: PortalClaimHttpRequest[] = [];
    let validations = 0;
    const client = new PortalBadgeClaimClient(config, async (request) => {
      requests.push(request);
      if (request.url.endsWith('/api/v1/siwe/init')) {
        return { status: 200, body: { nonce: 'portal-nonce-123' } };
      }
      if (request.url.endsWith('/api/v1/siwe/authenticate')) {
        return {
          status: 200,
          body: {
            user: { id: 'did:privy:portal' },
            token: 'access-token',
            identity_token: 'identity-token',
          },
        };
      }
      if (request.url.endsWith('/api/badge/58/claim')) {
        return {
          status: 200,
          body: { account: address, badgeId: '58', signature: claimSignature },
        };
      }
      if (request.url.endsWith('/api/badge/58/validate')) {
        validations += 1;
        return validations === 1
          ? { status: 409, body: { error: 'not indexed' } }
          : { status: 200, body: { badgeId: '58' } };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const sendTransaction = vi.fn().mockResolvedValue(`0x${'d'.repeat(64)}` as Hex);
    const onTransactionSubmitted = vi.fn();

    const result = await mintPortalBadge({
      client,
      signer: signer(),
      sender: { sendTransaction },
      badgeContract: config.badgeContract,
      badgeId: 58,
      address,
      validationDelayMs: 0,
      onTransactionSubmitted,
    });

    expect(result.validated).toBe(false);
    expect(onTransactionSubmitted).toHaveBeenCalledWith(`0x${'d'.repeat(64)}`);
    expect(validations).toBe(0);
    const backendClaim = requests.find((request) => request.url.endsWith('/claim'))!;
    expect(backendClaim.headers.authorization).toBeUndefined();
    expect(backendClaim.headers['x-privy-token']).toBe('identity-token');
    expect(backendClaim.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    const transaction = sendTransaction.mock.calls[0]?.[0];
    const decoded = decodeFunctionData({ abi: PORTAL_BADGE_ABI, data: transaction.data });
    expect(decoded.functionName).toBe('mintBadge');
    expect(decoded.args?.[0].toLowerCase()).toBe(address);
    expect(decoded.args?.slice(1)).toEqual([58n, claimSignature]);
  });

  it('refuses a claim signature issued to another wallet', async () => {
    const client = new PortalBadgeClaimClient(config, async (request) => {
      if (request.url.endsWith('/siwe/init')) return { status: 200, body: { nonce: 'nonce-1234' } };
      if (request.url.endsWith('/siwe/authenticate')) {
        return {
          status: 200,
          body: { user: { id: 'u' }, token: 'access', identity_token: 'identity' },
        };
      }
      return {
        status: 200,
        body: { account: `0x${'e'.repeat(40)}`, badgeId: 58, signature: claimSignature },
      };
    });
    await client.authenticate(signer());
    await expect(client.claimBadge(address, 58)).rejects.toThrow('другого аккаунта');
  });

  it('reuses an authenticated Privy session across durable claim cycles', async () => {
    const client = new PortalBadgeClaimClient(config, async (request) => {
      if (request.url.endsWith('/claim')) {
        return {
          status: 200,
          body: { account: address, badgeId: 58, signature: claimSignature },
        };
      }
      throw new Error(`Unexpected re-authentication request ${request.url}`);
    });
    expect(
      client.restoreSession(
        {
          address,
          userId: 'did:privy:cached',
          accessToken: 'cached-access',
          identityToken: 'cached-identity',
          capturedAt: Date.now(),
        },
        address,
      ),
    ).toBe(true);
    const loginSigner = signer();
    await expect(
      mintPortalBadge({
        client,
        signer: loginSigner,
        sender: { sendTransaction: vi.fn().mockResolvedValue(`0x${'d'.repeat(64)}` as Hex) },
        badgeContract: config.badgeContract,
        badgeId: 58,
        address,
      }),
    ).resolves.toMatchObject({ validated: false });
    expect(loginSigner.signMessage).not.toHaveBeenCalled();
  });

  it('retries claim several times while Portal indexes eligibility', async () => {
    let claimCalls = 0;
    const client = new PortalBadgeClaimClient(config, async (request) => {
      if (request.url.endsWith('/siwe/init')) return { status: 200, body: { nonce: 'nonce-1234' } };
      if (request.url.endsWith('/siwe/authenticate')) {
        return {
          status: 200,
          body: { user: { id: 'u' }, token: 'access', identity_token: 'identity' },
        };
      }
      if (request.url.endsWith('/validate')) {
        return claimCalls < 3
          ? { status: 404, body: { error: 'not minted' } }
          : { status: 200, body: { badgeId: 58 } };
      }
      if (request.url.endsWith('/claim')) {
        claimCalls += 1;
        return claimCalls < 3
          ? { status: 400, body: { message: 'Requirements not met' } }
          : {
              status: 200,
              body: { account: address, badgeId: 58, signature: claimSignature },
            };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const sendTransaction = vi.fn().mockResolvedValue(`0x${'d'.repeat(64)}` as Hex);

    await expect(
      mintPortalBadge({
        client,
        signer: signer(),
        sender: { sendTransaction },
        badgeContract: config.badgeContract,
        badgeId: 58,
        address,
        claimAttempts: 4,
        claimDelayMs: 1_000,
        validationAttempts: 1,
        sleep,
      }),
    ).resolves.toMatchObject({ validated: false, txHash: `0x${'d'.repeat(64)}` });
    expect(claimCalls).toBe(3);
    expect(sendTransaction).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalled();
  });

  it('aborts a rate-limited claim so the hub can cool down instead of spamming Privy', async () => {
    let claimCalls = 0;
    const client = new PortalBadgeClaimClient(config, async (request) => {
      if (request.url.endsWith('/siwe/init')) return { status: 200, body: { nonce: 'nonce-1234' } };
      if (request.url.endsWith('/siwe/authenticate')) {
        return {
          status: 200,
          body: { user: { id: 'u' }, token: 'access', identity_token: 'identity' },
        };
      }
      if (request.url.endsWith('/validate')) {
        return { status: 404, body: { error: 'not minted' } };
      }
      if (request.url.endsWith('/claim')) {
        claimCalls += 1;
        return {
          status: 429,
          body: { message: 'Too many requests' },
          headers: { 'retry-after': '7' },
        };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });

    await expect(
      mintPortalBadge({
        client,
        signer: signer(),
        sender: {
          sendTransaction: vi.fn().mockResolvedValue(`0x${'d'.repeat(64)}` as Hex),
        },
        badgeContract: config.badgeContract,
        badgeId: 58,
        address,
        claimAttempts: 2,
        validationAttempts: 1,
      }),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 300_000 });
    expect(claimCalls).toBe(1);
  });

  it('defers an ambiguous claim response to the public profile poll', async () => {
    let validations = 0;
    const client = new PortalBadgeClaimClient(config, async (request) => {
      if (request.url.endsWith('/api/v1/siwe/init')) {
        return { status: 200, body: { nonce: 'portal-nonce-123' } };
      }
      if (request.url.endsWith('/api/v1/siwe/authenticate')) {
        return {
          status: 200,
          body: { user: { id: 'u' }, token: 'access', identity_token: 'identity' },
        };
      }
      if (request.url.endsWith('/validate')) {
        validations += 1;
        return validations === 1
          ? { status: 404, body: { error: 'not indexed' } }
          : { status: 200, body: { badgeId: 58 } };
      }
      if (request.url.endsWith('/claim')) {
        return { status: 400, body: { message: 'Claim is already being processed' } };
      }
      throw new Error(`Unexpected request ${request.url}`);
    });
    const sendTransaction = vi.fn();

    await expect(
      mintPortalBadge({
        client,
        signer: signer(),
        sender: { sendTransaction },
        badgeContract: config.badgeContract,
        badgeId: 58,
        address,
        claimAttempts: 1,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
