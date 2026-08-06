import type { Vault, Account } from './schema.js';

export function findAccount(vault: Vault, name: string): Account | undefined {
  return vault.accounts.find((a) => a.name === name);
}

export function requireAccount(vault: Vault, name: string): Account {
  const a = findAccount(vault, name);
  if (!a) {
    const list = vault.accounts.map((x) => x.name).join(', ') || '(none)';
    throw new Error(`account not found: ${name}. Available: ${list}`);
  }
  return a;
}

export function addAccount(vault: Vault, account: Account): Vault {
  if (findAccount(vault, account.name)) {
    throw new Error(`account already exists: ${account.name}`);
  }
  return { ...vault, accounts: [...vault.accounts, account] };
}

export function removeAccount(vault: Vault, name: string): Vault {
  if (!findAccount(vault, name)) throw new Error(`account not found: ${name}`);
  return { ...vault, accounts: vault.accounts.filter((a) => a.name !== name) };
}

export function updateAccount(vault: Vault, name: string, patch: Partial<Account>): Vault {
  if (!findAccount(vault, name)) throw new Error(`account not found: ${name}`);
  return {
    ...vault,
    accounts: vault.accounts.map((a) => (a.name === name ? { ...a, ...patch } : a)),
  };
}

export function renameAccount(vault: Vault, oldName: string, newName: string): Vault {
  if (!findAccount(vault, oldName)) throw new Error(`account not found: ${oldName}`);
  if (findAccount(vault, newName)) throw new Error(`new name already in use: ${newName}`);
  return {
    ...vault,
    accounts: vault.accounts.map((a) => (a.name === oldName ? { ...a, name: newName } : a)),
  };
}

/**
 * Human-readable, secrets-redacted summary of an account. Safe to print to a
 * terminal or stuff into a non-debug log.
 */
export function summarize(account: Account): string {
  const parts: string[] = [];
  parts.push(`proxy=${account.proxy.type}://${account.proxy.host}:${account.proxy.port}`);
  if (account.privateKey) {
    parts.push(`key=0x${account.privateKey.slice(2, 8)}...`);
  } else if (account.jwt) {
    parts.push(`jwt=eyJ...${account.jwt.slice(-8)} (pre-baked)`);
  }
  parts.push(`AGW=${account.agwAddress ?? '(not resolved)'}`);
  parts.push(`capsolver=${account.capsolver ? 'configured' : '(not set)'}`);
  if (account.notes) parts.push(`notes="${account.notes}"`);
  return parts.join(' · ');
}
