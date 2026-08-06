import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { runNodeRewards } from '../../src/nodes/rewards.js';
import type { GigaClient } from '../../src/api/client.js';
import type { EnergyState, GearInstance, RecipeStartRequest } from '../../src/api/types.js';
import { HttpError } from '../../src/api/errors.js';

const silentLog = pino({ level: 'silent' });

function energy(value: number, isPlayerJuiced = false): EnergyState {
  return {
    energyValue: value,
    maxEnergy: 240,
    regenPerSecond: 0,
    regenPerHour: 0,
    secondsSinceLastUpdate: 0,
    isPlayerJuiced,
  };
}

function gear(over: Partial<GearInstance> & { docId: string; itemId: number }): GearInstance {
  return {
    _id: over._id ?? over.docId,
    docId: over.docId,
    GAME_ITEM_ID_CID: over.itemId,
    RARITY_CID: over.RARITY_CID ?? 0,
    EQUIPPED_TO_SLOT_CID: over.EQUIPPED_TO_SLOT_CID ?? -1,
    DURABILITY_CID: over.DURABILITY_CID ?? 0,
    ...(over.REPAIR_COUNT_CID !== undefined ? { REPAIR_COUNT_CID: over.REPAIR_COUNT_CID } : {}),
  };
}

describe('runNodeRewards', () => {
  it('breaks available pots, repairs gloves once, then claims chests', async () => {
    const paper = gear({ docId: 'GearInstance#234_a', itemId: 234, DURABILITY_CID: 4 });
    const rock = gear({ docId: 'GearInstance#235_a', itemId: 235, DURABILITY_CID: 2 });

    const client = {
      getGearInstances: vi.fn().mockResolvedValue([paper, rock]),
      getEnergy: vi.fn().mockResolvedValue(energy(100, true)),
      repairGear: vi.fn(async (gearInstanceId: string) => ({
        entities: [
          gearInstanceId === paper.docId
            ? { ...paper, DURABILITY_CID: 12, REPAIR_COUNT_CID: 1 }
            : { ...rock, DURABILITY_CID: 28, REPAIR_COUNT_CID: 1 },
        ],
      })),
      startRecipe: vi.fn(async (req: RecipeStartRequest) => ({
        entities: [
          {
            ID_CID: req.recipeId,
            LOOT_ID_CID_array: [req.recipeId === 'Recipe#700000' ? 2 : 25],
            LOOT_AMOUNT_CID_array: [1],
          },
        ],
      })),
      salvageGear: vi.fn(),
    } as unknown as GigaClient;

    const summary = await runNodeRewards({
      client,
      agwAddress: '0xabc',
      noobId: 42,
      log: silentLog,
    });

    expect(summary.potsBroken).toBe(6);
    expect(summary.chestsClaimed).toBe(2);
    expect(summary.repairs).toBe(2);
    expect(summary.noEnergy).toBe(false);
    expect(client.repairGear as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(paper.docId);
    expect(client.repairGear as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(rock.docId);

    const starts = (client.startRecipe as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as RecipeStartRequest,
    );
    expect(starts.map((s) => `${s.recipeId}:${s.nodeIndex}`)).toEqual([
      'Recipe#700001:0',
      'Recipe#700001:1',
      'Recipe#700001:2',
      'Recipe#700001:3',
      'Recipe#700002:0',
      'Recipe#700002:1',
      'Recipe#700000:0',
      'Recipe#700003:0',
    ]);
  });

  it('stops breaking pots when energy is low but still tries zero-cost chests', async () => {
    const paper = gear({ docId: 'GearInstance#234_a', itemId: 234, DURABILITY_CID: 12 });

    const client = {
      getGearInstances: vi.fn().mockResolvedValue([paper]),
      getEnergy: vi
        .fn()
        .mockResolvedValueOnce(energy(5, true))
        .mockResolvedValueOnce(energy(0, true)),
      repairGear: vi.fn(),
      startRecipe: vi.fn(async (req: RecipeStartRequest) => ({
        entities: [
          {
            ID_CID: req.recipeId,
            LOOT_ID_CID_array: [25],
            LOOT_AMOUNT_CID_array: [1],
          },
        ],
      })),
      salvageGear: vi.fn(),
    } as unknown as GigaClient;

    const summary = await runNodeRewards({
      client,
      agwAddress: '0xabc',
      noobId: 42,
      log: silentLog,
    });

    expect(summary.potsBroken).toBe(1);
    expect(summary.chestsClaimed).toBe(2);
    expect(summary.noEnergy).toBe(true);

    const starts = (client.startRecipe as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as RecipeStartRequest,
    );
    expect(starts.map((s) => s.recipeId)).toEqual([
      'Recipe#700001',
      'Recipe#700000',
      'Recipe#700003',
    ]);
  });

  it('skips Juiced Chest locally when account is not juiced', async () => {
    const client = {
      getGearInstances: vi.fn().mockResolvedValue([]),
      getEnergy: vi.fn().mockResolvedValue(energy(0, false)),
      repairGear: vi.fn(),
      startRecipe: vi.fn(async (req: RecipeStartRequest) => ({
        entities: [
          {
            ID_CID: req.recipeId,
            LOOT_ID_CID_array: [2],
            LOOT_AMOUNT_CID_array: [1],
          },
        ],
      })),
      salvageGear: vi.fn(),
    } as unknown as GigaClient;

    const events: unknown[] = [];
    const summary = await runNodeRewards({
      client,
      agwAddress: '0xabc',
      noobId: 42,
      log: silentLog,
      onEvent: (event) => events.push(event),
    });

    expect(summary.chestsClaimed).toBe(1);
    expect(summary.skipped).toBe(1);
    const starts = (client.startRecipe as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as RecipeStartRequest,
    );
    expect(starts.map((s) => s.recipeId)).toEqual(['Recipe#700000']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'skip',
        label: 'Juiced Chest',
        reason: 'аккаунт не juiced',
      }),
    );
  });

  it('treats server 500 Player is not juiced as a skippable Juiced Chest error', async () => {
    const client = {
      getGearInstances: vi.fn().mockResolvedValue([]),
      getEnergy: vi.fn().mockResolvedValue(energy(0, true)),
      repairGear: vi.fn(),
      startRecipe: vi.fn(async (req: RecipeStartRequest) => {
        if (req.recipeId === 'Recipe#700003') {
          throw new HttpError(500, {
            error: 'INTERNAL_ERROR',
            message: 'Player is not juiced',
          });
        }
        return {
          entities: [
            {
              ID_CID: req.recipeId,
              LOOT_ID_CID_array: [2],
              LOOT_AMOUNT_CID_array: [1],
            },
          ],
        };
      }),
      salvageGear: vi.fn(),
    } as unknown as GigaClient;

    const summary = await runNodeRewards({
      client,
      agwAddress: '0xabc',
      noobId: 42,
      log: silentLog,
    });

    expect(summary.chestsClaimed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(client.startRecipe as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2);
  });

  it('crafts Paper Hands when blue pots remain and no wooden glove is usable', async () => {
    const craftedPaper = gear({
      docId: 'GearInstance#234_crafted',
      itemId: 234,
      DURABILITY_CID: 8,
    });

    const client = {
      getGearInstances: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([craftedPaper]),
      getEnergy: vi.fn().mockResolvedValue(energy(100, true)),
      repairGear: vi.fn(),
      startRecipe: vi.fn(async (req: RecipeStartRequest) => ({
        entities: [
          {
            ID_CID: req.recipeId,
            LOOT_ID_CID_array: req.recipeId === 'Recipe#50234' ? [234, 185] : [25],
            LOOT_AMOUNT_CID_array: req.recipeId === 'Recipe#50234' ? [1, 8] : [1],
          },
        ],
      })),
      salvageGear: vi.fn(),
    } as unknown as GigaClient;

    const summary = await runNodeRewards({
      client,
      agwAddress: '0xabc',
      noobId: 42,
      log: silentLog,
    });

    expect(summary.crafted).toBe(1);
    expect(summary.potsBroken).toBe(4);
    expect(summary.chestsClaimed).toBe(2);

    const starts = (client.startRecipe as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as RecipeStartRequest,
    );
    expect(starts.map((s) => `${s.recipeId}:${s.gearInstanceId}:${s.nodeIndex}`)).toEqual([
      'Recipe#50234::0',
      'Recipe#700001:GearInstance#234_crafted:0',
      'Recipe#700001:GearInstance#234_crafted:1',
      'Recipe#700001:GearInstance#234_crafted:2',
      'Recipe#700001:GearInstance#234_crafted:3',
      'Recipe#700000::0',
      'Recipe#700003::0',
    ]);
    expect(summary.rewards).toContainEqual(
      expect.objectContaining({ itemId: 185, amount: 8, name: 'Workbench XP' }),
    );
  });

  it('does not call craft recipe when local balances show missing Wood', async () => {
    const client = {
      getGearInstances: vi.fn().mockResolvedValue([]),
      getEnergy: vi.fn().mockResolvedValue(energy(100)),
      getItemBalances: vi.fn().mockResolvedValue([
        { ID_CID: '21', BALANCE_CID: 2 },
        { ID_CID: '4', BALANCE_CID: 100 },
        { ID_CID: '7', BALANCE_CID: 100 },
      ]),
      repairGear: vi.fn(),
      startRecipe: vi.fn(async (req: RecipeStartRequest) => ({
        entities: [
          {
            ID_CID: req.recipeId,
            LOOT_ID_CID_array: [25],
            LOOT_AMOUNT_CID_array: [1],
          },
        ],
      })),
      salvageGear: vi.fn(),
    } as unknown as GigaClient;

    const events: unknown[] = [];
    const summary = await runNodeRewards({
      client,
      agwAddress: '0xabc',
      noobId: 42,
      log: silentLog,
      onEvent: (event) => events.push(event),
    });

    expect(summary.crafted).toBe(0);
    expect(summary.potsBroken).toBe(0);
    expect(client.startRecipe as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    const starts = (client.startRecipe as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as RecipeStartRequest,
    );
    expect(starts.map((s) => s.recipeId)).toEqual(['Recipe#700000']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'skip',
        label: 'Blue Pot',
        reason: expect.stringContaining('не хватает Wood (нужно 16, есть 2)'),
      }),
    );
  });

  it('salvages spent repaired gloves instead of keeping retrying them', async () => {
    const paper = gear({ docId: 'GearInstance#234_a', itemId: 234, DURABILITY_CID: 8 });
    const spentAfterUseRock = gear({
      docId: 'GearInstance#235_spent',
      itemId: 235,
      DURABILITY_CID: 2,
      REPAIR_COUNT_CID: 1,
    });

    const client = {
      getGearInstances: vi.fn().mockResolvedValue([paper, spentAfterUseRock]),
      getEnergy: vi.fn().mockResolvedValue(energy(100, true)),
      repairGear: vi.fn(),
      startRecipe: vi.fn(async (req: RecipeStartRequest) => ({
        entities: [
          {
            ID_CID: req.recipeId,
            LOOT_ID_CID_array: [25],
            LOOT_AMOUNT_CID_array: [1],
          },
        ],
      })),
      salvageGear: vi.fn().mockResolvedValue({ entities: [spentAfterUseRock] }),
    } as unknown as GigaClient;

    const summary = await runNodeRewards({
      client,
      agwAddress: '0xabc',
      noobId: 42,
      log: silentLog,
    });

    expect(summary.potsBroken).toBe(5);
    expect(summary.salvaged).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(client.repairGear as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(client.salvageGear as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      spentAfterUseRock.docId,
    );
  });
});
