import { describe, expect, it } from 'vitest';
import {
  hydrateAccountGameSession,
  parseBrowserGameSession,
  storedGameSessionForAccount,
  upsertStoredGameSession,
} from '../../src/api/browser-session.js';
import type { Account } from '../../src/vault/schema.js';

const ADDRESS = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;

function jwt(address: string, expiresAt: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ address, exp: Math.floor(expiresAt / 1000) }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

function account(): Account {
  return {
    name: 'acc1-aaaaaa',
    agwAddress: ADDRESS,
    proxy: { type: 'http', host: '127.0.0.1', port: 8080 },
  };
}

describe('browser Gigaverse sessions', () => {
  it('validates and normalizes a captured authResponse', () => {
    const now = 1_800_000_000_000;
    const expiresAt = now + 60_000;
    const result = parseBrowserGameSession(
      {
        jwt: jwt(ADDRESS.toUpperCase(), expiresAt),
        expiresAt,
        gameAccount: { username: 'tester' },
        user: { walletAddress: ADDRESS },
      },
      ADDRESS,
      now,
    );

    expect(result).toMatchObject({
      address: ADDRESS,
      expiresAt,
      gameAccount: { username: 'tester' },
      capturedAt: now,
    });
  });

  it('rejects a browser login made with another Abstract account', () => {
    const now = 1_800_000_000_000;
    expect(() =>
      parseBrowserGameSession(
        { jwt: jwt(OTHER, now + 60_000), expiresAt: now + 60_000 },
        ADDRESS,
        now,
      ),
    ).toThrow('другой Abstract-аккаунт');
  });

  it('hydrates only a matching, unexpired encrypted session', () => {
    const now = 1_800_000_000_000;
    const stored = parseBrowserGameSession(
      { jwt: jwt(ADDRESS, now + 60_000), expiresAt: now + 60_000 },
      ADDRESS,
      now,
    );
    const sessions = upsertStoredGameSession(undefined, stored);

    expect(storedGameSessionForAccount(sessions, account(), now)).toEqual(stored);
    expect(hydrateAccountGameSession(account(), sessions, now).jwt).toBe(stored.jwt);
    expect(storedGameSessionForAccount(sessions, account(), now + 120_000)).toBeUndefined();
  });
});
