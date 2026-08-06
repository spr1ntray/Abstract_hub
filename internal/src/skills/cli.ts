/**
 * `pnpm skills` — spend accumulated skill points on the user's chosen build.
 *
 * Usage:
 *   pnpm skills                  → upgrade every account, no cap
 *   pnpm skills --max 10          → at most 10 upgrades per account
 *   pnpm skills --dry-run         → show plan without POSTing levelup
 */

import { resolve } from 'node:path';
import inquirer from 'inquirer';
import { parseAccountsFromText, FileLoadError } from '../config/load-from-files.js';
import {
  decryptToMemory,
  hasEncrypted,
  hasPlaintext,
  encryptPlaintext,
  type PathsConfig,
} from '../config/encrypted-files.js';
import { GigaClient } from '../api/client.js';
import { resolveAccountSession } from '../api/account-session.js';
import { createLogger } from '../logger.js';
import { runSkillUpgradeLoop } from './upgrade-loop.js';
import { parseSkillCatalog, parseSkillProgress, currentStatLevel } from './parse.js';
import { pickNextUpgrade, STAT_NAMES_RU } from './strategy.js';
import type { Account } from '../vault/schema.js';
import { extractNoobTokenId } from '../api/noob-id.js';

async function readPassword(message: string): Promise<string> {
  if (process.env.GIGABOT_STDIN_PASSWORD === '1') {
    return new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (chunk: string) => {
        buf += chunk;
        resolve(buf.replace(/\r?\n$/, ''));
      });
      process.stdin.once('error', reject);
      process.stdin.resume();
    });
  }
  const { password } = await inquirer.prompt<{ password: string }>([
    { type: 'password', name: 'password', mask: '*', message },
  ]);
  return password;
}

async function authenticateAccount(
  account: Account,
  log: ReturnType<typeof createLogger>,
): Promise<{ client: GigaClient; noobId: number }> {
  const client = new GigaClient(account, log);
  const session = await resolveAccountSession({ account, log });
  client.setJwt(session.loginResult.jwt);
  return { client, noobId: extractNoobTokenId(session.loginResult.gameAccount) ?? 0 };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const maxIdx = argv.indexOf('--max');
  const maxUpgrades = maxIdx >= 0 && argv[maxIdx + 1] ? Number(argv[maxIdx + 1]) : undefined;
  const dryRun = argv.includes('--dry-run');

  const cfg: PathsConfig = {
    encPath: resolve('secrets.enc'),
    accountsPath: resolve('accounts.txt'),
    proxiesPath: resolve('proxies.txt'),
  };

  if (!hasEncrypted(cfg) && !hasPlaintext(cfg)) {
    console.error('Нет secrets.enc — сначала запусти `pnpm play` или `pnpm ui`.');
    process.exit(1);
  }

  const password = await readPassword('Мастер-пароль:');
  if (hasPlaintext(cfg)) {
    // Re-encrypt edits before reading
    try {
      await encryptPlaintext(password, cfg);
    } catch (e) {
      console.error('Не удалось перешифровать:', e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  let secrets;
  try {
    secrets = await decryptToMemory(password, cfg);
  } catch {
    console.error('Неверный пароль.');
    process.exit(1);
  }

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
      console.error('Ошибка разбора аккаунтов:');
      for (const err of e.errors) {
        console.error(`  ${err.file}:${err.lineNumber} — ${err.message}`);
      }
      process.exit(1);
    }
    throw e;
  }

  const log = createLogger();

  for (const { account } of loaded) {
    console.log(`\n── ${account.name} ──`);
    try {
      const { client, noobId } = await authenticateAccount(account, log);
      if (!noobId) {
        console.error('  noob не сминтен — пропускаю');
        continue;
      }

      if (dryRun) {
        const catalog = parseSkillCatalog(await client.getSkillsCatalog());
        const progress = parseSkillProgress(await client.getSkillsProgress(noobId));
        const candidate = pickNextUpgrade(catalog, progress);
        if (!candidate) {
          console.log('  (нечего качать — всё на максимум или не в стратегии)');
          continue;
        }
        const entry = catalog.get(candidate.skillId);
        const stat = entry?.stats.find((s) => s.id === candidate.statId);
        const cur = stat ? currentStatLevel(progress.get(candidate.skillId)!, candidate.statId) : 0;
        console.log(
          `  СЛЕД. АПГРЕЙД: skill=${entry?.name ?? candidate.skillId}, ` +
            `stat=${STAT_NAMES_RU[candidate.statId]}, lvl ${cur}→${cur + 1}, цена ${candidate.cost} SP`,
        );
        continue;
      }

      const result = await runSkillUpgradeLoop(
        client,
        noobId,
        log,
        maxUpgrades !== undefined ? { maxUpgrades } : {},
      );

      console.log(`  Прокачано: ${result.upgraded.length}`);
      console.log(`  Остановка: ${result.stopReason}`);
      for (const u of result.upgraded) {
        console.log(
          `    ✓ skill=${u.skillId}, ${STAT_NAMES_RU[u.statId]}, lvl ${u.fromLevel}→${u.fromLevel + 1}, цена ${u.cost} SP`,
        );
      }
    } catch (e) {
      console.error(`  Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
