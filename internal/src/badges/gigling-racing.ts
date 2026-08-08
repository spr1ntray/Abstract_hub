import type { Dispatcher } from 'undici';
import { request } from 'undici';
import { z } from 'zod';
import type { HubPack } from '../hub/pack.js';
import type { ItemBalanceEntity, RacingLobbySyncRequest } from '../api/types.js';

type RacingConfig = HubPack['modules']['gigaverse']['racing'];
type FlashCampaignConfig = NonNullable<HubPack['modules']['abstractBadges']['flash']>;

export interface RacingConsumable {
  itemId: number;
  kind: 'Dung' | 'Butterfly';
  variant: 'generic' | 'faction';
  count: number;
  floorWei?: bigint;
}

export interface RacingInventorySummary {
  dung: number;
  butterfly: number;
  total: number;
  selected?: RacingConsumable;
}

export interface RacingTarget {
  raceId: number;
  petId: number;
}

export interface RacingGameClient {
  syncRacingLobby(body: RacingLobbySyncRequest): Promise<unknown>;
  useRacingItem(
    raceId: number,
    body: { petId: number; itemId: number; amount: 1 },
  ): Promise<unknown>;
  tickRacingRace(raceId: number): Promise<unknown>;
}

export interface RacingItemSubmission {
  currentTick: number | null;
  scheduledTick: number;
  submittedAt: number;
}

export interface RacingActionProgress {
  raceId: number;
  phase: number | null;
  lastResolvedTick: number;
  itemFound: boolean;
  appliedAt: number | null;
  refundedAt: number | null;
  finished: boolean;
}

export interface RacingActionVerification extends RacingActionProgress {
  appliedAt: number;
  finished: true;
}

export interface PendingRacingActionResolution {
  finished: boolean;
  submission?: RacingItemSubmission;
}

export class RacingActionNotAppliedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RacingActionNotAppliedError';
  }
}

export interface PortalFlashBadge {
  id: number;
  type: string;
  name: string;
  description: string;
  requirement: string;
  url: string;
  timeStart: number;
  timeEnd: number;
}

export type PortalJsonTransport = (url: string) => Promise<unknown>;

const PortalFlashBadgeSchema = z
  .object({
    id: z.number().int().positive(),
    type: z.string(),
    name: z.string().min(1),
    description: z.string(),
    requirement: z.string(),
    url: z.string().url(),
    timeStart: z.number().finite(),
    timeEnd: z.number().finite(),
  })
  .passthrough();

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function balanceValue(entity: Record<string, unknown>): number {
  for (const key of ['BALANCE_CID', 'balance', 'amount', 'quantity']) {
    const parsed = numericValue(entity[key]);
    if (parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function itemIdValue(entity: Record<string, unknown>): number | undefined {
  for (const key of ['ID_CID', 'itemId', 'gameItemId', 'GAME_ITEM_ID_CID']) {
    const parsed = numericValue(entity[key]);
    if (parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function itemKind(config: RacingConfig, itemId: number): RacingConsumable | undefined {
  if (itemId === config.genericDungItemId) {
    return { itemId, kind: 'Dung', variant: 'generic', count: 0 };
  }
  if (itemId === config.genericButterflyItemId) {
    return { itemId, kind: 'Butterfly', variant: 'generic', count: 0 };
  }
  if (config.dungItemIds.includes(itemId)) {
    return { itemId, kind: 'Dung', variant: 'faction', count: 0 };
  }
  if (config.butterflyItemIds.includes(itemId)) {
    return { itemId, kind: 'Butterfly', variant: 'faction', count: 0 };
  }
  return undefined;
}

function fallbackItemPriority(item: RacingConsumable): number {
  if (item.kind === 'Dung' && item.variant === 'generic') return 0;
  if (item.kind === 'Butterfly' && item.variant === 'generic') return 1;
  if (item.kind === 'Dung') return 2;
  return 3;
}

export function summarizeRacingInventory(
  balances: ItemBalanceEntity[],
  config: RacingConfig,
  floors: ReadonlyMap<number, bigint> = new Map(),
): RacingInventorySummary {
  const counts = new Map<number, number>();
  for (const raw of balances) {
    const entity = objectValue(raw);
    if (!entity) continue;
    const itemId = itemIdValue(entity);
    if (!itemId || !itemKind(config, itemId)) continue;
    counts.set(itemId, (counts.get(itemId) ?? 0) + balanceValue(entity));
  }

  const candidates: RacingConsumable[] = [];
  let dung = 0;
  let butterfly = 0;
  for (const [itemId, count] of counts) {
    if (count <= 0) continue;
    const item = itemKind(config, itemId);
    if (!item) continue;
    const floorWei = floors.get(itemId);
    const candidate: RacingConsumable = {
      ...item,
      count,
      ...(floorWei !== undefined && floorWei > 0n ? { floorWei } : {}),
    };
    candidates.push(candidate);
    if (item.kind === 'Dung') dung += count;
    else butterfly += count;
  }

  candidates.sort((left, right) => {
    if (left.floorWei !== undefined && right.floorWei !== undefined) {
      const delta = left.floorWei - right.floorWei;
      if (delta !== 0n) return delta < 0n ? -1 : 1;
    } else if (left.floorWei !== undefined) {
      return -1;
    } else if (right.floorWei !== undefined) {
      return 1;
    }
    return fallbackItemPriority(left) - fallbackItemPriority(right) || left.itemId - right.itemId;
  });

  return {
    dung,
    butterfly,
    total: dung + butterfly,
    ...(candidates[0] ? { selected: candidates[0] } : {}),
  };
}

export function buildRacingLobbySyncRequest(
  selectedRaceId: number | null = null,
): RacingLobbySyncRequest {
  return {
    limit: 20,
    selectedRaceId,
    pendingCreatedRaceId: null,
    pendingJoin: null,
    filters: {
      tab: 'live',
      sortBy: null,
      raceId: null,
      buyInIds: [],
      distanceIds: [],
      minRacers: 2,
      maxRacers: 8,
      onlyCreatedByViewer: false,
      onlyEnteredByViewer: false,
      expiredOnly: false,
      hideExpired: true,
      showCustomRaces: true,
      hideNoJackpotRaces: false,
      specialEventOnly: false,
      openExpirySecs: null,
    },
    includeRaces: true,
    includeSelectedRace: selectedRaceId !== null,
    includeRecentWinners: false,
    includeRecentJackpotWins: false,
    includeSpecialEventRaces: false,
    includeMyRaces: false,
    includeHostedRace: false,
    includePayouts: false,
  };
}

interface NormalizedRace {
  raceId: number;
  phase: number;
  petIds: number[];
}

function responseRoot(raw: unknown): Record<string, unknown> {
  const root = objectValue(raw) ?? {};
  const data = objectValue(root['data']);
  return data && ('races' in data || 'selectedRace' in data) ? data : root;
}

function petIdsFromRace(race: Record<string, unknown>): number[] {
  const values: number[] = [];
  const entries = Array.isArray(race['entries']) ? race['entries'] : [];
  for (const entry of entries) {
    const object = objectValue(entry);
    const petId = object ? numericValue(object['petId'] ?? object['PET_ID_CID']) : undefined;
    if (petId && Number.isSafeInteger(petId)) values.push(petId);
  }
  const racePets = Array.isArray(race['racePets']) ? race['racePets'] : [];
  for (const value of racePets) {
    const petId = numericValue(value);
    if (petId && Number.isSafeInteger(petId)) values.push(petId);
  }
  return Array.from(new Set(values));
}

function normalizeRace(raw: unknown): NormalizedRace | undefined {
  const race = objectValue(raw);
  if (!race) return undefined;
  const raceId = numericValue(race['raceId'] ?? race['id']);
  const phase = numericValue(race['phase']);
  if (!raceId || phase === undefined || !Number.isSafeInteger(raceId)) return undefined;
  return { raceId, phase, petIds: petIdsFromRace(race) };
}

export function extractLiveRaces(raw: unknown, livePhase: number): NormalizedRace[] {
  const root = responseRoot(raw);
  const races = Array.isArray(root['races']) ? root['races'] : [];
  return races
    .map(normalizeRace)
    .filter((race): race is NormalizedRace => Boolean(race && race.phase === livePhase));
}

function extractSelectedRace(raw: unknown, raceId: number): NormalizedRace | undefined {
  const root = responseRoot(raw);
  for (const key of ['selectedRace', 'selectedRaceSummary', 'currentRaceState']) {
    const race = normalizeRace(root[key]);
    if (race?.raceId === raceId) return race;
  }
  const races = Array.isArray(root['races']) ? root['races'] : [];
  return races.map(normalizeRace).find((race) => race?.raceId === raceId);
}

function pickIndex(length: number, random: () => number): number {
  const sample = random();
  const value = Number.isFinite(sample) ? sample : 0;
  return Math.max(0, Math.min(length - 1, Math.floor(value * length)));
}

export async function findLiveRacingTarget(
  client: RacingGameClient,
  config: RacingConfig,
  random: () => number = Math.random,
): Promise<RacingTarget | undefined> {
  const lobby = await client.syncRacingLobby(buildRacingLobbySyncRequest());
  const candidates = extractLiveRaces(lobby, config.livePhase);
  const remaining = [...candidates];

  while (remaining.length > 0) {
    const candidateIndex = pickIndex(remaining.length, random);
    const candidate = remaining.splice(candidateIndex, 1)[0]!;
    const detail = await client.syncRacingLobby(buildRacingLobbySyncRequest(candidate.raceId));
    const selected = extractSelectedRace(detail, candidate.raceId);
    if (!selected || selected.phase !== config.livePhase || selected.petIds.length === 0) continue;
    return {
      raceId: selected.raceId,
      petId: selected.petIds[pickIndex(selected.petIds.length, random)]!,
    };
  }
  return undefined;
}

export function assertRacingItemAccepted(raw: unknown): RacingItemSubmission {
  const root = objectValue(raw);
  if (!root) throw new Error('Gigaverse вернул пустой ответ на использование предмета');
  if (root['success'] === false) {
    const message = root['message'] ?? root['error'];
    throw new Error(typeof message === 'string' ? message : 'Gigaverse отклонил предмет');
  }
  const data = objectValue(root['data']);
  if (root['success'] !== true && !data) {
    throw new Error('Gigaverse не подтвердил использование предмета');
  }
  const scheduledItem = objectValue(data?.['scheduledItem']);
  const scheduledTick = numericValue(scheduledItem?.['atTick']);
  const submittedAt = numericValue(scheduledItem?.['submittedAt']);
  if (scheduledTick === undefined || submittedAt === undefined) {
    throw new Error('Gigaverse не подтвердил постановку предмета в очередь гонки');
  }
  const currentTick = numericValue(data?.['currentTick']);
  return { currentTick: currentTick ?? null, scheduledTick, submittedAt };
}

function nullableTimestamp(value: unknown): number | null {
  return numericValue(value) ?? null;
}

export function extractRacingActionProgress(
  raw: unknown,
  expected: {
    raceId: number;
    petId: number;
    itemId: number;
    address: string;
    submittedAt: number;
  },
): RacingActionProgress {
  const root = objectValue(raw);
  const data = objectValue(root?.['data']) ?? root;
  if (!data) throw new Error('Gigaverse вернул пустое состояние гонки');
  if (root?.['success'] === false) {
    const message = root['message'] ?? root['error'];
    throw new Error(typeof message === 'string' ? message : 'Gigaverse не обновил гонку');
  }

  const raceId = numericValue(data['raceId']);
  if (raceId !== expected.raceId) throw new Error('Gigaverse вернул состояние другой гонки');
  const normalizedAddress = expected.address.toLowerCase();
  const scheduledItems = Array.isArray(data['scheduledItems']) ? data['scheduledItems'] : [];
  const scheduledItem = scheduledItems.map(objectValue).find((item) => {
    if (!item) return false;
    return (
      numericValue(item['petId']) === expected.petId &&
      numericValue(item['itemId']) === expected.itemId &&
      numericValue(item['submittedAt']) === expected.submittedAt &&
      typeof item['submittedBy'] === 'string' &&
      item['submittedBy'].toLowerCase() === normalizedAddress
    );
  });
  const raceResult = objectValue(data['raceResult']);
  return {
    raceId,
    phase: numericValue(data['phase']) ?? null,
    lastResolvedTick: numericValue(data['lastResolvedTick']) ?? 0,
    itemFound: Boolean(scheduledItem),
    appliedAt: nullableTimestamp(scheduledItem?.['appliedAt']),
    refundedAt: nullableTimestamp(scheduledItem?.['refundedAt']),
    finished: data['finished'] === true || raceResult?.['completed'] === true,
  };
}

/**
 * Recover the server queue identity after use-item timed out after sending.
 * Matching is deliberately strict so an older consumable can never unlock a
 * second spend for the same badge.
 */
export function resolvePendingRacingAction(
  raw: unknown,
  expected: {
    raceId: number;
    petId: number;
    itemId: number;
    address: string;
    startedAt: number;
  },
): PendingRacingActionResolution {
  const root = objectValue(raw);
  const data = objectValue(root?.['data']) ?? root;
  if (!data) throw new Error('Gigaverse вернул пустое состояние гонки');
  if (root?.['success'] === false) {
    const message = root['message'] ?? root['error'];
    throw new Error(typeof message === 'string' ? message : 'Gigaverse не обновил гонку');
  }
  if (numericValue(data['raceId']) !== expected.raceId) {
    throw new Error('Gigaverse вернул состояние другой гонки');
  }

  const normalizedAddress = expected.address.toLowerCase();
  const scheduledItems = Array.isArray(data['scheduledItems']) ? data['scheduledItems'] : [];
  const matches = scheduledItems
    .map(objectValue)
    .filter((item): item is Record<string, unknown> => {
      if (!item) return false;
      const submittedAt = numericValue(item['submittedAt']);
      return (
        submittedAt !== undefined &&
        submittedAt >= expected.startedAt - 30_000 &&
        numericValue(item['petId']) === expected.petId &&
        numericValue(item['itemId']) === expected.itemId &&
        typeof item['submittedBy'] === 'string' &&
        item['submittedBy'].toLowerCase() === normalizedAddress
      );
    })
    .sort(
      (left, right) =>
        (numericValue(left['submittedAt']) ?? 0) - (numericValue(right['submittedAt']) ?? 0),
    );
  const scheduledItem = matches[0];
  const scheduledTick = numericValue(scheduledItem?.['atTick']);
  const submittedAt = numericValue(scheduledItem?.['submittedAt']);
  const raceResult = objectValue(data['raceResult']);
  const finished = data['finished'] === true || raceResult?.['completed'] === true;

  return {
    finished,
    ...(scheduledTick !== undefined && submittedAt !== undefined
      ? {
          submission: {
            currentTick: numericValue(data['currentTick']) ?? null,
            scheduledTick,
            submittedAt,
          },
        }
      : {}),
  };
}

export async function watchRacingItemApplication(input: {
  client: RacingGameClient;
  raceId: number;
  petId: number;
  itemId: number;
  address: string;
  submittedAt: number;
  maxAttempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<RacingActionVerification> {
  const maxAttempts = input.maxAttempts ?? 240;
  const intervalMs = input.intervalMs ?? 1_000;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let itemWasApplied = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (input.signal?.aborted) throw new Error('Операция остановлена');
    if (attempt > 0) await sleep(intervalMs);
    if (input.signal?.aborted) throw new Error('Операция остановлена');
    const progress = extractRacingActionProgress(await input.client.tickRacingRace(input.raceId), {
      raceId: input.raceId,
      petId: input.petId,
      itemId: input.itemId,
      address: input.address,
      submittedAt: input.submittedAt,
    });
    if (progress.refundedAt !== null) {
      throw new RacingActionNotAppliedError(
        'Gigaverse вернул предмет: Racing-действие не выполнено',
      );
    }
    itemWasApplied ||= progress.appliedAt !== null;
    if (progress.finished) {
      if (!itemWasApplied || progress.appliedAt === null) {
        throw new RacingActionNotAppliedError(
          'Гонка завершилась, но Gigaverse не применил предмет',
        );
      }
      return { ...progress, appliedAt: progress.appliedAt, finished: true };
    }
  }

  throw new Error('Гонка не завершилась за 4 минуты; хаб продолжит её после повторной проверки');
}

export function makePortalBadgeTransport(dispatcher?: Dispatcher): PortalJsonTransport {
  return async (url: string) => {
    const response = await request(url, {
      method: 'GET',
      ...(dispatcher ? { dispatcher } : {}),
      headers: {
        accept: 'application/json',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      },
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    const text = await response.body.text();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Abstract Portal HTTP ${response.statusCode}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error('Abstract Portal вернул некорректный JSON', { cause: error });
    }
  };
}

export class PortalBadgeClient {
  constructor(
    private readonly apiBase: string,
    private readonly getJson: PortalJsonTransport,
  ) {}

  async getCurrentFlashBadge(): Promise<PortalFlashBadge> {
    return PortalFlashBadgeSchema.parse(await this.getJson(`${this.apiBase}/api/badge/flash`));
  }

  async isBadgeClaimed(address: string, badgeId: number): Promise<boolean> {
    const normalized = address.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new Error('Некорректный адрес Abstract');
    const raw = await this.getJson(`${this.apiBase}/api/user/address/${normalized}`);
    return profileHasBadge(raw, badgeId);
  }
}

export function profileHasBadge(raw: unknown, badgeId: number): boolean {
  const root = objectValue(raw) ?? {};
  const data = objectValue(root['data']);
  const user = objectValue(root['user']) ?? objectValue(data?.['user']) ?? data ?? root;
  const badges = Array.isArray(user['badges']) ? user['badges'] : [];
  for (const value of badges) {
    const entry = objectValue(value);
    if (!entry) continue;
    const badge = objectValue(entry['badge']);
    const id = numericValue(entry['badgeId'] ?? badge?.['id'] ?? entry['id']);
    if (id !== badgeId) continue;
    return entry['claimed'] !== false;
  }
  return false;
}

export function verifyFlashCampaign(
  expected: FlashCampaignConfig,
  current: PortalFlashBadge,
  now = Date.now(),
): void {
  if (current.id !== expected.id) {
    throw new Error(
      `Portal уже сменил flash-бейдж: ожидался #${expected.id}, сейчас #${current.id}. Обновите data-pack.`,
    );
  }
  if (now < current.timeStart) throw new Error('Flash-кампания ещё не началась');
  if (now >= current.timeEnd) throw new Error('Flash-кампания завершена');
}
