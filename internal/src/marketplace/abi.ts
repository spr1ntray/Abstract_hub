export const ITEM_MARKET_ADDRESS = '0x37d6DBFa9f82aC4aCC86D49702aC0612D3aa1AfE' as const;

export const ITEM_MARKET_ABI = [
  {
    inputs: [
      { name: '_itemId', type: 'uint256' },
      { name: '_amount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: '_pricePerItem', type: 'uint256' },
      { name: '_signature', type: 'bytes' },
    ],
    name: 'createListing',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      { name: '_listingId', type: 'uint256' },
      { name: '_amount', type: 'uint256' },
    ],
    name: 'buyListing',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;
