import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import { isAddress } from 'viem';
import { listOne } from '../../src/marketplace/lister.js';
import type { GigaClient } from '../../src/api/client.js';
import type { AgwSigner } from '../../src/wallet/signer.js';

const silentLog = pino({ level: 'silent' });

describe('listOne', () => {
  it('requests server signature, encodes call, sends tx', async () => {
    const giga = {
      post: vi.fn().mockResolvedValue({ signature: '0xdeadbeef' as `0x${string}`, nonce: 42 }),
    } as unknown as GigaClient;
    const agw = {
      sendTransaction: vi.fn().mockResolvedValue('0xtxhash' as `0x${string}`),
    } as unknown as AgwSigner;

    const result = await listOne({
      giga,
      agw,
      itemId: 192,
      priceWei: 99_000_000_000_000n,
      log: silentLog,
    });

    expect(result.txHash).toBe('0xtxhash');
    expect(result.nonce).toBe(42);

    const postCall = (giga.post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(postCall?.[0]).toBe('/api/marketplace/item/listing/create');
    expect(postCall?.[1]).toEqual({ itemId: '192', amount: 1, costPerItem: '99000000000000' });
    expect(postCall?.[2]).toEqual({ authed: true });

    const sendCall = (agw.sendTransaction as ReturnType<typeof vi.fn>).mock.calls[0];
    const sendArg = sendCall?.[0] as { to: string; data: string; value: bigint };
    expect(isAddress(sendArg.to)).toBe(true);
    expect(sendArg.to.toLowerCase()).toBe('0x37d6dbfa9f82ac4acc86d49702ac0612d3aa1afe');
    expect(sendArg.value).toBe(0n);
    // Selector for createListing(uint256,uint256,uint256,uint256,bytes) is 0x2752571e
    expect(sendArg.data.slice(0, 10)).toBe('0x2752571e');
  });

  it('supports custom amount', async () => {
    const giga = {
      post: vi.fn().mockResolvedValue({ signature: '0xabcd' as `0x${string}`, nonce: 7 }),
    } as unknown as GigaClient;
    const agw = {
      sendTransaction: vi.fn().mockResolvedValue('0xtx2' as `0x${string}`),
    } as unknown as AgwSigner;

    await listOne({
      giga,
      agw,
      itemId: 5,
      amount: 3,
      priceWei: 100n,
      log: silentLog,
    });

    const postCall = (giga.post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(postCall?.[1]).toMatchObject({ itemId: '5', amount: 3, costPerItem: '100' });
  });

  it.each([
    [21, 'Wood'],
    [25, 'Stone'],
  ])('rejects protected resource %s (%s) before any side effect', async (itemId, name) => {
    const giga = { post: vi.fn() } as unknown as GigaClient;
    const agw = { sendTransaction: vi.fn() } as unknown as AgwSigner;

    await expect(
      listOne({ giga, agw, itemId, amount: 10, priceWei: 100n, log: silentLog }),
    ).rejects.toThrow(`${name} защищен от продажи`);
    expect(giga.post).not.toHaveBeenCalled();
    expect(agw.sendTransaction).not.toHaveBeenCalled();
  });
});
