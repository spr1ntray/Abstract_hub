import type { Proxy } from '../vault/schema.js';
import type { StoredTollanSession } from './auth.js';

export type TollanRunState =
  | 'idle'
  | 'queued'
  | 'loading'
  | 'starting'
  | 'playing'
  | 'completed'
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
  error?: string;
}

export interface TollanBrowserRunInput {
  sessionKey: string;
  accountAlias: string;
  address: string;
  proxy: Proxy;
  hubUrl: string;
  practicePath: string;
  authStoreModuleId: number;
  session: StoredTollanSession;
}

export interface TollanBrowserSessionBridge {
  start(input: TollanBrowserRunInput): Promise<TollanRunSnapshot>;
  stop(sessionKey?: string): Promise<TollanRunSnapshot[]>;
  status(sessionKey?: string): Promise<TollanRunSnapshot[]>;
}
