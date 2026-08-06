import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { deriveSalt } from '../../src/wallet/agw-factory.js';
import { validateKey } from '../../src/wallet/cli.js';

describe('wallet generate logic', () => {
  it('generated key is valid hex and produces an address', () => {
    const pk = generatePrivateKey();
    expect(pk).toMatch(/^0x[a-fA-F0-9]{64}$/);
    const acc = privateKeyToAccount(pk);
    expect(acc.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(deriveSalt(acc.address)).toMatch(/^0x[a-fA-F0-9]{64}$/);
  });
});

describe('validateKey', () => {
  it('accepts a well-formed 0x-prefixed 64-hex key', () => {
    expect(validateKey('0x0000000000000000000000000000000000000000000000000000000000000001')).toBe(
      true,
    );
    expect(validateKey('0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789')).toBe(
      true,
    );
    expect(validateKey('0xABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789')).toBe(
      true,
    );
  });

  it('rejects missing prefix, wrong length, and non-hex characters', () => {
    expect(validateKey('')).toBe(false);
    expect(validateKey('0xINVALID')).toBe(false);
    // Missing 0x prefix
    expect(validateKey('0000000000000000000000000000000000000000000000000000000000000001')).toBe(
      false,
    );
    // 63 hex chars (too short)
    expect(validateKey('0x000000000000000000000000000000000000000000000000000000000000001')).toBe(
      false,
    );
    // 65 hex chars (too long)
    expect(validateKey('0x00000000000000000000000000000000000000000000000000000000000000011')).toBe(
      false,
    );
    // Non-hex character
    expect(validateKey('0x000000000000000000000000000000000000000000000000000000000000000g')).toBe(
      false,
    );
  });
});
