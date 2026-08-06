import type { Logger } from 'pino';
import type { Address } from 'viem';
import type { Account } from '../vault/schema.js';
import { makeSigner } from '../wallet/signer.js';
import { makeDelegatedAgwLoginSigner, type AgwCliRuntimeOptions } from '../wallet/agw-delegated.js';
import {
  decodeJwtToLoginResult,
  loginToGigaverse,
  type GigaverseLoginSigner,
  type LoginResult,
} from './auth.js';

export const JWT_REFRESH_WINDOW_MS = 24 * 60 * 60_000;

export interface AccountSession {
  agwAddress: Address;
  loginResult: LoginResult;
  mode: 'jwt' | 'delegated' | 'eoa';
  refreshed: boolean;
}

interface ResolveAccountSessionOptions {
  account: Account;
  log: Logger;
  agwCli?: AgwCliRuntimeOptions;
  now?: number;
  refreshWindowMs?: number;
  makeDelegatedSigner?: (
    account: Account,
    options: AgwCliRuntimeOptions,
  ) => Promise<GigaverseLoginSigner>;
  makeEoaSigner?: (account: Account) => Promise<GigaverseLoginSigner>;
  login?: typeof loginToGigaverse;
}

function expectedAgwAddress(account: Account): Address {
  if (!account.agwAddress || !/^0x[a-fA-F0-9]{40}$/.test(account.agwAddress)) {
    throw new Error(`У аккаунта ${account.name} не определён адрес Abstract`);
  }
  return account.agwAddress as Address;
}

function assertExpectedAddress(expected: Address, signer: GigaverseLoginSigner): void {
  if (signer.account.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Abstract-сессия подключена к ${signer.account.address}, ожидался аккаунт ${expected}`,
    );
  }
}

/**
 * Resolve one authenticated Gigaverse session for any account type.
 * Abstract accounts obtain a short-lived game session through their delegated
 * browser-approved signer. Legacy JWT accounts are refreshed before expiry.
 */
export async function resolveAccountSession(
  options: ResolveAccountSessionOptions,
): Promise<AccountSession> {
  const { account, log } = options;
  const login = options.login ?? loginToGigaverse;

  if (!account.jwt) {
    const isDelegated = !account.privateKey && Boolean(account.agwAddress);
    const signer = isDelegated
      ? await (options.makeDelegatedSigner ?? makeDelegatedAgwLoginSigner)(
          account,
          options.agwCli ?? {},
        )
      : await (options.makeEoaSigner ?? makeSigner)(account);
    if (isDelegated) assertExpectedAddress(expectedAgwAddress(account), signer);
    const loginResult = await login({ account, agw: signer, log });
    return {
      agwAddress: signer.account.address,
      loginResult,
      mode: isDelegated ? 'delegated' : 'eoa',
      refreshed: true,
    };
  }

  const agwAddress = expectedAgwAddress(account);
  const decoded = decodeJwtToLoginResult(account.jwt);
  const now = options.now ?? Date.now();
  const refreshWindowMs = options.refreshWindowMs ?? JWT_REFRESH_WINDOW_MS;
  if (decoded.expiresAt > now + refreshWindowMs) {
    return { agwAddress, loginResult: decoded, mode: 'jwt', refreshed: false };
  }

  try {
    const signer = account.privateKey
      ? await (options.makeEoaSigner ?? makeSigner)(account)
      : await (options.makeDelegatedSigner ?? makeDelegatedAgwLoginSigner)(
          account,
          options.agwCli ?? {},
        );
    assertExpectedAddress(agwAddress, signer);
    log.info(
      { account: account.name, expiresAt: decoded.expiresAt },
      'refreshing Gigaverse JWT through Abstract',
    );
    const loginResult = await login({ account, agw: signer, log });
    return {
      agwAddress,
      loginResult,
      mode: account.privateKey ? 'eoa' : 'delegated',
      refreshed: true,
    };
  } catch (error) {
    if (decoded.expiresAt > now) {
      log.warn(
        { account: account.name, expiresAt: decoded.expiresAt, err: error },
        'automatic JWT refresh failed; using the current token until expiry',
      );
      return { agwAddress, loginResult: decoded, mode: 'jwt', refreshed: false };
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `JWT аккаунта ${account.name} истёк, а Abstract не смог обновить его: ${detail}. ` +
        'Откройте вкладку аккаунтов и переподключите Abstract один раз.',
      { cause: error },
    );
  }
}
