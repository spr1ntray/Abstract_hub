import { keccak256, toBytes, type PublicClient } from 'viem';

export const AGW_FACTORY_ADDRESS = '0x9B947df68D35281C972511B3E7BC875926f26C1A' as const;

export const AGW_FACTORY_ABI = [
  {
    inputs: [{ name: 'salt', type: 'bytes32' }],
    name: 'getAddressForSalt',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export function deriveSalt(initialSigner: `0x${string}`): `0x${string}` {
  return keccak256(toBytes(initialSigner));
}

export async function resolveAgwAddress(
  client: PublicClient,
  initialSigner: `0x${string}`,
): Promise<`0x${string}`> {
  const salt = deriveSalt(initialSigner);
  return await client.readContract({
    address: AGW_FACTORY_ADDRESS,
    abi: AGW_FACTORY_ABI,
    functionName: 'getAddressForSalt',
    args: [salt],
  });
}
