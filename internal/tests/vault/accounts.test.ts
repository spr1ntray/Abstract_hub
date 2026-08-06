import { describe, it, expect } from 'vitest';
import {
  addAccount,
  findAccount,
  removeAccount,
  updateAccount,
  renameAccount,
  requireAccount,
  summarize,
} from '../../src/vault/accounts.js';
import type { Vault, Account } from '../../src/vault/schema.js';

const FAKE_KEY = `0x${'a'.repeat(64)}` as `0x${string}`;

function mkVault(): Vault {
  return { version: 2, accounts: [] };
}

function mkAccount(name: string, over: Partial<Account> = {}): Account {
  return {
    name,
    privateKey: FAKE_KEY,
    proxy: { type: 'http', host: 'p.com', port: 8080 },
    ...over,
  };
}

describe('account helpers', () => {
  it('add then find', () => {
    let v = mkVault();
    v = addAccount(v, mkAccount('alice'));
    expect(findAccount(v, 'alice')?.name).toBe('alice');
    expect(findAccount(v, 'bob')).toBeUndefined();
  });

  it('addAccount rejects duplicate', () => {
    const v = addAccount(mkVault(), mkAccount('alice'));
    expect(() => addAccount(v, mkAccount('alice'))).toThrow(/already exists/);
  });

  it('remove', () => {
    let v = addAccount(mkVault(), mkAccount('alice'));
    v = addAccount(v, mkAccount('bob'));
    v = removeAccount(v, 'alice');
    expect(v.accounts.map((a) => a.name)).toEqual(['bob']);
  });

  it('removeAccount rejects unknown', () => {
    expect(() => removeAccount(mkVault(), 'ghost')).toThrow(/not found/);
  });

  it('update merges partial', () => {
    let v = addAccount(mkVault(), mkAccount('alice'));
    // Update agwAddress — a typical post-add patch
    v = updateAccount(v, 'alice', { agwAddress: '0x' + 'b'.repeat(40) });
    expect(findAccount(v, 'alice')?.agwAddress).toBe('0x' + 'b'.repeat(40));
    expect(findAccount(v, 'alice')?.proxy.host).toBe('p.com');
  });

  it('rename', () => {
    let v = addAccount(mkVault(), mkAccount('alice'));
    v = renameAccount(v, 'alice', 'alice2');
    expect(findAccount(v, 'alice2')?.name).toBe('alice2');
    expect(findAccount(v, 'alice')).toBeUndefined();
  });

  it('rename rejects collision', () => {
    let v = addAccount(mkVault(), mkAccount('alice'));
    v = addAccount(v, mkAccount('bob'));
    expect(() => renameAccount(v, 'alice', 'bob')).toThrow(/already in use/);
  });

  it('requireAccount throws with helpful message', () => {
    const v = addAccount(mkVault(), mkAccount('alice'));
    expect(() => requireAccount(v, 'ghost')).toThrow(/Available: alice/);
  });

  it('summarize redacts privateKey and shows AGW', () => {
    const acc = mkAccount('alice', {
      privateKey: FAKE_KEY,
      agwAddress: '0x1234567890abcdef1234567890abcdef12345678',
      capsolver: { apiKey: 'CAP-SECRET', preferredTask: 'AntiTurnstileTaskProxyLess' },
    });
    const out = summarize(acc);
    // full 64-hex key must NOT appear verbatim
    expect(out).not.toContain('a'.repeat(64));
    expect(out).not.toContain('CAP-SECRET');
    expect(out).toContain('AGW=0x1234567890abcdef1234567890abcdef12345678');
    expect(out).toContain('capsolver=configured');
    // should contain a short redacted key prefix
    expect(out).toContain('key=0xaaaaaa...');
  });
});
