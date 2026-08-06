/**
 * pnpm sell-all — list every unequipped gear instance at floor − 1%.
 *
 * For each account (parallel, best-effort):
 *   1. Authenticate (JWT or private-key path)
 *   2. Fetch all gear instances via GET /api/gear/instances/<agw>
 *   3. Fetch floor prices via GET /api/marketplace/item/floor/all
 *   4. For each unequipped piece with a floor price:
 *      - Skip if already listed (StateDB.alreadyListed)
 *      - Call listOne() at floor − 1% (100 bps discount)
 *   5. Print per-account summary: listed / skipped / failed
 *
 * Usage:
 *   pnpm sell-all
 *   pnpm sell-all --dry-run   (print what would be listed without transacting)
 */

import { resolve } from 'node:path';
import inquirer from 'inquirer';
import { parseAccountsFromText, FileLoadError } from './config/load-from-files.js';
import { decryptToMemory, hasEncrypted, type PathsConfig } from './config/encrypted-files.js';
import { GigaClient } from './api/client.js';
import { resolveAccountSession } from './api/account-session.js';
import { resolveMarketplaceSigner } from './wallet/marketplace-signer.js';
import { createLogger } from './logger.js';
import { StateDB } from './state/db.js';
import { STATE_DB_PATH } from './vault/paths.js';
import { listOne } from './marketplace/lister.js';
import { computeListPrice, shouldSkip } from './marketplace/pricing.js';
import type { Account } from './vault/schema.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RawGearInstance {
  _id?: string;
  docId?: string;
  GAME_ITEM_ID_CID?: number;
  RARITY_CID?: number;
  EQUIPPED_TO_SLOT_CID?: number;
  [key: string]: unknown;
}

interface SellAllResult {
  accountName: string;
  agwAddress: string;
  considered: number;
  listed: number;
  skipped: number;
  failed: number;
  errors: string[];
}

// ── Gear list extraction (mirrors server.ts logic) ────────────────────────────

function extractGearList(raw: unknown): RawGearInstance[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  for (const key of ['entities', 'items', 'data', 'gear']) {
    if (Array.isArray(obj[key])) return obj[key] as RawGearInstance[];
  }
  if (Array.isArray(raw)) return raw as RawGearInstance[];
  return [];
}

// ── Per-account sell logic ────────────────────────────────────────────────────

async function sellAllForAccount(opts: {
  account: Account;
  dryRun: boolean;
  db: StateDB;
  log: ReturnType<typeof createLogger>;
}): Promise<SellAllResult> {
  const { account, dryRun, db, log } = opts;

  const result: SellAllResult = {
    accountName: account.name,
    agwAddress: '',
    considered: 0,
    listed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const client = new GigaClient(account, log);
  let signerResolution: Awaited<ReturnType<typeof resolveMarketplaceSigner>>;

  try {
    signerResolution = await resolveMarketplaceSigner(account);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  const agw = signerResolution.signer;
  const session = await resolveAccountSession({
    account,
    log,
    ...(signerResolution.mode === 'eoa'
      ? { makeEoaSigner: async () => signerResolution.signer }
      : {}),
  });
  const agwAddress = session.agwAddress;
  client.setJwt(session.loginResult.jwt);

  result.agwAddress = agwAddress;

  // Fetch full gear inventory and floor prices in parallel
  const [gearRaw, floors] = await Promise.all([
    client.get<unknown>(`/api/gear/instances/${agwAddress}`, { authed: true }),
    client.getFloors(),
  ]);

  const gearList = extractGearList(gearRaw);
  result.considered = gearList.length;

  // Collect docIds for the already-listed check
  const docIds = gearList
    .map((g) => g.docId ?? g['_id'])
    .filter((id): id is string => typeof id === 'string');

  const alreadyListedSet = db.alreadyListed(docIds);

  for (const gear of gearList) {
    const docId = gear.docId ?? gear['_id'];
    if (typeof docId !== 'string') {
      result.skipped++;
      continue;
    }

    if (alreadyListedSet.has(docId)) {
      log.debug({ docId }, 'sell-all: already listed');
      result.skipped++;
      continue;
    }

    const itemId = gear.GAME_ITEM_ID_CID;
    if (typeof itemId !== 'number') {
      result.skipped++;
      continue;
    }

    const rarity = typeof gear.RARITY_CID === 'number' ? gear.RARITY_CID : 0;
    const equipped = typeof gear.EQUIPPED_TO_SLOT_CID === 'number' && gear.EQUIPPED_TO_SLOT_CID > 0;

    const listable = { rarity, equipped, itemId };
    const floor = floors.get(itemId);
    const skipReason = shouldSkip(listable, floor);

    if (skipReason) {
      log.debug({ docId, itemId, reason: skipReason }, 'sell-all: skip');
      db.upsertListing({
        gear_instance_id: docId,
        item_id: itemId,
        status: 'skipped',
        reason: skipReason,
      });
      result.skipped++;
      continue;
    }

    const priceWei = computeListPrice(floor!);

    if (dryRun) {
      console.log(`  [dry-run] would list item#${itemId} (rarity ${rarity}) at ${priceWei} wei`);
      result.listed++;
      continue;
    }

    db.upsertListing({
      gear_instance_id: docId,
      item_id: itemId,
      status: 'pending',
      price_wei: priceWei.toString(),
    });

    try {
      const { txHash } = await listOne({ giga: client, agw, itemId, priceWei, log });
      db.upsertListing({
        gear_instance_id: docId,
        item_id: itemId,
        status: 'submitted',
        tx_hash: txHash,
        price_wei: priceWei.toString(),
      });
      result.listed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ docId, itemId, err: e }, 'sell-all: list failed');
      db.upsertListing({
        gear_instance_id: docId,
        item_id: itemId,
        status: 'failed',
        reason: msg,
        price_wei: priceWei.toString(),
      });
      result.failed++;
      result.errors.push(`item#${itemId}: ${msg}`);
    }
  }

  return result;
}

// ── Password prompt ───────────────────────────────────────────────────────────

async function readPassword(): Promise<string> {
  const { password } = await inquirer.prompt<{ password: string }>([
    { type: 'password', name: 'password', mask: '*', message: 'Мастер-пароль:' },
  ]);
  return password;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');

  if (dryRun) {
    console.log('[dry-run] — транзакции не будут отправлены\n');
  }

  const cfg: PathsConfig = { encPath: resolve('secrets.enc') };
  if (!hasEncrypted(cfg)) {
    console.error(
      'Нет зашифрованного файла secrets.enc. Сначала запустите `pnpm play` или `pnpm ui`.',
    );
    process.exit(1);
  }

  const password = await readPassword();
  let secrets;
  try {
    secrets = await decryptToMemory(password, cfg);
  } catch {
    console.error('Неверный пароль или файл повреждён.');
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
  const db = new StateDB(STATE_DB_PATH);

  try {
    console.log(`Аккаунтов: ${loaded.length}. Начинаем листинг...\n`);

    // Run all accounts in parallel (best-effort — failures don't block others)
    const settledResults = await Promise.allSettled(
      loaded.map(({ account }) => sellAllForAccount({ account, dryRun, db, log })),
    );

    let totalListed = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (let i = 0; i < settledResults.length; i++) {
      const r = settledResults[i]!;
      if (r.status === 'rejected') {
        const accName = loaded[i]!.account.name;
        console.error(
          `[${accName}] Ошибка: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        );
        totalFailed++;
        continue;
      }

      const res = r.value;
      totalListed += res.listed;
      totalSkipped += res.skipped;
      totalFailed += res.failed;

      console.log(
        `[${res.accountName}] (${res.agwAddress.slice(0, 10)}…)  ` +
          `рассмотрено: ${res.considered}  ` +
          `выставлено: ${res.listed}  ` +
          `пропущено: ${res.skipped}  ` +
          `ошибок: ${res.failed}`,
      );
      for (const err of res.errors) {
        console.error(`  ! ${err}`);
      }
    }

    console.log(
      `\n=== Итого ===  выставлено: ${totalListed}  пропущено: ${totalSkipped}  ошибок: ${totalFailed}`,
    );
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
