import type { Logger } from 'pino';
import {
  createPublicClient,
  encodeFunctionData,
  http,
  isAddress,
  type Address,
  type Hex,
} from 'viem';
import { abstract } from 'viem/chains';
import type { GigaClient } from '../api/client.js';
import { GIGA_JUICE_ABI, GIGA_JUICE_ADDRESS, ITEM_MARKET_ABI, ITEM_MARKET_ADDRESS } from './abi.js';
import { protectedMarketItemName } from './pricing.js';

export interface MarketplaceTransactionSender {
  sendTransaction(args: { to: Address; data: Hex; value?: bigint }): Promise<Hex>;
}

export interface ListOneInput {
  giga: GigaClient;
  agw: MarketplaceTransactionSender;
  itemId: number;
  amount?: number;
  priceWei: bigint;
  sellerAddress: string;
  log: Logger;
  listingPolicyReader?: MarketplaceListingPolicyReader;
}

export interface ListOneResult {
  txHash: `0x${string}`;
  nonce: number;
  listingFeeWei: bigint;
}

export interface MarketplaceListingPolicy {
  isPlayerJuiced: boolean;
  unjuicedListingEnabled: boolean;
  unjuicedListingFeeWei: bigint;
  feeWei: bigint;
  blocked: boolean;
}

export type MarketplaceListingPolicyReader = (
  sellerAddress: Address,
) => Promise<MarketplaceListingPolicy>;

interface ListingCreateResponse {
  signature: `0x${string}`;
  nonce: number;
}

const marketplacePublicClient = createPublicClient({
  chain: abstract,
  transport: http(),
});

/** Mirrors the live Gigaverse marketplace policy immediately before a listing. */
export const readMarketplaceListingPolicy: MarketplaceListingPolicyReader = async (
  sellerAddress,
) => {
  const [isPlayerJuiced, unjuicedListingEnabled, unjuicedListingFeeWei] = await Promise.all([
    marketplacePublicClient.readContract({
      address: GIGA_JUICE_ADDRESS,
      abi: GIGA_JUICE_ABI,
      functionName: 'isPlayerJuiced',
      args: [sellerAddress],
    }),
    marketplacePublicClient.readContract({
      address: ITEM_MARKET_ADDRESS,
      abi: ITEM_MARKET_ABI,
      functionName: 'getUnjuicedListingEnabled',
    }),
    marketplacePublicClient.readContract({
      address: ITEM_MARKET_ADDRESS,
      abi: ITEM_MARKET_ABI,
      functionName: 'getUnjuicedListingFee',
    }),
  ]);
  const blocked = !isPlayerJuiced && !unjuicedListingEnabled;
  return {
    isPlayerJuiced,
    unjuicedListingEnabled,
    unjuicedListingFeeWei,
    feeWei: isPlayerJuiced ? 0n : unjuicedListingFeeWei,
    blocked,
  };
};

export async function listOne(opts: ListOneInput): Promise<ListOneResult> {
  const { giga, agw, itemId, priceWei, log } = opts;
  const amount = opts.amount ?? 1;
  const protectedName = protectedMarketItemName(itemId);
  if (protectedName) {
    throw new Error(`${protectedName} защищен от продажи: ресурс нужен для крафта перчаток`);
  }

  const normalizedSellerAddress = opts.sellerAddress.toLowerCase();
  if (!isAddress(normalizedSellerAddress)) {
    throw new Error('Не удалось определить Abstract-адрес продавца');
  }
  const policy = await (opts.listingPolicyReader ?? readMarketplaceListingPolicy)(
    normalizedSellerAddress,
  );
  if (policy.blocked) {
    throw new Error('Gigamarket сейчас разрешает листинг только juiced-аккаунтам');
  }

  log.info(
    {
      itemId,
      amount,
      priceWei: priceWei.toString(),
      listingFeeWei: policy.feeWei.toString(),
      isPlayerJuiced: policy.isPlayerJuiced,
    },
    'requesting listing signature',
  );

  const { signature, nonce } = await giga.post<ListingCreateResponse>(
    '/api/marketplace/item/listing/create',
    {
      itemId: String(itemId),
      amount,
      costPerItem: priceWei.toString(),
    },
    { authed: true },
  );

  const data = encodeFunctionData({
    abi: ITEM_MARKET_ABI,
    functionName: 'createListing',
    args: [BigInt(itemId), BigInt(amount), BigInt(nonce), priceWei, signature],
  });

  log.info(
    { itemId, nonce, listingFeeWei: policy.feeWei.toString() },
    'submitting on-chain createListing',
  );

  const txHash = await agw.sendTransaction({
    to: ITEM_MARKET_ADDRESS,
    data,
    value: policy.feeWei,
  });

  log.info({ itemId, txHash, priceWei: priceWei.toString() }, 'listing submitted');
  return { txHash, nonce, listingFeeWei: policy.feeWei };
}
