import inquirer from 'inquirer';
import { existsSync } from 'node:fs';
import { createPublicClient, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abstract } from 'viem/chains';
import { VaultStore } from './store.js';
import { VAULT_PATH } from './paths.js';
import { addAccount, removeAccount, renameAccount, summarize } from './accounts.js';
import type { Account, Vault } from './schema.js';
import { resolveAgwAddress } from '../wallet/agw-factory.js';

const store = new VaultStore(VAULT_PATH);

async function readPassword(message = 'Master password:'): Promise<string> {
  const ans = await inquirer.prompt({
    password: { type: 'password', mask: '*', message },
  });
  return String(ans.password);
}

async function readPasswordConfirm(): Promise<string> {
  const a = await readPassword('New master password:');
  const b = await readPassword('Repeat:');
  if (a !== b) {
    console.error('Passwords mismatch');
    process.exit(1);
  }
  return a;
}

async function loadOrInit(password: string): Promise<Vault> {
  if (existsSync(VAULT_PATH)) return await store.load(password);
  return { version: 2, accounts: [] };
}

async function promptAccountInput(): Promise<Account> {
  const base = await inquirer.prompt({
    name: {
      type: 'input',
      message: 'Account name (alphanumeric, dash, underscore):',
    },
    privateKey: {
      type: 'password',
      mask: '*',
      message: 'EOA private key (0x + 64 hex chars — required):',
    },
    proxyType: {
      type: 'select',
      message: 'Proxy type:',
      choices: [
        { name: 'http', value: 'http' as const },
        { name: 'https', value: 'https' as const },
        { name: 'socks5', value: 'socks5' as const },
      ],
    },
    proxyHost: { type: 'input', message: 'Proxy host:' },
    proxyPort: { type: 'number', message: 'Proxy port:' },
    proxyUser: { type: 'input', message: 'Proxy user (empty if none):' },
    proxyPass: { type: 'password', mask: '*', message: 'Proxy password:' },
    capsolverKey: {
      type: 'password',
      mask: '*',
      message: 'CapSolver API key (optional, empty to skip):',
    },
    notes: { type: 'input', message: 'Notes (optional):' },
  });

  const proxyType = base.proxyType as 'http' | 'https' | 'socks5';
  const proxyPort = typeof base.proxyPort === 'number' ? base.proxyPort : Number(base.proxyPort);
  const proxyUser = String(base.proxyUser ?? '');
  const proxyPass = String(base.proxyPass ?? '');
  const privateKey = String(base.privateKey ?? '').trim();
  const notes = String(base.notes ?? '').trim();
  const capsolverKey = String(base.capsolverKey ?? '').trim();

  if (!privateKey) {
    console.error('Private key is required');
    process.exit(1);
  }

  const account: Account = {
    name: String(base.name),
    privateKey: privateKey as `0x${string}`,
    proxy: {
      type: proxyType,
      host: String(base.proxyHost),
      port: proxyPort,
      ...(proxyUser ? { username: proxyUser } : {}),
      ...(proxyPass ? { password: proxyPass } : {}),
    },
    ...(capsolverKey
      ? { capsolver: { apiKey: capsolverKey, preferredTask: 'AntiTurnstileTaskProxyLess' } }
      : {}),
    ...(notes ? { notes } : {}),
  };

  // Resolve EOA → AGW address and cache it so the bot doesn't need live RPC
  // calls on every startup.
  try {
    const eoa = privateKeyToAccount(privateKey as `0x${string}`);
    const client = createPublicClient({
      chain: abstract,
      transport: http(),
    }) as unknown as PublicClient;
    const agwAddress = await resolveAgwAddress(client, eoa.address);
    account.agwAddress = agwAddress;
    console.warn(
      `  EOA address: ${eoa.address} · AGW address: ${agwAddress} · (fund this AGW with energy)`,
    );
  } catch (e) {
    console.warn('  could not resolve AGW (network?):', e instanceof Error ? e.message : e);
  }

  return account;
}

async function cmdAddAccount(): Promise<void> {
  const exists = existsSync(VAULT_PATH);
  const password = exists ? await readPassword() : await readPasswordConfirm();
  const vault = await loadOrInit(password);
  const account = await promptAccountInput();
  const updated = addAccount(vault, account);
  await store.save(updated, password);
  console.warn(`Saved account "${account.name}" to ${VAULT_PATH}`);
}

async function cmdListAccounts(): Promise<void> {
  const password = await readPassword();
  const vault = await store.load(password);
  if (vault.accounts.length === 0) {
    console.warn('(no accounts)');
    return;
  }
  for (const acc of vault.accounts) {
    console.warn(`  ${acc.name}  ·  ${summarize(acc)}`);
  }
}

async function cmdRemoveAccount(name: string): Promise<void> {
  const password = await readPassword();
  const vault = await store.load(password);
  const ans = await inquirer.prompt({
    ok: {
      type: 'confirm',
      default: false,
      message: `Really delete account "${name}"?`,
    },
  });
  if (!ans.ok) {
    console.warn('Cancelled');
    return;
  }
  const updated = removeAccount(vault, name);
  await store.save(updated, password);
  console.warn(`Removed account "${name}"`);
}

async function cmdRename(oldName: string, newName: string): Promise<void> {
  const password = await readPassword();
  const vault = await store.load(password);
  const updated = renameAccount(vault, oldName, newName);
  await store.save(updated, password);
  console.warn(`Renamed "${oldName}" → "${newName}"`);
}

async function cmdShow(): Promise<void> {
  // alias for list-accounts
  await cmdListAccounts();
}

async function cmdInit(): Promise<void> {
  if (existsSync(VAULT_PATH)) {
    const ans = await inquirer.prompt({
      ok: {
        type: 'confirm',
        default: false,
        message: `Vault exists at ${VAULT_PATH}. Add a new account?`,
      },
    });
    if (!ans.ok) return;
  }
  await cmdAddAccount();
}

function requireArg(args: string[], i: number, what: string): string {
  const v = args[i];
  if (!v) {
    console.error(`Missing argument: ${what}`);
    process.exit(1);
  }
  return v;
}

const [cmd, ...rest] = process.argv.slice(2);

const runners: Record<string, () => Promise<void>> = {
  init: cmdInit,
  'add-account': cmdAddAccount,
  'list-accounts': cmdListAccounts,
  'remove-account': () => cmdRemoveAccount(requireArg(rest, 0, 'account name')),
  rename: () => cmdRename(requireArg(rest, 0, 'old name'), requireArg(rest, 1, 'new name')),
  show: cmdShow,
};

const runner = cmd ? runners[cmd] : undefined;
if (!runner) {
  console.error(
    'Usage: pnpm vault <init|add-account|list-accounts|remove-account <name>|rename <old> <new>|show>',
  );
  process.exit(1);
}
await runner();
