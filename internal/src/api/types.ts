import type { PlayerState } from '../combat/types.js';
import type { LootOption } from '../loot/types.js';

// ---------------------------------------------------------------------------
// Auth / account types
// ---------------------------------------------------------------------------

/**
 * The "noob" NFT summary nested inside gameAccount.
 * Only the fields we actually log are typed; the rest is unknown.
 */
export interface NoobSummary {
  /** Token ID string, e.g. "75769". */
  _id?: string;
  /** Canonical token ID in account/profile payloads. */
  docId?: string;
  /** Character level CID — 1 means base level. */
  LEVEL_CID?: number;
  [key: string]: unknown;
}

/**
 * The gameAccount object from /api/user/auth.
 * Typed loosely — only fields needed for pre-flight diagnostics.
 */
export interface GameAccount {
  username?: string;
  canEnterGame?: boolean;
  hasAcceptedLegal?: boolean;
  /** The noob NFT; null/undefined if not yet minted. */
  noob?: NoobSummary | null;
  [key: string]: unknown;
}

/**
 * The user object from /api/user/auth.
 * Typed loosely — only fields needed for diagnostics.
 */
export interface AuthUser {
  username?: string;
  [key: string]: unknown;
}

/**
 * Full result from loginToGigaverse().
 * Extends the old { jwt, expiresAt } with the raw server objects for diagnostics.
 */
export interface LoginResult {
  jwt: string;
  /** Unix timestamp in milliseconds when the JWT expires (~7-day TTL). */
  expiresAt: number;
  /** Raw gameAccount from the auth response — used for pre-flight checks. */
  gameAccount: GameAccount;
  /** Raw user object from the auth response. */
  user: AuthUser;
}

// ---------------------------------------------------------------------------
// Dungeon state / today types
// ---------------------------------------------------------------------------

/**
 * A single dungeon descriptor from GET /api/game/dungeon/today.
 * Typed for the fields we log; everything else is unknown.
 */
export interface DungeonInfo {
  _id: string;
  /** Numeric dungeon ID used in start_run (e.g. 1, 3). */
  dungeonId?: number;
  /** Human-readable name. */
  name?: string;
  /** Maximum runs per day when account is "juiced". */
  juicedMaxRunsPerDay?: number;
  /** Maximum room number the dungeon has. */
  maxRoom?: number;
  [key: string]: unknown;
}

/**
 * Response from GET /api/game/dungeon/today.
 */
export interface DungeonTodayResponse {
  success?: boolean;
  dungeons?: DungeonInfo[];
  [key: string]: unknown;
}

/**
 * Minimal shape of an active run inside a dungeon state response.
 */
export interface ActiveRunInfo {
  /** Current room number. */
  ROOM_NUM_CID?: number;
  /** Whether this run is already complete. */
  COMPLETE_CID?: boolean;
  [key: string]: unknown;
}

/**
 * Response from GET /api/game/dungeon/state.
 */
export interface DungeonStateResponse {
  success?: boolean;
  /** Present when there's an ongoing run. */
  run?: ActiveRunInfo | null;
  /** Alternative shape some endpoints use. */
  entity?: ActiveRunInfo | null;
  /**
   * The server's current replay-protection token for the active run.
   * Present when `run` is non-null; must be echoed in the next action call.
   * May be a number (server sends it as a numeric timestamp) or a string.
   */
  actionToken?: number | string | null;
  [key: string]: unknown;
}

export type ActionName =
  | 'start_run'
  | 'rock'
  | 'paper'
  | 'scissor'
  | 'loot_one'
  | 'loot_two'
  | 'loot_three'
  | 'flee';

/**
 * Player energy snapshot returned by GET /api/offchain/player/energy/<addr>.
 * energyValue/maxEnergy are integer display units (40 energy = 1 run).
 */
export interface EnergyState {
  energyValue: number;
  maxEnergy: number;
  regenPerSecond: number;
  regenPerHour: number;
  secondsSinceLastUpdate: number;
  isPlayerJuiced: boolean;
}

/**
 * A Gigaverse JWT and its expiry (unix epoch ms).
 * Produced by loginToGigaverse() in src/api/auth.ts.
 */
export interface JwtSession {
  jwt: string;
  expiresAt: number;
}

export interface ActionRequest {
  action: ActionName;
  actionToken: string; // Date.now().toString()
  dungeonId: number; // only for start_run, otherwise 0
  data: {
    consumables: never[];
    itemId: number;
    expectedAmount: number;
    index: number;
    isJuiced: boolean;
    gearInstanceIds: never[];
  };
}

export interface GearInstance {
  _id: string;
  docId: string;
  GAME_ITEM_ID_CID: number;
  RARITY_CID: number;
  EQUIPPED_TO_SLOT_CID: number;
  DURABILITY_CID: number;
  REPAIR_COUNT_CID?: number;
}

export interface GearItemCatalogEntry {
  GAME_ITEM_ID_CID: number;
  NAME_CID?: string;
  [key: string]: unknown;
}

export interface GameItemCatalogEntry {
  docId?: string;
  ID_CID?: string | number;
  GAME_ITEM_ID_CID?: number;
  NAME_CID?: string;
  [key: string]: unknown;
}

export interface GameItemMetadata {
  name?: string;
  description?: string;
  image?: string;
  icon?: string;
  [key: string]: unknown;
}

export interface ItemBalanceEntity {
  ID_CID: string | number;
  BALANCE_CID: number;
  [key: string]: unknown;
}

export interface RacingLobbySyncRequest {
  limit: number;
  selectedRaceId: number | null;
  pendingCreatedRaceId: number | null;
  pendingJoin: { raceId: number; petId: number } | null;
  filters: {
    tab: 'live';
    sortBy: null;
    raceId: number | null;
    buyInIds: string[];
    distanceIds: string[];
    minRacers: number;
    maxRacers: number;
    onlyCreatedByViewer: boolean;
    onlyEnteredByViewer: boolean;
    expiredOnly: boolean;
    hideExpired: boolean;
    showCustomRaces: boolean;
    hideNoJackpotRaces: boolean;
    specialEventOnly: boolean;
    openExpirySecs: number | null;
  };
  includeRaces: boolean;
  includeSelectedRace: boolean;
  includeRecentWinners: boolean;
  includeRecentJackpotWins: boolean;
  includeSpecialEventRaces: boolean;
  includeMyRaces: boolean;
  includeHostedRace: boolean;
  includePayouts: boolean;
}

export interface RacingUseItemRequest {
  petId: number;
  itemId: number;
  amount: 1;
}

export interface RecipeStartRequest {
  recipeId: string;
  noobId: number;
  gearInstanceId: string;
  nodeIndex: number;
  quantity: number;
}

export interface RecipeRewardEntity {
  _id?: string;
  docId?: string;
  ID_CID?: string;
  UINT256_CID?: number;
  SUCCESS_CID?: boolean;
  LOOT_ID_CID_array?: number[];
  LOOT_AMOUNT_CID_array?: number[];
  LOOT_FULFILLER_ID_CID_array?: string[];
  [key: string]: unknown;
}

export interface RecipeStartResponse {
  entities?: RecipeRewardEntity[];
  [key: string]: unknown;
}

export interface GearRepairResponse {
  entities?: GearInstance[];
  [key: string]: unknown;
}

export interface GearSalvageResponse {
  entities?: GearInstance[];
  [key: string]: unknown;
}

export interface RunEntity {
  ROOM_NUM_CID: number;
  ENEMY_CID: number;
  COMPLETE_CID: boolean;
  LEVEL_CID: number;
  data: {
    gearInstances: GearInstance[];
    roomInvaderItemsEarned: unknown[];
  };
}

export interface RunState {
  players: [PlayerState, PlayerState]; // [me, enemy]
  lootPhase: boolean;
  lootOptions: LootOption[];
  COMPLETE_CID?: boolean;
}

export interface GameEvent {
  type: string;
  value: unknown;
  playerId: 0 | 1;
  batch: number;
  data: Record<string, unknown>;
}

export interface ActionResponse {
  success: boolean;
  message: string;
  actionToken: string;
  data: {
    run: RunState;
    entity: RunEntity;
    events: GameEvent[];
  };
}

/**
 * Build an ActionRequest.
 *
 * @param name       - The action name (e.g. 'start_run', 'rock').
 * @param opts.dungeonId   - Only required for 'start_run'; defaults to 0.
 * @param opts.actionToken - Replay-protection token echoed from the previous
 *                           action response. Pass '' for the first action of a
 *                           run (start_run).
 */
export function makeAction(
  name: ActionName,
  opts: { dungeonId?: number; actionToken?: string } = {},
): ActionRequest {
  return {
    action: name,
    actionToken: opts.actionToken ?? '',
    dungeonId: opts.dungeonId ?? 0,
    data: {
      consumables: [],
      itemId: 0,
      expectedAmount: 0,
      index: 0,
      isJuiced: false,
      gearInstanceIds: [],
    },
  };
}
