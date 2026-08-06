import { request, type Dispatcher } from 'undici';
import { encodeFunctionData, type Hex } from 'viem';
import { z } from 'zod';
import type { HubPack } from '../hub/pack.js';

const VoteStreakSchema = z.object({
  currentStreakDays: z.number().int().nonnegative(),
  longestStreakDays: z.number().int().nonnegative(),
  lastVoteAt: z.string().nullable(),
  streakStartDay: z.string().nullable(),
  votedToday: z.boolean(),
  nextVoteBy: z.string(),
});

const UserVotesSchema = z.object({
  votedApps: z
    .array(z.union([z.number(), z.string()]))
    .transform((values) => values.map((value) => Number(value)).filter(Number.isSafeInteger)),
  epoch: z.number().int().nonnegative(),
});

const DiscoverAppSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((value) => Number(value)),
  name: z.string().min(1),
  description: z.string().optional().default(''),
  icon: z.string().nullable().optional(),
  link: z.string().nullable().optional(),
  spotlight: z.string().nullable().optional(),
  launched: z.boolean(),
  categories: z
    .array(z.object({ category: z.string() }))
    .optional()
    .default([]),
});

const DiscoverAppsSchema = z.object({
  items: z.array(DiscoverAppSchema),
});

export type DiscoverVoteStreak = z.infer<typeof VoteStreakSchema>;
export type DiscoverApp = z.infer<typeof DiscoverAppSchema>;

export interface DiscoverSnapshot {
  streak: DiscoverVoteStreak;
  votedAppIds: number[];
  epoch: number;
  apps: DiscoverApp[];
}

export interface DiscoverVoteCall {
  to: `0x${string}`;
  data: Hex;
  value: bigint;
}

export type DiscoverJsonTransport = (url: string) => Promise<unknown>;

const VOTE_ABI = [
  {
    type: 'function',
    name: 'voteForApp',
    stateMutability: 'payable',
    inputs: [{ name: 'appId', type: 'uint256' }],
    outputs: [],
  },
] as const;

function accountPath(address: string): string {
  const normalized = address.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new Error('Некорректный адрес Abstract');
  return normalized;
}

export function makeDiscoverTransport(dispatcher: Dispatcher): DiscoverJsonTransport {
  return async (url: string) => {
    const response = await request(url, {
      method: 'GET',
      dispatcher,
      headers: {
        accept: 'application/json',
        'user-agent': 'Abstract-Hub',
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

export class DiscoverClient {
  constructor(
    private readonly config: HubPack['modules']['abstractDiscover'],
    private readonly getJson: DiscoverJsonTransport,
  ) {}

  async getStreak(address: string): Promise<DiscoverVoteStreak> {
    const raw = await this.getJson(
      `${this.config.apiBase}/api/user/${accountPath(address)}/vote-streak`,
    );
    return VoteStreakSchema.parse(raw);
  }

  async getSnapshot(address: string): Promise<DiscoverSnapshot> {
    const normalized = accountPath(address);
    const [streakRaw, votesRaw, appsRaw] = await Promise.all([
      this.getJson(`${this.config.apiBase}/api/user/${normalized}/vote-streak`),
      this.getJson(`${this.config.apiBase}/api/user/${normalized}/votes`),
      this.getJson(`${this.config.apiBase}/api/app?limit=${this.config.appsLimit}`),
    ]);
    const streak = VoteStreakSchema.parse(streakRaw);
    const votes = UserVotesSchema.parse(votesRaw);
    const apps = DiscoverAppsSchema.parse(appsRaw).items.filter(
      (app) => app.launched && Number.isSafeInteger(app.id) && app.id > 0,
    );
    return { streak, votedAppIds: votes.votedApps, epoch: votes.epoch, apps };
  }
}

export function pickRandomDiscoverApp(
  apps: DiscoverApp[],
  votedAppIds: Iterable<number>,
  random: () => number = Math.random,
): DiscoverApp | undefined {
  const voted = new Set(votedAppIds);
  const eligible = apps.filter(
    (app) => app.launched && Number.isSafeInteger(app.id) && app.id > 0 && !voted.has(app.id),
  );
  if (eligible.length === 0) return undefined;
  const sample = random();
  const index = Math.min(
    eligible.length - 1,
    Math.max(0, Math.floor((Number.isFinite(sample) ? sample : 0) * eligible.length)),
  );
  return eligible[index];
}

export function buildDiscoverVoteCall(
  config: HubPack['modules']['abstractDiscover'],
  appId: number,
): DiscoverVoteCall {
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('Некорректный ID приложения');
  return {
    to: config.voteContract,
    data: encodeFunctionData({
      abi: VOTE_ABI,
      functionName: 'voteForApp',
      args: [BigInt(appId)],
    }),
    value: 0n,
  };
}
