import { describe, expect, it } from 'vitest';
import {
  buildDiscoverVoteCall,
  DiscoverClient,
  pickRandomDiscoverApp,
  type DiscoverApp,
} from '../../src/abstract/discover.js';
import { HubPackSchema } from '../../src/hub/pack.js';
import packJson from '../../../hub-pack.json';

const pack = HubPackSchema.parse(packJson);

const apps: DiscoverApp[] = [
  {
    id: 10,
    name: 'Already voted',
    description: '',
    launched: true,
    categories: [],
  },
  {
    id: 20,
    name: 'Eligible',
    description: '',
    launched: true,
    categories: [],
  },
  {
    id: 30,
    name: 'Not launched',
    description: '',
    launched: false,
    categories: [],
  },
];

describe('Abstract Discover', () => {
  it('loads server streak, votes, and launched apps', async () => {
    const transport = async (url: string): Promise<unknown> => {
      if (url.endsWith('/vote-streak')) {
        return {
          currentStreakDays: 5,
          longestStreakDays: 8,
          lastVoteAt: '2026-07-30T12:00:00.000Z',
          streakStartDay: '2026-07-26',
          votedToday: true,
          nextVoteBy: '2026-07-31T15:00:00.000Z',
        };
      }
      if (url.endsWith('/votes')) return { votedApps: ['10'], epoch: 4 };
      return { items: apps };
    };
    const client = new DiscoverClient(pack.modules.abstractDiscover, transport);
    const snapshot = await client.getSnapshot(`0x${'a'.repeat(40)}`);
    expect(snapshot.streak.votedToday).toBe(true);
    expect(snapshot.votedAppIds).toEqual([10]);
    expect(snapshot.apps.map((app) => app.id)).toEqual([10, 20]);
  });

  it('selects only an active app that has not already been voted for', () => {
    expect(pickRandomDiscoverApp(apps, [10], () => 0)?.id).toBe(20);
    expect(pickRandomDiscoverApp(apps, [10, 20], () => 0)).toBeUndefined();
  });

  it('encodes a zero-value voteForApp transaction for the fixed Portal contract', () => {
    const call = buildDiscoverVoteCall(pack.modules.abstractDiscover, 207);
    expect(call.to).toBe('0x3B50dE27506f0a8C1f4122A1e6F470009a76ce2A');
    expect(call.value).toBe(0n);
    expect(call.data).toMatch(/^0x[0-9a-f]+$/);
  });
});
