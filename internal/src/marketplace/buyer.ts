import { encodeFunctionData, formatEther, type Address, type Hex } from 'viem';
import type { GigaClient } from '../api/client.js';
import { ITEM_MARKET_ABI, ITEM_MARKET_ADDRESS } from './abi.js';
import type { MarketplaceTransactionSender } from './lister.js';

export interface MarketplaceListing {
  listingId: bigint;
  itemId: number;
  owner: Address;
  priceWei: bigint;
  remaining: bigint;
}

export interface BuyCheapestItemInput {
  giga: Pick<GigaClient, 'get'>;
  sender: MarketplaceTransactionSender;
  buyer: string;
  itemIds: readonly number[];
  maxPriceWei: bigint;
}

export interface BuyCheapestItemResult extends MarketplaceListing {
  txHash: Hex;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value > 0n ? value : undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : undefined;
  }
  return undefined;
}

function positiveItemId(value: unknown): number | undefined {
  const parsed = positiveBigInt(value);
  if (parsed === undefined || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(parsed);
}

function entitiesFromResponse(raw: unknown): unknown[] {
  const root = objectValue(raw);
  if (!root) return [];
  if (Array.isArray(root['entities'])) return root['entities'];
  const data = objectValue(root['data']);
  return Array.isArray(data?.['entities']) ? data.entities : [];
}

export function parseMarketplaceListings(
  raw: unknown,
  expectedItemId: number,
): MarketplaceListing[] {
  const listings: MarketplaceListing[] = [];
  for (const value of entitiesFromResponse(raw)) {
    const entity = objectValue(value);
    if (!entity) continue;
    const listingId = positiveBigInt(entity['ID_CID'] ?? entity['docId']);
    const itemId = positiveItemId(entity['GAME_ITEM_ID_CID']);
    const priceWei = positiveBigInt(entity['ETH_MINT_PRICE_CID']);
    const remaining = positiveBigInt(entity['UINT256_CID']);
    const owner = typeof entity['OWNER_CID'] === 'string' ? entity['OWNER_CID'].toLowerCase() : '';
    if (
      listingId === undefined ||
      itemId !== expectedItemId ||
      priceWei === undefined ||
      remaining === undefined ||
      !/^0x[a-f0-9]{40}$/.test(owner)
    ) {
      continue;
    }
    listings.push({ listingId, itemId, priceWei, remaining, owner: owner as Address });
  }
  return listings;
}

export async function findCheapestItemListing(
  giga: Pick<GigaClient, 'get'>,
  itemIds: readonly number[],
  buyer: string,
): Promise<MarketplaceListing | undefined> {
  const normalizedBuyer = buyer.toLowerCase();
  const uniqueItemIds = Array.from(new Set(itemIds));
  const responses = await Promise.all(
    uniqueItemIds.map(async (itemId) => ({
      itemId,
      raw: await giga.get<unknown>(`/api/marketplace/item/listing/item/${itemId}`),
    })),
  );
  return responses
    .flatMap(({ raw, itemId }) => parseMarketplaceListings(raw, itemId))
    .filter((listing) => listing.owner.toLowerCase() !== normalizedBuyer)
    .sort((left, right) => {
      if (left.priceWei !== right.priceWei) return left.priceWei < right.priceWei ? -1 : 1;
      return left.listingId < right.listingId ? -1 : left.listingId > right.listingId ? 1 : 0;
    })[0];
}

export async function buyCheapestItem(input: BuyCheapestItemInput): Promise<BuyCheapestItemResult> {
  if (input.maxPriceWei <= 0n) throw new Error('Лимит покупки должен быть больше нуля');
  const listing = await findCheapestItemListing(input.giga, input.itemIds, input.buyer);
  if (!listing) throw new Error('В Gigamarket нет активных Dung или Butterfly');
  if (listing.priceWei > input.maxPriceWei) {
    throw new Error(
      `Floor выше лимита: ${formatEther(listing.priceWei)} ETH > ${formatEther(input.maxPriceWei)} ETH`,
    );
  }

  const data = encodeFunctionData({
    abi: ITEM_MARKET_ABI,
    functionName: 'buyListing',
    args: [listing.listingId, 1n],
  });
  const txHash = await input.sender.sendTransaction({
    to: ITEM_MARKET_ADDRESS,
    data,
    value: listing.priceWei,
  });
  return { ...listing, txHash };
}
