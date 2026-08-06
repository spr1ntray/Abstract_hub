import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Address, Hex } from 'viem';
import { resolveAccountSession } from '../../src/api/account-session.js';
import type { GigaverseLoginSigner } from '../../src/api/auth.js';
import type { LoginResult } from '../../src/api/types.js';
import type { Account } from '../../src/vault/schema.js';

const log = pino({ level: 'silent' });
const ADDRESS = `0x${'1'.repeat(40)}` as Address;

function jwt(expiresAt: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(expiresAt / 1000), address: ADDRESS }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

function account(expiresAt: number): Account {
  return {
    name: 'acc1-111111',
    jwt: jwt(expiresAt),
    agwAddress: ADDRESS,
    proxy: { type: 'http', host: '127.0.0.1', port: 8080 },
  };
}

function signer(): GigaverseLoginSigner {
  return {
    account: { address: ADDRESS },
    signMessage: vi.fn(async () => `0x${'a'.repeat(130)}` as Hex),
  };
}

describe('resolveAccountSession', () => {
  it('logs an Abstract-only account in through its delegated session', async () => {
    const now = 1_800_000_000_000;
    const loginResult: LoginResult = {
      jwt: jwt(now + 60_000),
      expiresAt: now + 60_000,
      gameAccount: {},
      user: {},
    };
    const makeDelegatedSigner = vi.fn(async () => signer());
    const login = vi.fn(async () => loginResult);

    const result = await resolveAccountSession({
      account: {
        name: 'acc1-111111',
        agwAddress: ADDRESS,
        sessionId: 'a'.repeat(32),
        proxy: { type: 'http', host: '127.0.0.1', port: 8080 },
      },
      log,
      makeDelegatedSigner,
      login,
    });

    expect(result).toMatchObject({ mode: 'delegated', refreshed: true, loginResult });
    expect(makeDelegatedSigner).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledOnce();
  });

  it('keeps a stored JWT that is not close to expiry', async () => {
    const now = 1_800_000_000_000;
    const makeDelegatedSigner = vi.fn(async () => signer());

    const result = await resolveAccountSession({
      account: account(now + 2 * 24 * 60 * 60_000),
      log,
      now,
      makeDelegatedSigner,
    });

    expect(result.mode).toBe('jwt');
    expect(result.refreshed).toBe(false);
    expect(makeDelegatedSigner).not.toHaveBeenCalled();
  });

  it('automatically refreshes a JWT through the delegated Abstract signer', async () => {
    const now = 1_800_000_000_000;
    const refreshed: LoginResult = {
      jwt: jwt(now + 7 * 24 * 60 * 60_000),
      expiresAt: now + 7 * 24 * 60 * 60_000,
      gameAccount: {},
      user: {},
    };
    const login = vi.fn(async () => refreshed);

    const result = await resolveAccountSession({
      account: account(now + 60_000),
      log,
      now,
      makeDelegatedSigner: async () => signer(),
      login,
    });

    expect(result.mode).toBe('delegated');
    expect(result.refreshed).toBe(true);
    expect(result.loginResult).toBe(refreshed);
    expect(login).toHaveBeenCalledOnce();
  });

  it('uses a still-valid JWT when a refresh attempt has a transient error', async () => {
    const now = 1_800_000_000_000;
    const result = await resolveAccountSession({
      account: account(now + 60_000),
      log,
      now,
      makeDelegatedSigner: async () => {
        throw new Error('temporary AGW outage');
      },
    });

    expect(result.mode).toBe('jwt');
    expect(result.refreshed).toBe(false);
  });

  it('returns an actionable reconnect error after the stored JWT expires', async () => {
    const now = 1_800_000_000_000;
    await expect(
      resolveAccountSession({
        account: account(now - 60_000),
        log,
        now,
        makeDelegatedSigner: async () => {
          throw new Error('missing sign_message');
        },
      }),
    ).rejects.toThrow('переподключите Abstract один раз');
  });
});
