import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import inquirer from 'inquirer';
import { createLogger } from './logger.js';
import { parseAccountsFromText, FileLoadError } from './config/load-from-files.js';
import {
  hasEncrypted,
  hasPlaintext,
  encryptPlaintext,
  decryptToMemory,
  type PathsConfig,
  type SecretsBundle,
} from './config/encrypted-files.js';
import { runForAccount, type MainArgs } from './orchestrator/main.js';
import { present, withAccountPresenter } from './orchestrator/presenter.js';
import { hydrateAccountGameSession } from './api/browser-session.js';

function arg(argv: string[], name: string, dflt: string): string {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  return dflt;
}

/**
 * Read a single password from stdin (non-interactively).
 * Used when GIGABOT_STDIN_PASSWORD=1 is set, so the UI server can pass the
 * master password into the child process without a terminal prompt.
 * The server writes "<password>\n" to the child's stdin immediately after spawn.
 */
async function readPasswordFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk: string) => {
      buf += chunk;
      // Strip trailing newline(s) written by the server
      resolve(buf.replace(/\r?\n$/, ''));
    });
    process.stdin.once('error', reject);
    // Resume in case stdin was paused
    process.stdin.resume();
  });
}

async function readPassword(message: string): Promise<string> {
  // UI mode: read from stdin instead of prompting the terminal
  if (process.env['GIGABOT_STDIN_PASSWORD'] === '1') {
    return readPasswordFromStdin();
  }
  const { password } = await inquirer.prompt<{ password: string }>([
    { type: 'password', name: 'password', mask: '*', message },
  ]);
  return password;
}

/** Callback type for prompting a password. Returns the entered string. */
export type PromptFn = (message: string) => Promise<string>;

/**
 * Testable core of the secrets-loading state machine.
 *
 * @param cfg       Paths to enc/plaintext files (defaults to project root).
 * @param prompt    Password-prompt callback (injected so tests can avoid inquirer).
 * @param confirm   Optional second-prompt for confirmation (only used in first-time setup).
 *                  Defaults to calling `prompt` a second time.
 * @returns         Decrypted SecretsBundle, or throws / calls exitFn on error.
 * @param exitFn    Called instead of process.exit() — defaults to process.exit.
 *                  Tests inject a function that throws so they can assert on it.
 */
export async function loadSecretsCore(
  cfg: PathsConfig,
  prompt: PromptFn,
  exitFn: (code: number) => never = (c) => process.exit(c),
): Promise<SecretsBundle> {
  const plainExists = hasPlaintext(cfg);
  const encExists = hasEncrypted(cfg);

  // PLAINTEXT TAKES PRIORITY: if the user just edited accounts.txt / proxies.txt,
  // their edits are the source of truth — re-encrypt (overwriting any old
  // secrets.enc) and delete the plaintext after. Same password as before when
  // secrets.enc already existed; new password (with confirm) when fresh.
  if (plainExists) {
    let password: string;
    if (encExists) {
      // Validate password against existing secrets.enc, then re-encrypt with same password
      password = await prompt('Master password (must match existing secrets.enc):');
      try {
        await decryptToMemory(password, cfg);
      } catch {
        console.error('Wrong password — refusing to overwrite secrets.enc with plaintext.');
        console.error(
          'Either re-enter the correct password, or delete secrets.enc to start fresh.',
        );
        exitFn(1);
      }
      console.warn('Re-encrypting accounts.txt + proxies.txt → secrets.enc');
    } else {
      console.warn('First-time setup: encrypting accounts.txt + proxies.txt → secrets.enc');
      // First-time: prompt twice (password + confirm)
      password = await prompt('Set master password (>= 8 chars):');
      if (password.length < 8) {
        console.error('Password too short — needs at least 8 characters.');
        exitFn(1);
      }
      const confirm = await prompt('Repeat:');
      if (password !== confirm) {
        console.error('Passwords do not match.');
        exitFn(1);
      }
    }
    const encPath = await encryptPlaintext(password, cfg);
    console.warn(`Encrypted to ${encPath}. Plaintext files removed.`);
    return await decryptToMemory(password, cfg);
  }

  // No plaintext — only encrypted exists. Standard run.
  if (encExists) {
    const password = await prompt('Master password:');
    try {
      return await decryptToMemory(password, cfg);
    } catch {
      console.error('Wrong password (or secrets.enc is corrupted).');
      exitFn(1);
    }
  }

  // Nothing — bail with instructions
  console.error('No secrets found.\n');
  console.error('First run:');
  console.error('  cp internal/accounts.example.txt accounts.txt');
  console.error('  cp internal/proxies.example.txt proxies.txt');
  console.error('  # edit them with your data, then:');
  console.error('  pnpm play\n');
  exitFn(1);
}

async function loadSecrets(cfg: { encPath?: string; accountsPath?: string; proxiesPath?: string }) {
  return await loadSecretsCore(cfg, readPassword);
}

async function play(): Promise<void> {
  const argv = process.argv.slice(2);
  const dungeonName = arg(argv, '--dungeon', '5000');
  const dungeon: 1 | 3 = dungeonName === 'underhaul' ? 3 : 1;
  const dryRun = argv.includes('--dry-run');
  const list = argv.includes('--list');

  // Execution mode: parallel (default) runs all accounts concurrently;
  // sequential runs them one at a time. CLI `--mode <p|s>` and env `GIGABOT_MODE`
  // both work. GIGABOT_SEQUENTIAL=true is kept as a back-compat alias.
  const cliMode = arg(argv, '--mode', '').toLowerCase();
  const envMode = (process.env.GIGABOT_MODE ?? '').toLowerCase();
  const legacy = process.env.GIGABOT_SEQUENTIAL === 'true';
  const modeRaw = cliMode || envMode || (legacy ? 'sequential' : 'parallel');
  const sequential = /^(s|seq|sequential)$/.test(modeRaw);

  const cfg = {
    encPath: resolve(arg(argv, '--secrets', 'secrets.enc')),
    accountsPath: resolve(arg(argv, '--accounts', 'accounts.txt')),
    proxiesPath: resolve(arg(argv, '--proxies', 'proxies.txt')),
  };

  const log = createLogger();

  const secrets = await loadSecrets(cfg);

  let loaded;
  try {
    loaded = parseAccountsFromText({
      accountsText: secrets.accounts,
      proxiesText: secrets.proxies,
      accountsSourceLabel: 'accounts (encrypted)',
      proxiesSourceLabel: 'proxies (encrypted)',
    });
    loaded = loaded.map((entry) => ({
      ...entry,
      account: hydrateAccountGameSession(entry.account, secrets.gameSessions),
    }));
  } catch (e) {
    if (e instanceof FileLoadError) {
      console.error('\n[!] Could not start:\n');
      for (const err of e.errors) {
        console.error(`    ${err.file}:${err.lineNumber} — ${err.message}`);
      }
      console.error('\nRun `pnpm unlock` to decrypt + fix the contents, then `pnpm play` again.\n');
      process.exit(1);
    }
    throw e;
  }

  // Summarize per-account dungeon distribution so the operator sees what's
  // about to run before any HTTP fires.
  const dungeonStats = loaded.reduce(
    (acc, { account }) => {
      const d = account.dungeon ?? dungeon;
      if (d === 1) acc.d5000++;
      else acc.underhaul++;
      return acc;
    },
    { d5000: 0, underhaul: 0 },
  );

  log.info(
    {
      accounts: loaded.length,
      defaultDungeon: dungeon,
      mode: sequential ? 'sequential' : 'parallel',
      perDungeon: dungeonStats,
      list,
      dryRun,
    },
    'starting',
  );

  // Show the human-readable banner — pino handles structured logging in parallel.
  present.banner(loaded.length, dungeon);

  const args: MainArgs = { all: true, dungeon, dryRun, list };

  // withAccountPresenter wraps everything an account does in an AsyncLocalStorage
  // context — presenter.X() calls inside automatically prefix output with [name]
  // in a colour unique to the account. This is what makes parallel logs readable.
  const runOne = async ({ account, lineNumber }: (typeof loaded)[number]): Promise<void> => {
    await withAccountPresenter(account.name, async () => {
      const childLog = log.child({ account: account.name });
      childLog.info(
        { line: lineNumber, dungeon: account.dungeon ?? dungeon },
        '=== begin account ===',
      );
      try {
        await runForAccount(account, args, childLog);
      } catch (e) {
        childLog.error({ err: e }, 'account run failed');
        // Surface the error in the visible (presenter) log too — otherwise it
        // sits in the JSON file where the operator never sees the reason.
        present.accountFailed(e);
      }
      childLog.info('=== end account ===');
    });
  };

  if (sequential) {
    for (const entry of loaded) await runOne(entry);
  } else {
    // Parallel execution: stagger account start by 0-15s to desync HTTP
    // request bursts (anti-sybil: simultaneous wall-clock starts across
    // accounts is a strong bot tell).
    await Promise.allSettled(
      loaded.map(async (entry) => {
        const jitter = Math.floor(Math.random() * 15_000);
        if (jitter > 0) await new Promise<void>((r) => setTimeout(r, jitter));
        await runOne(entry);
      }),
    );
  }

  log.info('all accounts done');
  present.allDone();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  play().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
