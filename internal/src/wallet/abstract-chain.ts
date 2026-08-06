import { createPublicClient, http } from 'viem';
import { abstract } from 'viem/chains';
import type { Account, Proxy } from '../vault/schema.js';
import { makeProxyAgent } from './proxy-agent.js';

export function buildProxyUri(p: Proxy): string {
  const auth =
    p.username && p.password
      ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
      : '';
  return `${p.type}://${auth}${p.host}:${p.port}`;
}

export type AbstractPublicClient = ReturnType<typeof makeAbstractClient>;

export function makeAbstractClient(account: Account) {
  const dispatcher = makeProxyAgent(account.proxy);

  return createPublicClient({
    chain: abstract,
    transport: http(undefined, {
      // viem passes dispatcher through fetchOptions
      fetchOptions: { dispatcher } as unknown as RequestInit,
    }),
  });
}
