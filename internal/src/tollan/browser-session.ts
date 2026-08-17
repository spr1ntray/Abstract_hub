import type { Proxy } from '../vault/schema.js';
import type { StoredTollanSession } from './auth.js';
import type { AdsPowerConfig } from '../adspower/types.js';
import type { TollanQuestSnapshot } from './quest-engine.js';

export type TollanRunState =
  | 'idle'
  | 'queued'
  | 'loading'
  | 'starting'
  | 'playing'
  | 'claiming'
  | 'completed'
  | 'needs_auth'
  | 'failed'
  | 'stopped';

export interface TollanRunSnapshot {
  accountAlias: string;
  address: string;
  state: TollanRunState;
  message: string;
  wave: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  sessionId?: string;
  reward?: string;
  chestsOpened?: number;
  missionsClaimed?: number;
  runsCompleted?: number;
  bonusTargets?: number;
  quests?: TollanQuestSnapshot;
  note?: string;
  error?: string;
}

export interface TollanBrowserRunInput {
  sessionKey: string;
  accountAlias: string;
  address: string;
  proxy: Proxy;
  hubUrl: string;
  practicePath: string;
  missionPaths: readonly [string, string];
  inventoryPath: string;
  authStoreModuleId: number;
  missionBoardActionId: string;
  claimMissionActionId: string;
  session?: StoredTollanSession;
  adsPower?: AdsPowerConfig;
  adsPowerProfileId?: string;
  /** Server-side ownership hook. It is never persisted or sent to the renderer. */
  onSettled?: () => void | Promise<void>;
}

export interface TollanBrowserSessionBridge {
  start(input: TollanBrowserRunInput): Promise<TollanRunSnapshot>;
  stop(sessionKey?: string): Promise<TollanRunSnapshot[]>;
  status(sessionKey?: string): Promise<TollanRunSnapshot[]>;
}
