import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockAgent } from 'undici';
import { pino } from 'pino';
import { loginToGigaverse } from '../../src/api/auth.js';
import type { Account } from '../../src/vault/schema.js';
import type { AgwSigner } from '../../src/wallet/signer.js';

const silentLog = pino({ level: 'silent' });

/** Loose request shape matching undici MockResponseCallbackOptions. */
type ReqLike = {
  body?: unknown;
  headers?: unknown;
};

const FAKE_KEY = `0x${'a'.repeat(64)}` as `0x${string}`;
const FAKE_AGW = `0x${'1'.repeat(40)}` as `0x${string}`;
const FAKE_SIG = `0x${'f'.repeat(130)}` as `0x${string}`;
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.payload.sig';
const FAKE_EXPIRES = 1_800_000_000_000;

const stubAccount: Account = {
  name: 'test',
  privateKey: FAKE_KEY,
  proxy: { type: 'http', host: '127.0.0.1', port: 1 },
};

/** Build a minimal AgwSigner stub without hitting the chain. */
function makeStubAgw(opts: { sig?: `0x${string}`; address?: `0x${string}` } = {}): AgwSigner {
  return {
    account: { address: opts.address ?? FAKE_AGW },
    signMessage: vi.fn().mockResolvedValue(opts.sig ?? FAKE_SIG),
  } as unknown as AgwSigner;
}

describe('loginToGigaverse', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
  });

  afterEach(async () => {
    await agent.close();
  });

  /** Call loginToGigaverse with the mock agent injected as dispatcher. */
  function login(agw: AgwSigner) {
    return loginToGigaverse({ account: stubAccount, agw, log: silentLog, dispatcher: agent });
  }

  it('POSTs to /api/user/auth with correct body', async () => {
    let capturedBody: Record<string, unknown> | undefined;

    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/user/auth', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        capturedBody = JSON.parse(typeof req.body === 'string' ? req.body : '{}') as Record<
          string,
          unknown
        >;
        return { success: true, jwt: FAKE_JWT, expiresAt: FAKE_EXPIRES };
      });

    const agw = makeStubAgw();
    await login(agw);

    expect(capturedBody).toBeDefined();
    expect(capturedBody!['signature']).toBe(FAKE_SIG);
    expect(capturedBody!['address']).toBe(FAKE_AGW);
    expect(typeof capturedBody!['message']).toBe('string');
    expect((capturedBody!['message'] as string).startsWith('Login to Gigaverse at ')).toBe(true);
    expect(typeof capturedBody!['timestamp']).toBe('number');
  });

  it('returns { jwt, expiresAt } on success', async () => {
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/user/auth', method: 'POST' })
      .reply(200, { success: true, jwt: FAKE_JWT, expiresAt: FAKE_EXPIRES });

    const result = await login(makeStubAgw());
    expect(result.jwt).toBe(FAKE_JWT);
    expect(result.expiresAt).toBe(FAKE_EXPIRES);
  });

  it('throws when success is false', async () => {
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/user/auth', method: 'POST' })
      .reply(200, { success: false, message: 'invalid signature' });

    await expect(login(makeStubAgw())).rejects.toThrow(/Gigaverse login rejected/);
  });

  it('throws when jwt field is missing', async () => {
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/user/auth', method: 'POST' })
      .reply(200, { success: true, expiresAt: FAKE_EXPIRES });

    await expect(login(makeStubAgw())).rejects.toThrow(/missing jwt/);
  });

  it('throws when expiresAt field is missing', async () => {
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/user/auth', method: 'POST' })
      .reply(200, { success: true, jwt: FAKE_JWT });

    await expect(login(makeStubAgw())).rejects.toThrow(/missing expiresAt/);
  });

  it('uses signature from agw.signMessage', async () => {
    const customSig = `0x${'beef'.repeat(32)}01` as `0x${string}`;

    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/user/auth', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        const body = JSON.parse(typeof req.body === 'string' ? req.body : '{}') as Record<
          string,
          unknown
        >;
        return {
          success: true,
          jwt: FAKE_JWT,
          expiresAt: FAKE_EXPIRES,
          _capturedSig: body['signature'],
        };
      });

    const agw = makeStubAgw({ sig: customSig });
    const result = await login(agw);

    // signMessage was called exactly once with the correct message format
    expect((agw.signMessage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const callArg = (agw.signMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      message: string;
    };
    expect(callArg.message).toMatch(/^Login to Gigaverse at \d+$/);
    expect(result.jwt).toBe(FAKE_JWT);
  });

  it('throws HttpError on 4xx without retry', async () => {
    let calls = 0;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/user/auth', method: 'POST' })
      .reply(401, () => {
        calls++;
        return { message: 'unauthorized' };
      })
      .times(5); // allow extra — we expect exactly 1

    await expect(login(makeStubAgw())).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('retries on 5xx and eventually succeeds', async () => {
    const pool = agent.get('https://gigaverse.io');
    pool.intercept({ path: '/api/user/auth', method: 'POST' }).reply(500, {});
    pool
      .intercept({ path: '/api/user/auth', method: 'POST' })
      .reply(200, { success: true, jwt: FAKE_JWT, expiresAt: FAKE_EXPIRES });

    const result = await login(makeStubAgw());
    expect(result.jwt).toBe(FAKE_JWT);
  }, 10_000);

  it('passes gameAccount and user through to LoginResult', async () => {
    const fakeGameAccount = {
      username: 'player_one',
      canEnterGame: true,
      hasAcceptedLegal: true,
      noob: { _id: '75769', LEVEL_CID: 1 },
    };
    const fakeUser = { username: 'player_one' };

    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/user/auth', method: 'POST' })
      .reply(200, {
        success: true,
        jwt: FAKE_JWT,
        expiresAt: FAKE_EXPIRES,
        gameAccount: fakeGameAccount,
        user: fakeUser,
      });

    const result = await login(makeStubAgw());
    expect(result.gameAccount).toEqual(fakeGameAccount);
    expect(result.user).toEqual(fakeUser);
  });

  it('returns empty objects when gameAccount/user absent from response', async () => {
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/user/auth', method: 'POST' })
      .reply(200, { success: true, jwt: FAKE_JWT, expiresAt: FAKE_EXPIRES });

    const result = await login(makeStubAgw());
    expect(result.gameAccount).toEqual({});
    expect(result.user).toEqual({});
  });
});
