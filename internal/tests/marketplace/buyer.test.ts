import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { ITEM_MARKET_ABI, ITEM_MARKET_ADDRESS } from '../../src/marketplace/abi.js';
import {
  buyCheapestItem,
  findCheapestItemListing,
  parseMarketplaceListings,
} from '../../src/marketplace/buyer.js';

const buyer = `0x${'a'.repeat(40)}`;
const seller = `0x${'b'.repeat(40)}` as Address;

function listing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID_CID: '1232376',
    GAME_ITEM_ID_CID: 607,
    OWNER_CID: seller,
    ETH_MINT_PRICE_CID: 6_499_999_980_000,
    UINT256_CID: 994,
    ...overrides,
  };
}

describe('Gigamarket buyer', () => {
  it('parses only live listings for the requested item', () => {
    expect(
      parseMarketplaceListings(
        {
          entities: [
            listing(),
            listing({ ID_CID: '2', UINT256_CID: 0 }),
            listing({ ID_CID: '3', GAME_ITEM_ID_CID: 603 }),
          ],
        },
        607,
      ),
    ).toEqual([
      {
        listingId: 1_232_376n,
        itemId: 607,
        owner: seller,
        priceWei: 6_499_999_980_000n,
        remaining: 994n,
      },
    ]);
  });

  it('selects the true cheapest listing across Dung and Butterfly and ignores own sales', async () => {
    const get = vi.fn(async (path: string) =>
      path.endsWith('/607')
        ? { entities: [listing({ OWNER_CID: buyer, ETH_MINT_PRICE_CID: 1 }), listing()] }
        : {
            entities: [
              listing({
                ID_CID: '88',
                GAME_ITEM_ID_CID: 603,
                ETH_MINT_PRICE_CID: '6000000000000',
              }),
            ],
          },
    );
    await expect(
      findCheapestItemListing({ get } as never, [607, 603], buyer),
    ).resolves.toMatchObject({ listingId: 88n, itemId: 603, priceWei: 6_000_000_000_000n });
  });

  it('sends buyListing with exactly one item and the current floor as value', async () => {
    const get = vi.fn().mockResolvedValue({ entities: [listing()] });
    const sendTransaction = vi.fn().mockResolvedValue(`0x${'c'.repeat(64)}` as Hex);
    const result = await buyCheapestItem({
      giga: { get } as never,
      sender: { sendTransaction },
      buyer,
      itemIds: [607],
      maxPriceWei: 10_000_000_000_000n,
    });
    expect(result.priceWei).toBe(6_499_999_980_000n);
    const transaction = sendTransaction.mock.calls[0]?.[0];
    expect(transaction.to).toBe(ITEM_MARKET_ADDRESS);
    expect(transaction.value).toBe(result.priceWei);
    expect(decodeFunctionData({ abi: ITEM_MARKET_ABI, data: transaction.data })).toMatchObject({
      functionName: 'buyListing',
      args: [1_232_376n, 1n],
    });
  });

  it('refuses to spend above the user limit before sending a transaction', async () => {
    const sendTransaction = vi.fn();
    await expect(
      buyCheapestItem({
        giga: { get: vi.fn().mockResolvedValue({ entities: [listing()] }) } as never,
        sender: { sendTransaction },
        buyer,
        itemIds: [607],
        maxPriceWei: 6_000_000_000_000n,
      }),
    ).rejects.toThrow('Floor выше лимита');
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
