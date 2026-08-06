import { describe, it, expect } from 'vitest';
import { createPublicClient, http, type PublicClient } from 'viem';
import { abstract } from 'viem/chains';
import { deriveSalt, resolveAgwAddress } from '../../src/wallet/agw-factory.js';

describe('deriveSalt', () => {
  it('keccak256(toBytes(initialSigner)) matches a deterministic fixture', () => {
    const signer = '0x1111111111111111111111111111111111111111';
    const expected = '0xe2c07404b8c1df4c46226425cac68c28d27a766bbddce62309f36724839b22c0';
    expect(deriveSalt(signer)).toBe(expected);
  });
});

describe.skipIf(process.env.SKIP_RPC === '1')('resolveAgwAddress (live RPC)', () => {
  it('resolves a deterministic signer to its AGW address', async () => {
    const client = createPublicClient({
      chain: abstract,
      transport: http(process.env.RPC_URL ?? 'https://api.mainnet.abs.xyz'),
    });
    const agw = await resolveAgwAddress(
      client as unknown as PublicClient,
      '0x1111111111111111111111111111111111111111',
    );
    expect(agw.toLowerCase()).toBe('0xfe7afe6fa18c7dae62c4fd66c6b4c480c589b87f');
  }, 15_000); // 15s timeout for network
});
