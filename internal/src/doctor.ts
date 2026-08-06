import { resolve } from 'node:path';
import { request } from 'undici';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAccountsFromText, FileLoadError } from './config/load-from-files.js';
import {
  hasEncrypted,
  hasPlaintext,
  encryptPlaintext,
  decryptToMemory,
} from './config/encrypted-files.js';
import { makeProxyAgent } from './wallet/proxy-agent.js';
import { resolveAccountSession } from './api/account-session.js';
import { GigaClient } from './api/client.js';
import { pino } from 'pino';
import { extractAccountSummaryFields, formatLoginSummary } from './orchestrator/preflight.js';
import type { Account } from './vault/schema.js';

// Silent logger for doctor — output is formatted manually via console.warn
const silentLog = pino({ level: 'silent' });

function arg(argv: string[], name: string, dflt: string): string {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  return dflt;
}

async function readPassword(message: string): Promise<string> {
  const { password } = await inquirer.prompt<{ password: string }>([
    { type: 'password', name: 'password', mask: '*', message },
  ]);
  return password;
}

async function readPasswordConfirm(): Promise<string> {
  const a = await readPassword('Set master password (>= 8 chars):');
  if (a.length < 8) {
    console.error('Password too short — needs at least 8 characters.');
    process.exit(1);
  }
  const b = await readPassword('Repeat:');
  if (a !== b) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  return a;
}

async function loadSecrets(cfg: { encPath: string; accountsPath: string; proxiesPath: string }) {
  // PLAINTEXT TAKES PRIORITY — same logic as play.ts / loadSecretsCore.
  // Must check plaintext BEFORE encrypted to avoid silently using stale secrets.enc.
  if (hasPlaintext(cfg)) {
    let password: string;
    if (hasEncrypted(cfg)) {
      password = await readPassword('Master password (must match existing secrets.enc):');
      try {
        await decryptToMemory(password, cfg);
      } catch {
        console.error('Wrong password — refusing to overwrite secrets.enc with plaintext.');
        process.exit(1);
      }
      console.warn('Re-encrypting accounts.txt + proxies.txt → secrets.enc');
    } else {
      console.warn('First-time setup: encrypting accounts.txt + proxies.txt → secrets.enc');
      password = await readPasswordConfirm();
    }
    await encryptPlaintext(password, cfg);
    return await decryptToMemory(password, cfg);
  }
  if (hasEncrypted(cfg)) {
    const password = await readPassword('Master password:');
    try {
      return await decryptToMemory(password, cfg);
    } catch {
      console.error('Wrong password (or secrets.enc is corrupted).');
      process.exit(1);
    }
  }
  console.error('No secrets found. Run `pnpm play` to set up first.');
  process.exit(1);
}

const TIMEOUT_MS = 10_000;

async function tryWith(proxy: Account['proxy']): Promise<string> {
  const dispatcher = makeProxyAgent(proxy);
  try {
    const res = await request('https://gigaverse.io/api/marketplace/item/floor/all', {
      method: 'GET',
      dispatcher,
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });
    await res.body.dump();
    if (res.statusCode === 200) return `${chalk.green('ok')} (HTTP 200)`;
    return `${chalk.yellow('warn')} (HTTP ${res.statusCode}) — proxy works but gigaverse returned non-200`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `${chalk.red('fail')} ${msg.split('\n')[0]}`;
  }
}

async function checkProxy(
  proxy: Account['proxy'],
): Promise<{ result: string; suggestion?: string }> {
  const primary = await tryWith(proxy);
  if (!primary.includes('fail')) {
    return { result: primary };
  }

  // Primary failed — try the OTHER scheme (https <-> http) to see if user picked the wrong one
  const flipped: Account['proxy'] = {
    ...proxy,
    type: proxy.type === 'https' ? 'http' : 'https',
  };
  const flipResult = await tryWith(flipped);
  if (!flipResult.includes('fail')) {
    return {
      result: primary,
      suggestion: `try changing scheme to "${flipped.type}://" in proxies.txt — that one works`,
    };
  }

  return { result: primary };
}

async function checkDirectRpc(): Promise<string> {
  try {
    const res = await request('https://api.mainnet.abs.xyz', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });
    const body = (await res.body.json()) as { result?: string };
    if (res.statusCode === 200 && body.result) {
      return `${chalk.green('ok')} (block ${parseInt(body.result, 16)})`;
    }
    return `${chalk.red('fail')} HTTP ${res.statusCode}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `${chalk.red('fail')} ${msg.split('\n')[0]}`;
  }
}

/**
 * Attempt login + game state checks for a single account.
 *
 * Returns a summary object describing each check result.
 * Never throws — all errors become human-readable strings in the result.
 */
async function checkGameState(account: Account): Promise<{
  loginResult: string;
  dungeonState: string;
  availableDungeons: string;
  readyReason: string | undefined;
}> {
  let jwt: string;
  let gameAccount;
  let expiresAt: number;
  try {
    const session = await resolveAccountSession({ account, log: silentLog });
    jwt = session.loginResult.jwt;
    gameAccount = session.loginResult.gameAccount;
    expiresAt = session.loginResult.expiresAt;
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return {
      loginResult: `${chalk.red('fail')} ${msg}`,
      dungeonState: '(skipped)',
      availableDungeons: '(skipped)',
      readyReason: `login failed: ${msg}`,
    };
  }

  // Format login summary
  const fields = extractAccountSummaryFields(gameAccount, expiresAt);
  const loginSummary = formatLoginSummary(fields);
  const loginLine = `${chalk.green('ok')}  (${loginSummary})`;

  // Detect if account cannot play
  const canEnter = fields.canEnterGame;
  const hasNoob = fields.noobId !== undefined;
  let blockReason: string | undefined;
  if (canEnter === false) blockReason = 'canEnterGame=false';
  else if (!hasNoob) blockReason = 'noob NFT not minted';

  // Set up client for game state queries
  const client = new GigaClient(account, silentLog);
  client.setJwt(jwt);

  // Dungeon state
  let dungeonStateLine: string;
  try {
    const state = await client.getDungeonState();
    const run = state.run ?? state.entity ?? null;
    if (run && typeof run === 'object') {
      const room = typeof run.ROOM_NUM_CID === 'number' ? run.ROOM_NUM_CID : '?';
      const complete = run.COMPLETE_CID === true ? 'complete' : 'active';
      dungeonStateLine = `${chalk.yellow('warn')} run is ${complete} at room ${room}`;
      if (!blockReason) blockReason = `active run in room ${room} — may need to flee`;
    } else {
      dungeonStateLine = 'idle';
    }
  } catch {
    dungeonStateLine = `${chalk.yellow('warn')} could not fetch dungeon state`;
  }

  // Available dungeons today
  let availableDungeonsLine: string;
  try {
    const today = await client.getDungeonToday();
    const dungeons = Array.isArray(today.dungeons) ? today.dungeons : [];
    if (dungeons.length === 0) {
      availableDungeonsLine = `${chalk.yellow('warn')} none returned`;
    } else {
      availableDungeonsLine = dungeons
        .map((d) => {
          const id = d.dungeonId ?? '?';
          const name = d.name ?? `id=${id}`;
          return `${id} (${name})`;
        })
        .join(', ');
    }
  } catch {
    availableDungeonsLine = `${chalk.yellow('warn')} could not fetch`;
  }

  return {
    loginResult: loginLine,
    dungeonState: dungeonStateLine,
    availableDungeons: availableDungeonsLine,
    readyReason: blockReason,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cfg = {
    encPath: resolve(arg(argv, '--secrets', 'secrets.enc')),
    accountsPath: resolve(arg(argv, '--accounts', 'accounts.txt')),
    proxiesPath: resolve(arg(argv, '--proxies', 'proxies.txt')),
  };

  // --no-login skips the login+game checks (proxy-only mode, like old doctor)
  const skipLogin = argv.includes('--no-login');

  const secrets = await loadSecrets(cfg);

  let loaded;
  try {
    loaded = parseAccountsFromText({
      accountsText: secrets.accounts,
      proxiesText: secrets.proxies,
      accountsSourceLabel: 'accounts (encrypted)',
      proxiesSourceLabel: 'proxies (encrypted)',
    });
  } catch (e) {
    if (e instanceof FileLoadError) {
      console.error('\n[!] Cannot parse:\n');
      for (const err of e.errors) {
        console.error(`    ${err.file}:${err.lineNumber} — ${err.message}`);
      }
      process.exit(1);
    }
    throw e;
  }

  console.warn(`\nChecking ${loaded.length} account(s)...\n`);

  // Direct RPC once — same for all accounts
  const rpcResult = await checkDirectRpc();
  console.warn(`direct → Abstract RPC  ${rpcResult}\n`);

  let anyFail = false;

  for (const [i, { account }] of loaded.entries()) {
    const auth = account.proxy.username ? '***@' : '';
    const proxyDisplay = `${account.proxy.type}://${auth}${account.proxy.host}:${account.proxy.port}`;
    console.warn(`[${i + 1}] ${chalk.bold(account.name)}  proxy: ${proxyDisplay}`);
    if (account.privateKey) {
      const eoa = privateKeyToAccount(account.privateKey as `0x${string}`);
      console.warn(`    EOA: ${eoa.address}`);
    } else if (account.agwAddress) {
      console.warn(`    Abstract AGW: ${account.agwAddress}`);
    }

    const { result: proxyResult, suggestion } = await checkProxy(account.proxy);
    const proxyFailed = proxyResult.includes('fail');
    console.warn(`    proxy:             ${proxyResult}`);
    if (suggestion) {
      console.warn(`    ${chalk.cyan('hint:')} ${suggestion}`);
    }

    if (proxyFailed) {
      anyFail = true;
      console.warn(`    ready to play: ${chalk.red('NO')} — proxy failed`);
      console.warn('');
      continue;
    }

    if (skipLogin) {
      // Proxy-only mode: stop here
      console.warn('');
      continue;
    }

    // Login + game state checks
    const game = await checkGameState(account);

    console.warn(`    login:             ${game.loginResult}`);
    console.warn(`    dungeon state:     ${game.dungeonState}`);
    console.warn(`    available dungeons: ${game.availableDungeons}`);

    if (game.readyReason) {
      anyFail = true;
      console.warn(`    ready to play: ${chalk.red('NO')} — ${game.readyReason}`);
    } else {
      console.warn(`    ready to play: ${chalk.green('YES')}`);
    }
    console.warn('');
  }

  if (anyFail) {
    if (skipLogin) {
      // Proxy-only failure path
      console.warn(chalk.red('\nOne or more proxies failed.'));
      console.warn('Common fixes:');
      console.warn('  - For HTTP proxies (the default): use `http://user:pass@host:port`');
      console.warn(
        '  - For an IP-based proxy: scheme `http://` not `https://` — most residential proxies are HTTP',
      );
      console.warn(
        '  - Test outside the bot: `curl -x http://user:pass@host:port https://gigaverse.io/api/marketplace/item/floor/all`',
      );
    } else {
      console.warn(chalk.red('\nOne or more accounts are not ready to play.'));
      console.warn('See the "ready to play: NO" lines above for specific issues.');
    }
    process.exit(1);
  }

  console.warn(chalk.green('All accounts ready. You can run `pnpm play` now.'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
