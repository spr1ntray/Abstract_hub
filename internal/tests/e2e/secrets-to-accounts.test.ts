/**
 * End-to-end smoke test: synthetic temp dir with accounts.txt + proxies.txt
 * → loadSecretsCore → parseAccountsFromText → asserts Account[] shape.
 *
 * Covers both credential modes:
 *   - private-key account (0x hex key)
 *   - JWT account (pre-baked eyJ... token with embedded address)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { loadSecretsCore } from '../../src/play.js';
import {
  migrateLegacyJwtAccountsText,
  parseAccountsFromText,
} from '../../src/config/load-from-files.js';

// ---------------------------------------------------------------------------
// Fixtures — valid real-looking values that pass parse validation
// ---------------------------------------------------------------------------

// 64-char hex private key (valid format; not a real key)
const PRIVATE_KEY = '0x' + 'deadbeef'.repeat(8);

// Minimal valid-format JWT: header.payload.sig where payload has address + exp
// address: 0x1234567890abcdef1234567890abcdef12345678 (40 hex chars)
function makeFakeJwt(agwAddress: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      address: agwAddress,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  const sig = Buffer.from('fakesig').toString('base64url');
  return `${header}.${payload}.${sig}`;
}

const AGW_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const JWT = makeFakeJwt(AGW_ADDRESS);
const SESSION_ID = 'a'.repeat(32);

const PROXY_HTTP = 'http://user:pass@proxy.example.com:8080';
const PROXY_COLON = '192.168.1.1:3128';

const PASSWORD = 'strongpassword99';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gigaverse-e2e-'));
}

function cfg(dir: string) {
  return {
    encPath: join(dir, 'secrets.enc'),
    accountsPath: join(dir, 'accounts.txt'),
    proxiesPath: join(dir, 'proxies.txt'),
  };
}

function makePromptQueue(...answers: string[]) {
  const queue = [...answers];
  return async (_message: string): Promise<string> => {
    const answer = queue.shift();
    if (answer === undefined) throw new Error('Unexpected extra prompt');
    return answer;
  };
}

function makeExitThrow(): (code: number) => never {
  return (code: number) => {
    throw new Error(`process.exit(${code})`);
  };
}

// ---------------------------------------------------------------------------
// E2E: private-key account + http proxy
// ---------------------------------------------------------------------------

describe('e2e: private-key + http proxy → Account[]', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    const c = cfg(dir);
    writeFileSync(c.accountsPath, PRIVATE_KEY + '\n');
    writeFileSync(c.proxiesPath, PROXY_HTTP + '\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads and returns a private-key Account with correct proxy shape', async () => {
    // First-time: two prompts (password + confirm)
    const prompt = makePromptQueue(PASSWORD, PASSWORD);
    const bundle = await loadSecretsCore(cfg(dir), prompt, makeExitThrow());

    const accounts = parseAccountsFromText({
      accountsText: bundle.accounts,
      proxiesText: bundle.proxies,
      accountsSourceLabel: 'accounts',
      proxiesSourceLabel: 'proxies',
    });

    expect(accounts).toHaveLength(1);
    const { account } = accounts[0]!;

    // Shape assertions
    expect(account.privateKey).toBe(PRIVATE_KEY);
    expect(account.jwt).toBeUndefined();
    expect(account.proxy.type).toBe('http');
    expect(account.proxy.host).toBe('proxy.example.com');
    expect(account.proxy.port).toBe(8080);
    expect(account.proxy.username).toBe('user');
    expect(account.proxy.password).toBe('pass');
    expect(account.name).toMatch(/^acc1-/);
  });
});

// ---------------------------------------------------------------------------
// E2E: JWT account + colon-format proxy
// ---------------------------------------------------------------------------

describe('e2e: JWT account + colon proxy → Account[]', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    const c = cfg(dir);
    writeFileSync(c.accountsPath, JWT + '\n');
    writeFileSync(c.proxiesPath, PROXY_COLON + '\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('recovers only the public Abstract address from the legacy token', async () => {
    const prompt = makePromptQueue(PASSWORD, PASSWORD);
    const bundle = await loadSecretsCore(cfg(dir), prompt, makeExitThrow());

    const accounts = parseAccountsFromText({
      accountsText: bundle.accounts,
      proxiesText: bundle.proxies,
      accountsSourceLabel: 'accounts',
      proxiesSourceLabel: 'proxies',
    });

    expect(accounts).toHaveLength(1);
    const { account } = accounts[0]!;

    expect(account.jwt).toBeUndefined();
    expect(account.privateKey).toBeUndefined();
    expect(account.agwAddress).toBe(AGW_ADDRESS.toLowerCase());
    expect(account.proxy.type).toBe('http');
    expect(account.proxy.host).toBe('192.168.1.1');
    expect(account.proxy.port).toBe(3128);
    expect(account.name).toMatch(/^acc1-/);
  });
});

describe('e2e: Abstract browser account without a stored JWT', () => {
  it('loads the public address and stable local session id', () => {
    const accounts = parseAccountsFromText({
      accountsText: `abstract:${AGW_ADDRESS} | session=${SESSION_ID} | underhaul`,
      proxiesText: PROXY_COLON,
    });

    expect(accounts[0]!.account).toMatchObject({
      agwAddress: AGW_ADDRESS,
      sessionId: SESSION_ID,
      dungeon: 3,
    });
    expect(accounts[0]!.account.jwt).toBeUndefined();
    expect(accounts[0]!.account.privateKey).toBeUndefined();
  });

  it('migrates a legacy JWT line without retaining the token', () => {
    const result = migrateLegacyJwtAccountsText(
      `${JWT} | signer=${PRIVATE_KEY} | session=${SESSION_ID} | 5000\n`,
    );

    expect(result.migrated).toBe(1);
    expect(result.accountsText).toBe(`abstract:${AGW_ADDRESS} | session=${SESSION_ID} | 5000\n`);
    expect(result.accountsText).not.toContain(JWT);
    expect(result.accountsText).not.toContain(PRIVATE_KEY);
  });
});

// ---------------------------------------------------------------------------
// E2E: multiple accounts (2 private-key + 2 proxies)
// ---------------------------------------------------------------------------

describe('e2e: multiple accounts', () => {
  let dir: string;
  const KEY_1 = '0x' + 'a'.repeat(64);
  const KEY_2 = '0x' + 'b'.repeat(64);
  const PROXY_1 = 'http://p1.example.com:3001';
  const PROXY_2 = 'http://p2.example.com:3002';

  beforeEach(() => {
    dir = makeTmpDir();
    const c = cfg(dir);
    writeFileSync(c.accountsPath, [KEY_1, KEY_2].join('\n') + '\n');
    writeFileSync(c.proxiesPath, [PROXY_1, PROXY_2].join('\n') + '\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns two accounts with correct keys and proxies', async () => {
    const prompt = makePromptQueue(PASSWORD, PASSWORD);
    const bundle = await loadSecretsCore(cfg(dir), prompt, makeExitThrow());

    const accounts = parseAccountsFromText({
      accountsText: bundle.accounts,
      proxiesText: bundle.proxies,
    });

    expect(accounts).toHaveLength(2);
    expect(accounts[0]!.account.privateKey).toBe(KEY_1);
    expect(accounts[0]!.account.proxy.port).toBe(3001);
    expect(accounts[1]!.account.privateKey).toBe(KEY_2);
    expect(accounts[1]!.account.proxy.port).toBe(3002);
  });
});

// ---------------------------------------------------------------------------
// Per-account dungeon override via `| <dungeon>` suffix
// ---------------------------------------------------------------------------

describe('parseAccountsFromText: per-account dungeon suffix', () => {
  const KEY_A = '0x' + 'a'.repeat(64);
  const KEY_B = '0x' + 'b'.repeat(64);
  const KEY_C = '0x' + 'c'.repeat(64);
  const PROXIES = ['http://p1.example.com:3001', 'http://p2:3002', 'http://p3:3003'].join('\n');

  it('parses "| 5000" → dungeon 1 and "| underhaul" → dungeon 3', () => {
    const accountsText = [`${KEY_A} | 5000`, `${KEY_B} | underhaul`, `${KEY_C}`].join('\n');
    const accounts = parseAccountsFromText({ accountsText, proxiesText: PROXIES });
    expect(accounts[0]!.account.dungeon).toBe(1);
    expect(accounts[1]!.account.dungeon).toBe(3);
    expect(accounts[2]!.account.dungeon).toBeUndefined();
  });

  it('rejects unknown dungeon suffix', () => {
    expect(() =>
      parseAccountsFromText({
        accountsText: `${KEY_A} | bogus`,
        proxiesText: 'http://p1:3001',
      }),
    ).toThrow(/unknown dungeon suffix/);
  });

  it('accepts numeric aliases 1 and 3', () => {
    const accountsText = [`${KEY_A} | 1`, `${KEY_B} | 3`].join('\n');
    const accounts = parseAccountsFromText({
      accountsText,
      proxiesText: ['http://p1:3001', 'http://p2:3002'].join('\n'),
    });
    expect(accounts[0]!.account.dungeon).toBe(1);
    expect(accounts[1]!.account.dungeon).toBe(3);
  });
});

describe('parseAccountsFromText: JWT with a Gigamarket signing key', () => {
  it('drops legacy token authentication and keeps the explicit private-key signer', () => {
    const accounts = parseAccountsFromText({
      accountsText: `${JWT} | signer=${PRIVATE_KEY} | underhaul`,
      proxiesText: PROXY_COLON,
    });

    expect(accounts[0]!.account).toMatchObject({
      privateKey: PRIVATE_KEY,
      agwAddress: AGW_ADDRESS.toLowerCase(),
      dungeon: 3,
    });
    expect(accounts[0]!.account.jwt).toBeUndefined();
  });

  it('rejects a malformed signer before account actions can start', () => {
    expect(() =>
      parseAccountsFromText({
        accountsText: `${JWT} | signer=not-a-private-key`,
        proxiesText: PROXY_COLON,
      }),
    ).toThrow(/invalid private key/);
  });

  it('rejects a different signer on a private-key account', () => {
    const otherKey = '0x' + 'a'.repeat(64);
    expect(() =>
      parseAccountsFromText({
        accountsText: `${PRIVATE_KEY} | signer=${otherKey}`,
        proxiesText: PROXY_COLON,
      }),
    ).toThrow(/signer key must match/);
  });
});

// ---------------------------------------------------------------------------
// E2E: round-trip — encrypt then decrypt returns identical text
// ---------------------------------------------------------------------------

describe('e2e: encryption round-trip preserves content', () => {
  let dir: string;
  const MULTI_ACCOUNTS = [
    '# comment line',
    PRIVATE_KEY,
    '   ', // blank line — should be filtered out by parseAccountsFromText
    JWT,
  ].join('\n');
  const MULTI_PROXIES = ['# comment', PROXY_HTTP, '', PROXY_COLON].join('\n');

  beforeEach(() => {
    dir = makeTmpDir();
    const c = cfg(dir);
    writeFileSync(c.accountsPath, MULTI_ACCOUNTS);
    writeFileSync(c.proxiesPath, MULTI_PROXIES);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips raw text content faithfully through encrypt/decrypt', async () => {
    const prompt = makePromptQueue(PASSWORD, PASSWORD);
    const bundle = await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    // Raw text must be preserved byte-for-byte
    expect(bundle.accounts).toBe(MULTI_ACCOUNTS);
    expect(bundle.proxies).toBe(MULTI_PROXIES);
  });
});
