/**
 * pnpm inventory — fetch and display gear for every account.
 *
 * Usage:
 *   pnpm inventory [--export csv|json]
 *
 * Loads secrets the same way as play.ts (password prompt → decrypt secrets.enc),
 * then for each account fetches:
 *   GET /api/gear/instances/<agwAddress>
 *   GET /api/indexer/gameitems
 *
 * Outputs a cli-table3 table per account.  Optionally exports
 * inventory-<name>.<ext> files to the current working directory.
 */

import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import { parseAccountsFromText, FileLoadError } from './config/load-from-files.js';
import { decryptToMemory, hasEncrypted, type PathsConfig } from './config/encrypted-files.js';
import { GigaClient } from './api/client.js';
import { resolveAccountSession } from './api/account-session.js';
import { createLogger } from './logger.js';
import type { Account } from './vault/schema.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single gear instance as returned by /api/gear/instances/<agw> */
export interface GearInstance {
  gameItemId: number;
  GAME_ITEM_ID_CID?: number;
  quantity?: number;
  qty?: number;
  amount?: number;
  rarity?: string | number;
  equipped?: boolean;
  isEquipped?: boolean;
  [key: string]: unknown;
}

/** A catalog entry from /api/indexer/gameitems or /api/gear/items */
export interface GameItemCatalog {
  ID?: number;
  id?: number;
  docId?: string;
  ID_CID?: string | number;
  GAME_ITEM_ID_CID?: number;
  NAME?: string;
  name?: string;
  NAME_CID?: string;
  IMG_URL_CID?: string;
  imgUrl?: string;
  IMAGE_URL_CID?: string;
  IMAGE_CID?: string;
  image?: string;
  icon?: string;
  [key: string]: unknown;
}

/** Catalog entry value: name + optional image URL */
export interface CatalogEntry {
  name: string;
  image?: string;
}

export interface GearConditionCatalogEntry {
  durabilityByRarity: number[];
}

export interface InventoryConditionInstance {
  durability: number;
  maxDurability?: number;
  repairCount: number;
  equipped: boolean;
}

export interface InventoryCondition {
  instances: InventoryConditionInstance[];
  damagedCount: number;
  brokenCount: number;
  minimumPercent?: number;
}

/** Normalized row for display and export */
export interface InventoryRow {
  /** Numeric game item ID (kept for UI image lookup). */
  gameItemId: number;
  /** Human-readable name (from catalog) or `item#NNN` fallback. */
  item: string;
  /** Image URL if catalog provided one. */
  image?: string;
  /** Total stack count across all gear instances of this item. */
  qty: number;
  /** How many of `qty` are currently equipped. Always 0 <= equippedQty <= qty. */
  equippedQty: number;
  /** Rarity as a string (gigaverse uses numeric tiers; missing → "—"). */
  rarity: string;
  /** True when at least one instance is equipped — convenience alias for `equippedQty > 0`. */
  equipped: boolean;
  /** True when the catalog has no name for this gameItemId (rendered as `item#NNN`). */
  unknown: boolean;
  /** Per-instance durability for gear. Stackable balances do not have this field. */
  condition?: InventoryCondition;
}

export interface ItemBalance {
  ID_CID?: string | number;
  itemId?: string | number;
  gameItemId?: string | number;
  BALANCE_CID?: number;
  balance?: number;
  amount?: number;
  quantity?: number;
  docId?: string;
  [key: string]: unknown;
}

export interface AccountDisplayInfo {
  /** Stable technical alias from account parsing, e.g. acc1-a1b2c3. */
  alias: string;
  /** Best human-facing label: username when known, otherwise noob/address/alias. */
  displayName: string;
  username?: string;
  noobId?: string;
}

const gameItemMetadataCache = new Map<number, Promise<unknown | undefined>>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a gameItemId → name lookup map from the raw catalog response.
 * Handles both {ID, NAME} and {id, name} field naming conventions defensively.
 */
/**
 * Pull the inner array from a possibly-wrapped server response.
 * Server commonly wraps lists in {entities: [...]} or {items: [...]} etc.
 */
function unwrapArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  for (const key of ['entities', 'items', 'data', 'result', 'list', 'rows', 'gear', 'payload']) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  // Two-level unwrap: {result: {data: [...]}} pattern
  for (const key of ['result', 'data', 'payload']) {
    const nested = obj[key];
    if (nested && typeof nested === 'object') {
      const inner = nested as Record<string, unknown>;
      for (const k of ['entities', 'items', 'data', 'list', 'rows']) {
        if (Array.isArray(inner[k])) return inner[k] as unknown[];
      }
    }
  }
  return [];
}

/** Try several field-name variants to extract a string field. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** Try several field-name variants to extract a numeric ID (incl. numeric strings). */
export function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  }
  return undefined;
}

/**
 * `EQUIPPED_TO_SLOT_CID > 0` is the canonical equipped check across the
 * Gigaverse codebase (see marketplace/inventory.ts, sell-all.ts). Slot 0
 * means "in bag". Defends against null/undefined/string by coercing safely.
 */
function isEquippedFlag(g: Record<string, unknown>): boolean {
  if (g['equipped'] === true || g['isEquipped'] === true) return true;
  const slot = g['EQUIPPED_TO_SLOT_CID'];
  if (typeof slot === 'number') return slot > 0;
  if (typeof slot === 'string' && /^-?\d+$/.test(slot)) return Number(slot) > 0;
  return false;
}

/**
 * Build a gameItemId → {name, image?} catalog from /api/indexer/gameitems.
 *
 * Server may return raw array OR wrap in {entities/items/data}. Field naming
 * is inconsistent across endpoints (`ID` vs `id`, `NAME` vs `name`, `IMG_URL_CID`
 * vs `imgUrl` vs `image`) — probe defensively.
 *
 * If gigaverse hosts images at a stable CDN path, we also fall back to a
 * computed `/images/items/<id>.png` URL when the catalog gives no image.
 */
export function buildCatalog(raw: unknown): Map<number, CatalogEntry> {
  const map = new Map<number, CatalogEntry>();
  const list = unwrapArray(raw);
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    // /api/indexer/gameitems uses numeric-string docId as the item template ID
    // (e.g. {docId:"2", NAME_CID:"Dungeon Scrap"}). For instance lists,
    // docId is usually "GearInstance#..." and won't parse as a number.
    const id = pickNumber(obj, [
      'ID',
      'id',
      'ID_CID',
      'GAME_ITEM_ID_CID',
      'gameItemId',
      'itemId',
      'docId',
    ]);
    const name = pickString(obj, ['NAME', 'name', 'NAME_CID', 'displayName']);
    let image = pickString(obj, [
      'IMG_URL_CID',
      'IMAGE_URL_CID',
      'IMAGE_CID',
      'imgUrl',
      'image',
      'icon',
      'IMG_CID',
    ]);
    image = normalizeImageUrl(image);
    if (id !== undefined && name !== undefined) {
      map.set(id, image ? { name, image } : { name });
    }
  }
  return map;
}

/** Read maximum durability per rarity from `/api/gear/items`. */
export function buildGearConditionCatalog(raw: unknown): Map<number, GearConditionCatalogEntry> {
  const map = new Map<number, GearConditionCatalogEntry>();
  for (const entry of unwrapArray(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const id = pickNumber(obj, ['GAME_ITEM_ID_CID', 'gameItemId', 'itemId', 'ID_CID']);
    const rawDurability = obj['DURABILITY_CID_array'];
    if (id === undefined || !Array.isArray(rawDurability)) continue;
    const durabilityByRarity = rawDurability.map((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
      if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
      return 0;
    });
    if (durabilityByRarity.some((value) => value > 0)) map.set(id, { durabilityByRarity });
  }
  return map;
}

/** Parse the public /api/metadata/gameItem/:id response. */
export function parseGameItemMetadata(
  raw: unknown,
  fallbackName: string,
): CatalogEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const name = pickString(obj, ['name', 'NAME', 'NAME_CID']) ?? fallbackName;
  // `icon` is the square inventory asset; `image` is usually a larger card.
  const image = normalizeImageUrl(pickString(obj, ['icon', 'image', 'IMG_URL_CID']));
  if (!image && name === fallbackName) return undefined;
  return image ? { name, image } : { name };
}

export function normalizeImageUrl(image: string | undefined): string | undefined {
  if (!image) return undefined;
  if (image.startsWith('//')) return 'https:' + image;
  if (image.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + image.slice('ipfs://'.length);
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(image) || /^bafy[a-z0-9]+$/i.test(image)) {
    return 'https://ipfs.io/ipfs/' + image;
  }
  if (/^https?:\/\//i.test(image)) return image;
  return `https://gigaverse.io/${image.replace(/^\/+/, '')}`;
}

/**
 * Fill missing catalog images from Gigaverse's public metadata endpoint.
 * Requests are cached across accounts because every account shares item IDs.
 */
export async function enrichCatalogWithMetadata(
  client: Pick<GigaClient, 'getGameItemMetadata'>,
  gear: GearInstance[],
  catalog: Map<number, CatalogEntry>,
): Promise<Map<number, CatalogEntry>> {
  const missingRows = tallyItems(gear, catalog).filter((row) => !row.image);
  if (missingRows.length === 0) return catalog;

  const overlay = new Map<number, CatalogEntry>();
  const ids = Array.from(new Set(missingRows.map((row) => row.gameItemId)));

  for (let offset = 0; offset < ids.length; offset += 8) {
    const batch = ids.slice(offset, offset + 8);
    const entries = await Promise.all(
      batch.map(async (id) => {
        const fallbackName = catalog.get(id)?.name ?? `item#${id}`;
        const raw = await getCachedGameItemMetadata(client, id);
        return [id, parseGameItemMetadata(raw, fallbackName)] as const;
      }),
    );
    for (const [id, entry] of entries) {
      if (entry) overlay.set(id, entry);
    }
  }

  return mergeCatalogs(catalog, overlay);
}

function getCachedGameItemMetadata(
  client: Pick<GigaClient, 'getGameItemMetadata'>,
  id: number,
): Promise<unknown | undefined> {
  const cached = gameItemMetadataCache.get(id);
  if (cached) return cached;

  const request = client.getGameItemMetadata(id).catch(() => {
    gameItemMetadataCache.delete(id);
    return undefined;
  });
  gameItemMetadataCache.set(id, request);
  return request;
}

/** Merge several catalogs, later catalogs winning name/image conflicts. */
export function mergeCatalogs(
  ...catalogs: Array<Map<number, CatalogEntry>>
): Map<number, CatalogEntry> {
  const merged = new Map<number, CatalogEntry>();
  for (const catalog of catalogs) {
    for (const [id, entry] of catalog) {
      merged.set(id, entry);
    }
  }
  return merged;
}

/**
 * Normalize a raw gear instances response into InventoryRow[].
 *
 * The server may wrap the list in .entities, .items, .data, or return it
 * at the top level. Falls back gracefully for all shapes.
 */
export function extractGearList(raw: unknown): GearInstance[] {
  return unwrapArray(raw) as GearInstance[];
}

/** Normalize /api/items/balances rows into tally-compatible stack rows. */
export function extractBalanceList(raw: unknown): GearInstance[] {
  const out: GearInstance[] = [];
  for (const entry of unwrapArray(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const id = pickNumber(obj, ['ID_CID', 'itemId', 'gameItemId', 'GAME_ITEM_ID_CID', 'id']);
    const qty = pickNumber(obj, ['BALANCE_CID', 'balance', 'amount', 'quantity', 'qty']);
    if (id === undefined || qty === undefined || qty <= 0) continue;
    const docId = pickString(obj, ['docId', '_id']) ?? `balance-${id}`;
    out.push({
      gameItemId: id,
      GAME_ITEM_ID_CID: id,
      quantity: qty,
      docId,
      rarity: '—',
      equipped: false,
    });
  }
  return out;
}

export function extractAccountDisplayInfo(
  alias: string,
  agwAddress: string,
  ...sources: unknown[]
): AccountDisplayInfo {
  const username = pickFirstStringDeep(sources, [
    'primaryUsername',
    'username',
    'NAME_CID',
    'name',
  ]);
  const noobId = pickFirstNumberStringDeep(sources, [
    'NOOB_TOKEN_CID',
    'noobId',
    'noobID',
    'docId',
    '_id',
  ]);
  const shortAddr = agwAddress ? `${agwAddress.slice(0, 10)}...${agwAddress.slice(-4)}` : '';
  const displayName = username ? `@${username}` : noobId ? `noob #${noobId}` : shortAddr || alias;
  return {
    alias,
    displayName,
    ...(username ? { username } : {}),
    ...(noobId ? { noobId } : {}),
  };
}

function pickFirstStringDeep(sources: unknown[], keys: string[]): string | undefined {
  for (const source of sources) {
    const value = findDeep(source, (obj) => pickString(obj, keys));
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function pickFirstNumberStringDeep(sources: unknown[], keys: string[]): string | undefined {
  for (const source of sources) {
    const value = findDeep(source, (obj) => {
      const picked = pickNumber(obj, keys);
      return picked !== undefined && picked > 0 ? String(picked) : undefined;
    });
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function findDeep(
  source: unknown,
  picker: (obj: Record<string, unknown>) => string | undefined,
  seen = new Set<unknown>(),
): string | undefined {
  if (!source || typeof source !== 'object' || seen.has(source)) return undefined;
  seen.add(source);
  const obj = source as Record<string, unknown>;
  const direct = picker(obj);
  if (direct !== undefined) return direct;
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findDeep(item, picker, seen);
        if (found !== undefined) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findDeep(value, picker, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Tally raw gear instances into display rows using the item catalog.
 *
 * Exported as a pure function so both `pnpm inventory` (CLI) and the UI
 * `/api/inventory` endpoint share one source of truth — without this two
 * normalizers drift apart (rarity types, ID-typing, sort order).
 *
 * Group key is `gameItemId`. Counts both total instances and how many of
 * them are currently equipped — a slot count of 0 means "in bag".
 *
 * `docId` is a per-NFT unique identifier; we dedupe by it to defend against
 * the server returning the same row twice in a list.
 */
export function tallyItems(
  gear: GearInstance[],
  catalog: Map<number, CatalogEntry>,
  conditionCatalog: ReadonlyMap<number, GearConditionCatalogEntry> = new Map(),
): InventoryRow[] {
  const grouped = new Map<number, InventoryRow>();
  const seenDocIds = new Set<string>();

  for (const g of gear) {
    const gObj = g as Record<string, unknown>;

    // ID probing — pickNumber tolerates numeric strings, fixing instances
    // that arrive as `{ "gameItemId": "49" }`.
    const id = pickNumber(gObj, ['gameItemId', 'GAME_ITEM_ID_CID', 'itemId', 'gameId']);
    if (id === undefined) continue;

    // Dedup by docId when present (server can echo the same NFT twice).
    const docId = pickString(gObj, ['docId', '_id', 'id']);
    if (docId !== undefined) {
      if (seenDocIds.has(docId)) continue;
      seenDocIds.add(docId);
    }

    // Quantity: a gear instance usually represents ONE NFT, so when there's
    // no explicit quantity field we count it as 1. Stacks (quantity > 1)
    // arrive on consumables; we add the explicit value when present.
    const qty = pickNumber(gObj, ['quantity', 'qty', 'amount']) ?? 1;

    const rarityRaw = gObj['rarity'] ?? gObj['RARITY_CID'] ?? gObj['Rarity'];
    const rarity =
      typeof rarityRaw === 'string'
        ? rarityRaw
        : typeof rarityRaw === 'number' && rarityRaw > 0
          ? String(rarityRaw)
          : '—';

    const equipped = isEquippedFlag(gObj);
    // When a stack of N is equipped we treat the whole stack as equipped —
    // gigaverse doesn't expose partial-equip semantics for stackables.
    const equippedDelta = equipped ? qty : 0;

    const entry = catalog.get(id);
    const itemName = entry?.name ?? `item#${id}`;
    const isUnknown = entry?.name === undefined;
    const durability = pickNumber(gObj, ['DURABILITY_CID', 'durability']);
    const repairCount = pickNumber(gObj, ['REPAIR_COUNT_CID', 'repairCount']) ?? 0;
    const rarityIndex = pickNumber(gObj, ['RARITY_CID', 'rarity']);
    const maxDurability =
      rarityIndex !== undefined
        ? conditionCatalog.get(id)?.durabilityByRarity[rarityIndex]
        : undefined;
    const conditionInstance =
      durability !== undefined
        ? {
            durability: Math.max(0, durability),
            ...(maxDurability !== undefined && maxDurability > 0 ? { maxDurability } : {}),
            repairCount: Math.max(0, repairCount),
            equipped,
          }
        : undefined;

    const existing = grouped.get(id);
    if (existing) {
      existing.qty += qty;
      existing.equippedQty += equippedDelta;
      if (equippedDelta > 0) existing.equipped = true;
      // Prefer a non-"—" rarity over a missing one.
      if (existing.rarity === '—' && rarity !== '—') existing.rarity = rarity;
      if (conditionInstance) appendInventoryCondition(existing, conditionInstance);
    } else {
      const row: InventoryRow = {
        gameItemId: id,
        item: itemName,
        ...(entry?.image ? { image: entry.image } : {}),
        qty,
        equippedQty: equippedDelta,
        rarity,
        equipped: equippedDelta > 0,
        unknown: isUnknown,
      };
      if (conditionInstance) appendInventoryCondition(row, conditionInstance);
      grouped.set(id, row);
    }
  }

  // Sort: known items alphabetically first, unknown `item#NNN` block at the
  // bottom sorted numerically by ID (so item#9 comes before item#10).
  return Array.from(grouped.values()).sort((a, b) => {
    if (a.unknown !== b.unknown) return a.unknown ? 1 : -1;
    if (a.unknown && b.unknown) return a.gameItemId - b.gameItemId;
    return a.item.localeCompare(b.item, 'ru');
  });
}

function appendInventoryCondition(row: InventoryRow, instance: InventoryConditionInstance): void {
  row.condition ??= { instances: [], damagedCount: 0, brokenCount: 0 };
  row.condition.instances.push(instance);
  if (instance.durability <= 0) row.condition.brokenCount += 1;
  if (instance.maxDurability !== undefined && instance.durability < instance.maxDurability) {
    row.condition.damagedCount += 1;
    const percent = Math.max(
      0,
      Math.min(100, Math.round((instance.durability / instance.maxDurability) * 100)),
    );
    row.condition.minimumPercent =
      row.condition.minimumPercent === undefined
        ? percent
        : Math.min(row.condition.minimumPercent, percent);
  } else if (instance.maxDurability !== undefined && row.condition.minimumPercent === undefined) {
    row.condition.minimumPercent = 100;
  }
}

// ── Password prompt (same pattern as play.ts) ────────────────────────────────

async function readPassword(message: string): Promise<string> {
  const { password } = await inquirer.prompt<{ password: string }>([
    { type: 'password', name: 'password', mask: '*', message },
  ]);
  return password;
}

// ── Per-account fetch ─────────────────────────────────────────────────────────

/**
 * Authenticate a single account and fetch its energy + gear.
 * Returns the raw gear list, catalog, energy state, and AGW address.
 */
async function fetchAccountInventory(
  account: Account,
  log: ReturnType<typeof createLogger>,
): Promise<{
  agwAddress: string;
  display: AccountDisplayInfo;
  gear: GearInstance[];
  catalog: Map<number, CatalogEntry>;
  energyValue: number;
  maxEnergy: number;
}> {
  const client = new GigaClient(account, log);

  const session = await resolveAccountSession({ account, log });
  const agwAddress = session.agwAddress;
  const gameAccount = session.loginResult.gameAccount;
  client.setJwt(session.loginResult.jwt);

  // Fetch energy, gear instances, item balances, catalogs, and account profile in parallel.
  const [energyResult, gearRaw, balancesRaw, gameCatalogRaw, gearCatalogRaw, profileRaw] =
    await Promise.all([
      client.getEnergy(agwAddress).catch(() => null),
      client.getGearInstances(agwAddress).catch(() => []),
      client.getItemBalances().catch(() => []),
      client.getGameItemsCatalog().catch(() => []),
      client.getGearItemsCatalog().catch(() => []),
      client.get<unknown>(`/api/account/${agwAddress}`, { authed: true }).catch(() => undefined),
    ]);

  const gear = [...extractGearList(gearRaw), ...extractBalanceList(balancesRaw)];
  const baseCatalog = mergeCatalogs(buildCatalog(gameCatalogRaw), buildCatalog(gearCatalogRaw));
  const catalog = await enrichCatalogWithMetadata(client, gear, baseCatalog);
  const display = extractAccountDisplayInfo(account.name, agwAddress, gameAccount, profileRaw);
  const energyValue = energyResult?.energyValue ?? 0;
  const maxEnergy = energyResult?.maxEnergy ?? 0;

  return { agwAddress, display, gear, catalog, energyValue, maxEnergy };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderTable(
  rows: InventoryRow[],
  account: AccountDisplayInfo,
  agwAddress: string,
  energyValue: number,
  maxEnergy: number,
): void {
  const ENERGY_PER_RUN = 40;
  const runsLeft = maxEnergy > 0 ? Math.floor(energyValue / ENERGY_PER_RUN) : '?';
  const shortAddr = agwAddress ? `${agwAddress.slice(0, 10)}...${agwAddress.slice(-4)}` : '';
  const secondary = [account.alias, account.noobId ? `noob #${account.noobId}` : '', shortAddr]
    .filter(Boolean)
    .join(' · ');
  console.log(
    `\n── ${account.displayName}${secondary ? ` (${secondary})` : ''} ──  ⚡ Энергия: ${energyValue}/${maxEnergy} (ранов: ${runsLeft})`,
  );
  if (rows.length === 0) {
    console.log('  (нет предметов)');
    return;
  }
  const t = new Table({
    head: ['Предмет', 'Кол-во', 'Редкость', 'Одето'],
    style: { head: ['cyan'] },
  });
  for (const r of rows) {
    const equippedCell =
      r.equippedQty === 0 ? '—' : r.equippedQty === r.qty ? 'да' : `${r.equippedQty}/${r.qty}`;
    t.push([r.item, String(r.qty), r.rarity, equippedCell]);
  }
  console.log(t.toString());
}

// ── Export helpers ────────────────────────────────────────────────────────────

function exportCsv(rows: InventoryRow[], filename: string): void {
  const lines = ['item,qty,rarity,equipped'];
  for (const r of rows) {
    lines.push(`"${r.item.replace(/"/g, '""')}",${r.qty},"${r.rarity}",${r.equipped}`);
  }
  writeFileSync(filename, lines.join('\n') + '\n', 'utf8');
  console.log(`  Экспортировано → ${filename}`);
}

function exportJson(rows: InventoryRow[], filename: string): void {
  writeFileSync(filename, JSON.stringify(rows, null, 2) + '\n', 'utf8');
  console.log(`  Экспортировано → ${filename}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function inventory(): Promise<void> {
  const argv = process.argv.slice(2);

  // --export csv|json
  const exportIdx = argv.indexOf('--export');
  const exportFmt: 'csv' | 'json' | null =
    exportIdx >= 0 && (argv[exportIdx + 1] === 'csv' || argv[exportIdx + 1] === 'json')
      ? (argv[exportIdx + 1] as 'csv' | 'json')
      : null;

  const cfg: PathsConfig = {
    encPath: resolve(argv.find((a, i) => argv[i - 1] === '--secrets') ?? 'secrets.enc'),
  };

  if (!hasEncrypted(cfg)) {
    console.error(
      'Нет зашифрованного файла secrets.enc. Сначала запустите `pnpm play` или `pnpm ui`.',
    );
    process.exit(1);
  }

  const password = await readPassword('Мастер-пароль:');
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

  for (const { account } of loaded) {
    try {
      const { agwAddress, display, gear, catalog, energyValue, maxEnergy } =
        await fetchAccountInventory(account, log);
      const rows = tallyItems(gear, catalog);
      renderTable(rows, display, agwAddress, energyValue, maxEnergy);

      if (exportFmt) {
        // Use first 8 chars of name to keep filenames short
        const slug = `${display.displayName.replace(/^@/, '')}-${display.alias}`
          .slice(0, 32)
          .replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `inventory-${slug}.${exportFmt}`;
        if (exportFmt === 'csv') exportCsv(rows, filename);
        else exportJson(rows, filename);
      }
    } catch (e) {
      console.error(`[${account.name}] Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inventory().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
