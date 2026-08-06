import type { Account } from '../vault/schema.js';
import type { MarketplaceTransactionSender } from '../marketplace/lister.js';
import {
  makeDelegatedAgwSigner,
  type AgwCliRuntimeOptions,
  type AgwCliRunner,
  runAgwCli,
} from './agw-delegated.js';
import { makeSigner, type AgwSigner } from './signer.js';

export type MarketplaceSignerResolution =
  | { agwAddress: string; mode: 'eoa'; signer: AgwSigner }
  | { agwAddress: string; mode: 'delegated'; signer: MarketplaceTransactionSender };

export async function resolveMarketplaceSigner(
  account: Account,
  options: AgwCliRuntimeOptions = {},
  runner: AgwCliRunner = runAgwCli,
): Promise<MarketplaceSignerResolution> {
  if (account.privateKey) {
    const signer = await makeSigner(account);
    const agwAddress = signer.account.address;
    if (account.agwAddress && account.agwAddress.toLowerCase() !== agwAddress.toLowerCase()) {
      throw new Error(
        `Подписант ${agwAddress} не соответствует AGW-адресу аккаунта ${account.agwAddress}`,
      );
    }
    return { agwAddress, mode: 'eoa', signer };
  }

  if (!account.agwAddress) {
    throw new Error(`Для аккаунта ${account.name} не настроен способ подписи Gigamarket`);
  }
  const signer = await makeDelegatedAgwSigner(account, options, runner);
  return { agwAddress: account.agwAddress, mode: 'delegated', signer };
}
