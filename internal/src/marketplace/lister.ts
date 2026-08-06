import type { Logger } from 'pino';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import type { GigaClient } from '../api/client.js';
import { ITEM_MARKET_ABI, ITEM_MARKET_ADDRESS } from './abi.js';
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
  log: Logger;
}

export interface ListOneResult {
  txHash: `0x${string}`;
  nonce: number;
}

interface ListingCreateResponse {
  signature: `0x${string}`;
  nonce: number;
}

export async function listOne(opts: ListOneInput): Promise<ListOneResult> {
  const { giga, agw, itemId, priceWei, log } = opts;
  const amount = opts.amount ?? 1;
  const protectedName = protectedMarketItemName(itemId);
  if (protectedName) {
    throw new Error(`${protectedName} защищен от продажи: ресурс нужен для крафта перчаток`);
  }

  log.info({ itemId, amount, priceWei: priceWei.toString() }, 'requesting listing signature');

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

  log.info({ itemId, nonce }, 'submitting on-chain createListing');

  const txHash = await agw.sendTransaction({
    to: ITEM_MARKET_ADDRESS,
    data,
    value: 0n,
  });

  log.info({ itemId, txHash, priceWei: priceWei.toString() }, 'listing submitted');
  return { txHash, nonce };
}
