import { describe, it, expect } from 'vitest';
import { encryptVault, decryptVault } from '../../src/vault/crypto.js';

describe('vault crypto', () => {
  it('encrypts then decrypts to same data', async () => {
    const data = { privateKey: '0xabc', proxy: { host: 'p.com' } };
    const password = 'correct horse battery staple';
    const blob = await encryptVault(data, password);
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(blob.byteLength).toBeGreaterThan(32);

    const decrypted = await decryptVault(blob, password);
    expect(decrypted).toEqual(data);
  });

  it('throws on wrong password', async () => {
    const blob = await encryptVault({ a: 1 }, 'right');
    await expect(decryptVault(blob, 'wrong')).rejects.toThrow();
  });

  it('produces different ciphertext for same data (random nonce)', async () => {
    const a = await encryptVault({ x: 1 }, 'p');
    const b = await encryptVault({ x: 1 }, 'p');
    expect(Buffer.from(a).toString('hex')).not.toEqual(Buffer.from(b).toString('hex'));
  });
});
