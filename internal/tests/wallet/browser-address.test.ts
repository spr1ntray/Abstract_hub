import { describe, expect, it } from 'vitest';
import { normalizeWalletAddress, preserveWalletAddress } from '../../src/shared/wallet-address.js';

describe('browser wallet addresses', () => {
  const checksumAddress = '0xAbCdEf0123456789aBCdeF0123456789abCDef01';

  it('normalizes account addresses used for identity comparisons', () => {
    expect(normalizeWalletAddress(checksumAddress)).toBe(checksumAddress.toLowerCase());
  });

  it('preserves signer casing required by the AGW personal_sign dispatcher', () => {
    expect(preserveWalletAddress(checksumAddress)).toBe(checksumAddress);
  });

  it('rejects malformed values', () => {
    expect(normalizeWalletAddress('0x1234')).toBeUndefined();
    expect(preserveWalletAddress(null)).toBeUndefined();
  });
});
