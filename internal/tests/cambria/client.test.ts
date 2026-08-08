import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import packJson from '../../../hub-pack.json';
import type { GigaverseLoginSigner } from '../../src/api/auth.js';
import {
  buildCambriaSiweMessage,
  cambriaSessionSeedFromPrivyAuth,
  CambriaClient,
  CambriaInviteRequiredError,
  solveCambriaProofOfWork,
  type CambriaHttpRequest,
  type CambriaHttpResponse,
  type CambriaTransport,
} from '../../src/cambria/client.js';
import { HubPackSchema } from '../../src/hub/pack.js';

const pack = HubPackSchema.parse(packJson);
const address = `0x${'a'.repeat(40)}` as Address;
const signature = `0x${'b'.repeat(130)}` as Hex;

function signer(): GigaverseLoginSigner {
  return {
    account: { address },
    signMessage: vi.fn().mockResolvedValue(signature),
  };
}

function authResponse(): CambriaHttpResponse {
  return {
    status: 200,
    body: {
      user: { id: 'did:privy:cambria-test' },
      token: 'customer-token',
      refresh_token: 'refresh-token',
      identity_token: 'identity-token',
    },
    setCookies: ['cambria-session=server-cookie; Path=/; Secure'],
  };
}

const loot = {
  datasetVersion: 'genesis-1',
  eligible: true,
  scores: { total: 42, degen: 20, chad: 22 },
  chests: { common: 2, epic: 1, legendary: 0 },
  qualifications: [],
  evaluatedWalletCounts: { evm: 1, svm: 0 },
  claim: null,
  claimsEnabled: true,
};

function authenticatedTransport(
  requests: CambriaHttpRequest[],
  lobby: (input: CambriaHttpRequest) => CambriaHttpResponse,
): CambriaTransport {
  return async (input) => {
    requests.push(input);
    if (input.url.endsWith('/api/v1/siwe/init')) {
      return { status: 200, body: { nonce: 'nonce-for-cambria' } };
    }
    if (input.url.endsWith('/api/v1/siwe/authenticate')) return authResponse();
    return lobby(input);
  };
}

describe('Cambria Genesis client', () => {
  it('prepares SIWE on the backend and completes it with the browser signature', async () => {
    const requests: CambriaHttpRequest[] = [];
    const transport = authenticatedTransport(requests, (input) => {
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    });
    const client = new CambriaClient(pack.modules.cambria, transport);

    const challenge = await client.prepareAuthentication(address.toUpperCase());
    expect(challenge.message).toContain(`lobby.cambria.gg wants you to sign in`);
    expect(challenge.message).toContain(address);
    await expect(
      client.completeAuthentication({ address, message: challenge.message, signature }),
    ).resolves.toMatchObject({ address, customerToken: 'customer-token' });

    expect(requests[0]?.headers.origin).toBe('https://lobby.cambria.gg');
    expect(requests[1]?.headers.origin).toBe('https://lobby.cambria.gg');
  });

  it('captures only the expected Abstract account from the official Privy session', () => {
    const seed = cambriaSessionSeedFromPrivyAuth(
      {
        user: {
          id: 'did:privy:browser-session',
          linked_accounts: [
            {
              type: 'cross_app',
              smart_wallets: [{ address: address.toUpperCase() }],
            },
          ],
        },
        token: 'browser-customer-token',
        refresh_token: 'browser-refresh-token',
        identity_token: 'browser-identity-token',
      },
      address,
    );

    expect(seed).toMatchObject({
      address,
      userId: 'did:privy:browser-session',
      customerToken: 'browser-customer-token',
      refreshToken: 'browser-refresh-token',
      identityToken: 'browser-identity-token',
    });
    expect(seed.cookies).toContainEqual({ name: 'privy-token', value: 'browser-customer-token' });
    expect(() =>
      cambriaSessionSeedFromPrivyAuth(
        {
          user: {
            id: 'did:privy:wrong-account',
            linked_accounts: [{ address: `0x${'c'.repeat(40)}` }],
          },
          token: 'wrong-account-token',
        },
        address,
      ),
    ).toThrow(/другой Abstract-аккаунт/i);
  });

  it('restores the captured browser session without opening a managed browser', async () => {
    const requests: CambriaHttpRequest[] = [];
    const transport: CambriaTransport = async (input) => {
      requests.push(input);
      if (input.url.endsWith('/user/current')) {
        return { status: 200, body: { wallet_address: address, player_name: 'AbstractPilot' } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };
    const client = new CambriaClient(pack.modules.cambria, transport);
    client.restoreSession({
      address,
      userId: 'did:privy:browser-session',
      customerToken: 'browser-customer-token',
      refreshToken: 'browser-refresh-token',
      identityToken: 'browser-identity-token',
      cookies: [{ name: 'cambria-session', value: 'server-cookie' }],
    });

    await expect(client.ensureServerSession()).resolves.toBeUndefined();
    expect(requests[0]?.headers.cookie).toContain('privy-token=browser-customer-token');
    expect(requests[0]?.headers.cookie).toContain('cambria-session=server-cookie');
    expect(client.sessionSeed().address).toBe(address);
  });

  it('solves and submits Cambria server authentication proof-of-work', async () => {
    const requests: CambriaHttpRequest[] = [];
    const transport = authenticatedTransport(requests, (input) => {
      if (input.url.includes('/auth/pow?endpoint=verifySignature')) {
        return {
          status: 201,
          body: {
            problem: 'cambria-test',
            difficulty: 1,
            salt: 'salt-1',
            challengeId: 'challenge-1',
          },
        };
      }
      if (input.url.endsWith('/auth/pow')) return { status: 200, body: { accepted: true } };
      if (input.url.includes('/auth/verify?powChallengeId=challenge-1')) {
        return { status: 201, body: { success: true } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    });
    const client = new CambriaClient(pack.modules.cambria, transport);
    await client.authenticate(signer());

    await client.establishServerSession();

    const submission = requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/auth/pow'),
    );
    expect(JSON.parse(submission?.body ?? '{}')).toMatchObject({
      difficulty: 1,
      challengeId: 'challenge-1',
      solution: expect.stringMatching(/^\d+\|salt-1$/),
    });
    await expect(
      solveCambriaProofOfWork(
        { problem: 'impossible', difficulty: 10, salt: 'salt', challengeId: 'challenge' },
        1,
      ),
    ).resolves.toBeUndefined();
  });

  it('builds the chain 2741 SIWE message and reuses the Privy session for the dashboard', async () => {
    const requests: CambriaHttpRequest[] = [];
    const transport = authenticatedTransport(requests, (input) => {
      if (input.url.endsWith('/user/current')) {
        return { status: 200, body: { wallet_address: address, player_name: 'AbstractPilot' } };
      }
      if (input.url.endsWith('/user/update-linked-wallets')) return { status: 200, body: {} };
      if (input.url.endsWith('/scores/loot-drop')) return { status: 200, body: loot };
      if (input.url.endsWith('/points/genesis/summary')) {
        return {
          status: 200,
          body: { points: 1200, rolling24hPoints: 50, rank: 17, multiplier: 1.2 },
        };
      }
      if (input.url.endsWith('/points/genesis/quests')) {
        return {
          status: 200,
          body: { quests: [{ id: 'connect-wallet', completed: true, claimed: false }] },
        };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    });
    const client = new CambriaClient(pack.modules.cambria, transport);
    const walletSigner = signer();

    await client.authenticate(walletSigner);
    const dashboard = await client.dashboard();

    expect(dashboard.user.player_name).toBe('AbstractPilot');
    expect(dashboard.loot.chests).toEqual({ common: 2, epic: 1, legendary: 0 });
    expect(dashboard.points.rank).toBe(17);
    expect(walletSigner.signMessage).toHaveBeenCalledOnce();
    expect(walletSigner.signMessage).toHaveBeenCalledWith({
      message: expect.stringContaining('Chain ID: 2741'),
    });
    const authenticate = requests.find((request) =>
      request.url.endsWith('/api/v1/siwe/authenticate'),
    );
    expect(JSON.parse(authenticate?.body ?? '{}')).toMatchObject({
      chainId: 'eip155:2741',
      signature,
      walletClientType: 'abstract_global_wallet',
      connectorType: 'injected',
      mode: 'login-or-sign-up',
    });
    const lobbyRequest = requests.find((request) => request.url.endsWith('/user/current'));
    expect(lobbyRequest?.headers.authorization).toBeUndefined();
    expect(lobbyRequest?.headers.cookie).toContain('privy-token=customer-token');
    expect(lobbyRequest?.headers.cookie).toContain('cambria-session=server-cookie');
  });

  it('onboards a new Abstract wallet once with an invite code', async () => {
    const requests: CambriaHttpRequest[] = [];
    let currentUserCalls = 0;
    const transport = authenticatedTransport(requests, (input) => {
      if (input.url.endsWith('/user/current')) {
        currentUserCalls += 1;
        return currentUserCalls === 1
          ? { status: 404, body: { message: 'User not found' } }
          : { status: 200, body: { wallet_address: address, player_name: 'ahaaaaaaaaaa' } };
      }
      if (input.url.includes('/user/username?')) {
        return { status: 200, body: { available: true } };
      }
      if (
        input.url.endsWith('/user/username') ||
        input.url.endsWith('/user/character') ||
        input.url.endsWith('/invitation/validate') ||
        input.url.endsWith('/user/update-linked-wallets')
      ) {
        return { status: 200, body: {} };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    });
    const client = new CambriaClient(pack.modules.cambria, transport);
    await client.authenticate(signer());

    await expect(client.ensureOnboarded('Invite42')).resolves.toMatchObject({
      player_name: 'ahaaaaaaaaaa',
    });
    const invite = requests.find((request) => request.url.endsWith('/invitation/validate'));
    expect(JSON.parse(invite?.body ?? '{}')).toEqual({ code: 'invite42' });
    expect(requests.some((request) => request.url.endsWith('/user/character'))).toBe(true);
  });

  it('does not invent an invite code for a new account', async () => {
    const transport = authenticatedTransport([], (input) => {
      if (input.url.endsWith('/user/current')) {
        return { status: 404, body: { message: 'User not found' } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    });
    const client = new CambriaClient(pack.modules.cambria, transport);
    await client.authenticate(signer());
    await expect(client.ensureOnboarded()).rejects.toBeInstanceOf(CambriaInviteRequiredError);
  });

  it('claims an eligible allocation with the server dataset version', async () => {
    const requests: CambriaHttpRequest[] = [];
    const transport = authenticatedTransport(requests, (input) => {
      if (input.url.endsWith('/user/current')) {
        return { status: 200, body: { wallet_address: address, player_name: 'AbstractPilot' } };
      }
      if (input.url.endsWith('/user/update-linked-wallets')) return { status: 200, body: {} };
      if (input.url.endsWith('/scores/loot-drop/claim')) {
        return { status: 200, body: { success: true, claimId: 'claim-1' } };
      }
      if (input.url.endsWith('/scores/loot-drop')) return { status: 200, body: loot };
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    });
    const client = new CambriaClient(pack.modules.cambria, transport);
    await client.authenticate(signer());

    await expect(client.claimLoot()).resolves.toMatchObject({ status: 'claimed' });
    const claim = requests.find((request) => request.url.endsWith('/scores/loot-drop/claim'));
    expect(claim?.method).toBe('POST');
    expect(JSON.parse(claim?.body ?? '{}')).toEqual({ datasetVersion: 'genesis-1' });
  });

  it('submits CapSolver Turnstile tokens before finishing the POW session', async () => {
    const requests: CambriaHttpRequest[] = [];
    let turnstileCalls = 0;
    const transport = authenticatedTransport(requests, (input) => {
      if (input.url.endsWith('/turnstile/verify')) {
        turnstileCalls += 1;
        return { status: 200, body: { ok: true } };
      }
      if (input.url.includes('/auth/pow?endpoint=verifySignature')) {
        return {
          status: 201,
          body: {
            problem: 'cambria-test',
            difficulty: 1,
            salt: 'salt-1',
            challengeId: 'challenge-1',
          },
        };
      }
      if (input.url.endsWith('/auth/pow')) return { status: 200, body: { accepted: true } };
      if (input.url.includes('/auth/verify?powChallengeId=challenge-1')) {
        return { status: 201, body: { success: true } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    });
    const client = new CambriaClient(pack.modules.cambria, transport);
    await client.authenticate(signer());
    const solveTurnstile = vi.fn().mockResolvedValue('turnstile-token-xyz');

    await client.establishServerSession({ solveTurnstile });

    expect(solveTurnstile).toHaveBeenCalledOnce();
    expect(turnstileCalls).toBeGreaterThanOrEqual(1);
    const verify = requests.find((request) => request.url.endsWith('/turnstile/verify'));
    expect(JSON.parse(verify?.body ?? '{}')).toEqual({
      token: 'turnstile-token-xyz',
      action: 'user-auth-guard',
    });
    expect(requests.some((request) => request.url.includes('/auth/verify'))).toBe(true);
  });

  it('waits for Retry-After and retries a rate-limited dashboard request', async () => {
    let userCalls = 0;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const transport: CambriaTransport = async (input) => {
      if (input.url.endsWith('/user/current')) {
        userCalls += 1;
        if (userCalls === 1) {
          return {
            status: 429,
            body: { message: 'Too many requests. Please wait to try again.' },
            headers: { 'retry-after': '7' },
          };
        }
        return { status: 200, body: { wallet_address: address, player_name: 'AbstractPilot' } };
      }
      if (input.url.endsWith('/user/update-linked-wallets')) return { status: 200, body: {} };
      if (input.url.endsWith('/scores/loot-drop')) return { status: 200, body: loot };
      if (input.url.endsWith('/points/genesis/summary')) {
        return {
          status: 200,
          body: { points: 1200, rolling24hPoints: 50, rank: 17, multiplier: 1.2 },
        };
      }
      if (input.url.endsWith('/points/genesis/quests')) {
        return { status: 200, body: { quests: [] } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };
    const client = new CambriaClient(pack.modules.cambria, transport, undefined, sleep);
    client.useBrowserSession(address);

    await expect(client.dashboard()).resolves.toMatchObject({ points: { rank: 17 } });
    expect(userCalls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(7_000);
  });

  it('returns a long rate limit immediately instead of blocking the desktop request', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const transport = vi.fn<CambriaTransport>().mockResolvedValue({
      status: 429,
      body: { message: 'Too many requests. Please wait to try again.' },
    });
    const client = new CambriaClient(pack.modules.cambria, transport, undefined, sleep);
    client.useBrowserSession(address);

    await expect(client.dashboard()).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 180_000,
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps the SIWE text deterministic apart from the supplied timestamp', () => {
    expect(buildCambriaSiweMessage(address, 'nonce-1', '2026-07-31T12:00:00.000Z')).toContain(
      'Nonce: nonce-1\nIssued At: 2026-07-31T12:00:00.000Z',
    );
  });
});
