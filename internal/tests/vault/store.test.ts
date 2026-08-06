import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VaultStore } from '../../src/vault/store.js';
import { encryptVault } from '../../src/vault/crypto.js';

describe('VaultStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gbv-'));
  });

  it('round-trips data through file', async () => {
    const store = new VaultStore(join(dir, 'vault.enc'));
    await store.save(
      {
        version: 2,
        accounts: [
          {
            name: 'alice',
            privateKey: '0x' + 'a'.repeat(64),
            proxy: { type: 'http', host: 'p.com', port: 8080 },
          },
        ],
      },
      'pw',
    );
    const loaded = await store.load('pw');
    expect(loaded.accounts).toHaveLength(1);
    expect(loaded.accounts[0]!.name).toBe('alice');
    expect(loaded.accounts[0]!.privateKey).toBe('0x' + 'a'.repeat(64));
    expect(loaded.accounts[0]!.proxy.host).toBe('p.com');
  });

  it('validates schema on load — rejects bad name', async () => {
    const store = new VaultStore(join(dir, 'vault.enc'));
    await expect(
      store.save(
        {
          version: 2,
          accounts: [
            {
              name: 'has spaces!', // regex rejects spaces + punctuation
              privateKey: '0x' + 'a'.repeat(64),
              proxy: { type: 'http', host: 'p.com', port: 8080 },
            },
          ],
        },
        'pw',
      ),
    ).rejects.toThrow();
  });

  it('validates schema on load — rejects missing privateKey', async () => {
    // Directly encrypt a blob that is missing privateKey to simulate tampered data
    const blob = await encryptVault(
      {
        version: 2,
        accounts: [{ name: 'alice', proxy: { type: 'http', host: 'p.com', port: 8080 } }],
      },
      'pw',
    );
    const path = join(dir, 'vault.enc');
    writeFileSync(path, blob);
    await expect(new VaultStore(path).load('pw')).rejects.toThrow();
  });

  it('throws when file missing', async () => {
    const store = new VaultStore(join(dir, 'missing.enc'));
    await expect(store.load('pw')).rejects.toThrow(/no such file/i);
  });

  it('migrates v1 single-account blob to v2, drops sessionToken', async () => {
    // Write out an OLD-shape vault file directly, then load via VaultStore.
    // sessionToken (v1 cookie field) must be silently dropped in migration.
    const v1Raw = {
      privateKey: '0x' + 'b'.repeat(64),
      proxy: { type: 'http' as const, host: 'old.proxy', port: 9999 },
      capsolver: { apiKey: 'CAP-XYZ', preferredTask: 'AntiTurnstileTaskProxyLess' },
      sessionToken: 'privy-token=COOKIE',
      sessionExpiresAt: 1_700_000_000_000,
      agwAddress: '0x1234567890abcdef1234567890abcdef12345678',
    };
    const blob = await encryptVault(v1Raw, 'pw');
    const path = join(dir, 'vault.enc');
    writeFileSync(path, blob);

    const store = new VaultStore(path);
    const loaded = await store.load('pw');

    expect(loaded.version).toBe(2);
    expect(loaded.accounts).toHaveLength(1);
    const acc = loaded.accounts[0]!;
    expect(acc.name).toBe('default');
    expect(acc.privateKey).toBe('0x' + 'b'.repeat(64));
    expect(acc.proxy).toEqual({ type: 'http', host: 'old.proxy', port: 9999 });
    expect(acc.capsolver).toEqual({
      apiKey: 'CAP-XYZ',
      preferredTask: 'AntiTurnstileTaskProxyLess',
    });
    // sessionToken MUST be dropped — no more cookie auth
    expect((acc as Record<string, unknown>)['sessionCookie']).toBeUndefined();
    expect(acc.agwAddress).toBe('0x1234567890abcdef1234567890abcdef12345678');
  });

  it('passes through already-v2 blobs unchanged', async () => {
    const store = new VaultStore(join(dir, 'vault.enc'));
    await store.save(
      {
        version: 2,
        accounts: [
          {
            name: 'bob',
            privateKey: '0x' + 'c'.repeat(64),
            proxy: { type: 'socks5', host: 'p.com', port: 1080 },
          },
        ],
      },
      'pw',
    );
    const loaded = await store.load('pw');
    expect(loaded.accounts[0]!.name).toBe('bob');
  });
});
