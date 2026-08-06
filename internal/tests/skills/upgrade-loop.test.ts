import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { GigaClient } from '../../src/api/client.js';
import { HttpError } from '../../src/api/errors.js';
import { runSkillUpgradeLoop } from '../../src/skills/upgrade-loop.js';

const catalog = {
  entities: [
    {
      docId: '1',
      name: 'Dungetron 5000',
      stats: [{ id: 0, name: 'Sword ATK', levelsPerPoint: [1, 1, 2] }],
    },
  ],
};

const progress = {
  entities: [
    {
      SKILL_CID: 1,
      NOOB_TOKEN_CID: 74599,
      LEVEL_CID_array: [0],
    },
  ],
};

describe('runSkillUpgradeLoop', () => {
  it('sends sequential levelups with the numeric noob token id', async () => {
    const client = {
      getSkillsCatalog: vi.fn().mockResolvedValue(catalog),
      getSkillsProgress: vi.fn().mockResolvedValue(progress),
      levelUpSkill: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as GigaClient;

    const result = await runSkillUpgradeLoop(client, 74599, pino({ level: 'silent' }), {
      maxUpgrades: 2,
      reconcileEvery: 0,
      delayRangeMs: { minMs: 0, maxMs: 0 },
      pick: { allowedSkills: [1], allowedStats: [0] },
    });

    expect(client.levelUpSkill).toHaveBeenNthCalledWith(1, {
      skillId: 1,
      statId: 0,
      noobId: 74599,
    });
    expect(client.levelUpSkill).toHaveBeenNthCalledWith(2, {
      skillId: 1,
      statId: 0,
      noobId: 74599,
    });
    expect(result.upgraded.map((upgrade) => upgrade.fromLevel)).toEqual([0, 1]);
    expect(result.stopReason).toBe('max upgrades reached (2)');
  });

  it('returns a server rejection as a normal stop reason', async () => {
    const client = {
      getSkillsCatalog: vi.fn().mockResolvedValue(catalog),
      getSkillsProgress: vi.fn().mockResolvedValue(progress),
      levelUpSkill: vi
        .fn()
        .mockRejectedValue(new HttpError(400, { message: 'Insufficient skill points' })),
    } as unknown as GigaClient;

    const result = await runSkillUpgradeLoop(client, 74599, pino({ level: 'silent' }), {
      reconcileEvery: 0,
      delayRangeMs: { minMs: 0, maxMs: 0 },
    });

    expect(result.upgraded).toHaveLength(0);
    expect(result.stopReason).toBe('Insufficient skill points');
  });

  it('stops before spending points when the operation deadline has elapsed', async () => {
    const client = {
      getSkillsCatalog: vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(catalog), 10))),
      getSkillsProgress: vi.fn().mockResolvedValue(progress),
      levelUpSkill: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as GigaClient;

    const result = await runSkillUpgradeLoop(client, 74599, pino({ level: 'silent' }), {
      timeLimitMs: 1,
      delayRangeMs: { minMs: 0, maxMs: 0 },
    });

    expect(client.levelUpSkill).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('time limit reached (1s)');
  });
});
