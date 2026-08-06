import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import { createPublicClient, http, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { abstract } from 'viem/chains';
import { resolveAgwAddress } from './agw-factory.js';

const RPC_URL = 'https://api.mainnet.abs.xyz';
const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

export function validateKey(s: string): s is `0x${string}` {
  return PRIVATE_KEY_REGEX.test(s);
}

function makeReadOnlyClient(): PublicClient {
  return createPublicClient({
    chain: abstract,
    transport: http(RPC_URL),
  }) as unknown as PublicClient;
}

async function generate(): Promise<void> {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const client = makeReadOnlyClient();
  const agw = await resolveAgwAddress(client, account.address);

  console.warn(chalk.red.bold('SECRET — store this somewhere safe and DO NOT share:'));
  console.warn(chalk.red(`  PRIVATE KEY : ${pk}`));
  console.warn('');
  console.warn(chalk.cyan('EOA address  :'), account.address);
  console.warn(chalk.green('AGW address  :'), agw);
  console.warn('');
  console.warn(
    chalk.yellow('Note: the AGW does NOT exist on-chain yet. It will be deployed automatically'),
  );
  console.warn(chalk.yellow('on the first transaction sent from this account.'));
}

async function info(rawKey: string | undefined): Promise<void> {
  if (!rawKey) {
    console.error(chalk.red('Error: missing private key argument'));
    console.error('Usage: pnpm wallet info <0x...64hex>');
    process.exit(1);
  }
  if (!validateKey(rawKey)) {
    console.error(
      chalk.red('Error: invalid private key. Expected 0x-prefixed 64-character hex string.'),
    );
    process.exit(1);
  }

  const account = privateKeyToAccount(rawKey);
  const client = makeReadOnlyClient();
  const agw = await resolveAgwAddress(client, account.address);

  console.warn(chalk.cyan('EOA address  :'), account.address);
  console.warn(chalk.green('AGW address  :'), agw);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'generate') {
    await generate();
  } else if (cmd === 'info') {
    await info(process.argv[3]);
  } else {
    console.error('Usage: pnpm wallet <generate|info <0x...64hex>>');
    process.exit(1);
  }
}

// Only run when executed as an entrypoint (not when imported by tests).
const invokedPath = process.argv[1];
const isEntrypoint =
  invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
if (isEntrypoint) {
  await main();
}
