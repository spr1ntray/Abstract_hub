import { createAbstractClient } from '@abstract-foundation/agw-client';
import { privateKeyToAccount } from 'viem/accounts';
import { abstract } from 'viem/chains';
import { http } from 'viem';
import type { Account } from '../vault/schema.js';

export type AgwSigner = Awaited<ReturnType<typeof createAbstractClient>>;

/**
 * Build an AGW signer for the given account.
 *
 * Note on proxying: Abstract mainnet RPC (`api.mainnet.abs.xyz`) is public and
 * does NOT need to flow through the account proxy. Proxying it would only
 * help if the user's residential IP is blocked from RPC, which never happens.
 * The proxy is reserved for gigaverse.io traffic (anti-bot / per-account IP
 * isolation), wired in `src/api/client.ts`.
 */
export async function makeSigner(account: Account): Promise<AgwSigner> {
  if (!account.privateKey) {
    throw new Error(
      `account "${account.name}" has no privateKey — required for marketplace listing`,
    );
  }
  const eoa = privateKeyToAccount(account.privateKey as `0x${string}`);

  try {
    return await createAbstractClient({
      signer: eoa,
      chain: abstract,
      transport: http(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `failed to create AGW signer for "${account.name}": ${msg}. ` +
        `Check that your machine can reach https://api.mainnet.abs.xyz (try \`curl -s https://api.mainnet.abs.xyz -X POST -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'\`).`,
      { cause: e },
    );
  }
}

export async function signLoginMessage(
  signer: AgwSigner,
  timestamp: number,
): Promise<{
  message: string;
  signature: `0x${string}`;
  address: `0x${string}`;
}> {
  const message = `Login to Gigaverse at ${timestamp}`;
  const signature = await signer.signMessage({ message });
  return { message, signature, address: signer.account.address };
}
