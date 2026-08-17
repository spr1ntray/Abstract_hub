import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { GigaClient } from '../../src/api/client.js';
import type {
  EnergyState,
  GearInstance,
  GearItemCatalogEntry,
  OffchainRecipeEntry,
} from '../../src/api/types.js';
import { createDungeonCharmAutomation, type DungeonCharmEvent } from '../../src/gear/charm.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

const necklaceCatalog: GearItemCatalogEntry = {
  GAME_ITEM_ID_CID: 215,
  NAME_CID: 'Hexchain Necklace [GEAR]',
  TIER_CID: 2,
  EQUIPPABLE_TO_CID: 6,
  REPAIR_COUNT_CID: 2,
  repairCost: {
    INPUT_ID_CID_array: [7],
    INPUT_AMOUNT_CID_array: [10],
  },
};

const ringCatalog: GearItemCatalogEntry = {
  GAME_ITEM_ID_CID: 228,
  NAME_CID: 'Silver Ring [GEAR]',
  TIER_CID: 1,
  EQUIPPABLE_TO_CID: 6,
  REPAIR_COUNT_CID: 2,
  repairCost: {
    INPUT_ID_CID_array: [5],
    INPUT_AMOUNT_CID_array: [2],
  },
};

const necklaceRecipe: OffchainRecipeEntry = {
  docId: 'Recipe#50215',
  NAME_CID: 'Hexchain Necklace',
  INPUT_ID_CID_array: [99],
  INPUT_AMOUNT_CID_array: [2],
  LOOT_ID_CID_array: [215],
  LOOT_FULFILLER_ID_CID_array: ['gigaverse.system.gear'],
  ENERGY_CID: 20,
  TAG_CID_array: ['workbench', 'charm'],
  FILTERS_CID_array: ['Gear:Charm'],
};

function gear(itemId: number, docId: string, over: Partial<GearInstance> = {}): GearInstance {
  return {
    _id: docId,
    docId,
    GAME_ITEM_ID_CID: itemId,
    RARITY_CID: 0,
    EQUIPPED_TO_SLOT_CID: -1,
    DURABILITY_CID: 20,
    REPAIR_COUNT_CID: 0,
    ...over,
  };
}

function energy(value: number): EnergyState {
  return {
    energyValue: value,
    maxEnergy: 240,
    regenPerSecond: 0,
    regenPerHour: 0,
    secondsSinceLastUpdate: 0,
    isPlayerJuiced: false,
  };
}

async function automation(client: GigaClient, events: DungeonCharmEvent[]) {
  return await createDungeonCharmAutomation({
    client,
    agwAddress: ADDRESS,
    noobId: 74599,
    log: pino({ level: 'silent' }),
    onEvent: (event) => events.push(event),
  });
}

describe('dungeon charm automation', () => {
  it('equips an existing usable charm before a dungeon run', async () => {
    const existing = gear(215, 'GearInstance#215_existing', { DURABILITY_CID: 18 });
    const client = {
      getGearItemsCatalog: vi.fn().mockResolvedValue([necklaceCatalog]),
      getOffchainStatic: vi.fn().mockResolvedValue({ recipes: [necklaceRecipe] }),
      getGearInstances: vi.fn().mockResolvedValue([existing]),
      setGear: vi.fn().mockResolvedValue({ entities: [] }),
      salvageGear: vi.fn(),
      repairGear: vi.fn(),
      getItemBalances: vi.fn(),
      getEnergy: vi.fn(),
      startRecipe: vi.fn(),
    } as unknown as GigaClient;
    const events: DungeonCharmEvent[] = [];

    const manager = await automation(client, events);

    await expect(manager.prepareForRun()).resolves.toBe(true);
    expect(client.setGear).toHaveBeenCalledWith(existing.docId, 6, 0);
    expect(client.startRecipe).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: 'equipped',
      name: 'Hexchain Necklace',
      durability: 18,
    });
  });

  it('repairs a worn charm once materials are available and equips it', async () => {
    const broken = gear(215, 'GearInstance#215_broken', {
      DURABILITY_CID: 0,
      REPAIR_COUNT_CID: 1,
    });
    const repaired = { ...broken, DURABILITY_CID: 22, REPAIR_COUNT_CID: 2 };
    const client = {
      getGearItemsCatalog: vi.fn().mockResolvedValue([necklaceCatalog]),
      getOffchainStatic: vi.fn().mockResolvedValue({ recipes: [necklaceRecipe] }),
      getGearInstances: vi.fn().mockResolvedValue([broken]),
      getItemBalances: vi.fn().mockResolvedValue([{ ID_CID: 7, BALANCE_CID: 10 }]),
      repairGear: vi.fn().mockResolvedValue({ entities: [repaired] }),
      setGear: vi.fn().mockResolvedValue({ entities: [] }),
      salvageGear: vi.fn(),
      getEnergy: vi.fn(),
      startRecipe: vi.fn(),
    } as unknown as GigaClient;
    const events: DungeonCharmEvent[] = [];

    const manager = await automation(client, events);

    await expect(manager.prepareForRun()).resolves.toBe(true);
    expect(client.repairGear).toHaveBeenCalledWith(broken.docId);
    expect(client.setGear).toHaveBeenCalledWith(broken.docId, 6, 0);
    expect(events).toContainEqual({
      type: 'repaired',
      name: 'Hexchain Necklace',
      durability: 22,
      repairCount: 2,
    });
  });

  it('salvages a fully spent charm, crafts a replacement, and equips it', async () => {
    const spent = gear(215, 'GearInstance#215_spent', {
      DURABILITY_CID: 0,
      REPAIR_COUNT_CID: 2,
    });
    const crafted = gear(215, 'GearInstance#215_crafted', { DURABILITY_CID: 24 });
    const client = {
      getGearItemsCatalog: vi.fn().mockResolvedValue([necklaceCatalog]),
      getOffchainStatic: vi.fn().mockResolvedValue({ recipes: [necklaceRecipe] }),
      getGearInstances: vi.fn().mockResolvedValueOnce([spent]).mockResolvedValueOnce([crafted]),
      salvageGear: vi.fn().mockResolvedValue({ entities: [] }),
      getItemBalances: vi.fn().mockResolvedValue([{ ID_CID: 99, BALANCE_CID: 2 }]),
      getEnergy: vi.fn().mockResolvedValue(energy(100)),
      startRecipe: vi.fn().mockResolvedValue({ entities: [] }),
      setGear: vi.fn().mockResolvedValue({ entities: [] }),
      repairGear: vi.fn(),
    } as unknown as GigaClient;
    const events: DungeonCharmEvent[] = [];

    const manager = await automation(client, events);

    await expect(manager.prepareForRun()).resolves.toBe(true);
    expect(client.salvageGear).toHaveBeenCalledWith(spent.docId);
    expect(client.startRecipe).toHaveBeenCalledWith({
      recipeId: 'Recipe#50215',
      noobId: 74599,
      gearInstanceId: '',
      nodeIndex: 0,
      quantity: 1,
    });
    expect(client.setGear).toHaveBeenCalledWith(crafted.docId, 6, 0);
    expect(events.map((event) => event.type)).toEqual(['salvaged', 'crafted', 'equipped']);
  });

  it('salvages a charm that becomes irreparable during the final run', async () => {
    const spent = gear(215, 'GearInstance#215_final_spent', {
      DURABILITY_CID: 0,
      REPAIR_COUNT_CID: 2,
    });
    const client = {
      getGearItemsCatalog: vi.fn().mockResolvedValue([necklaceCatalog]),
      getOffchainStatic: vi.fn().mockResolvedValue({ recipes: [necklaceRecipe] }),
      getGearInstances: vi.fn().mockResolvedValue([spent]),
      salvageGear: vi.fn().mockResolvedValue({ entities: [] }),
    } as unknown as GigaClient;
    const events: DungeonCharmEvent[] = [];

    const manager = await automation(client, events);
    await manager.cleanupAfterRun();

    expect(client.salvageGear).toHaveBeenCalledWith(spent.docId);
    expect(events).toContainEqual({ type: 'salvaged', name: 'Hexchain Necklace' });
  });

  it('does not spend protected Wood or Stone on a charm', async () => {
    const woodenRecipe: OffchainRecipeEntry = {
      ...necklaceRecipe,
      INPUT_ID_CID_array: [21],
      INPUT_AMOUNT_CID_array: [1],
    };
    const ringRecipe: OffchainRecipeEntry = {
      ...necklaceRecipe,
      docId: 'Recipe#50228',
      NAME_CID: 'Silver Ring',
      INPUT_ID_CID_array: [99],
      LOOT_ID_CID_array: [228],
    };
    const craftedRing = gear(228, 'GearInstance#228_crafted');
    const client = {
      getGearItemsCatalog: vi.fn().mockResolvedValue([necklaceCatalog, ringCatalog]),
      getOffchainStatic: vi.fn().mockResolvedValue({ recipes: [woodenRecipe, ringRecipe] }),
      getGearInstances: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([craftedRing]),
      getItemBalances: vi.fn().mockResolvedValue([
        { ID_CID: 21, BALANCE_CID: 100 },
        { ID_CID: 99, BALANCE_CID: 2 },
      ]),
      getEnergy: vi.fn().mockResolvedValue(energy(100)),
      startRecipe: vi.fn().mockResolvedValue({ entities: [] }),
      setGear: vi.fn().mockResolvedValue({ entities: [] }),
      salvageGear: vi.fn(),
      repairGear: vi.fn(),
    } as unknown as GigaClient;
    const events: DungeonCharmEvent[] = [];

    const manager = await automation(client, events);

    await expect(manager.prepareForRun()).resolves.toBe(true);
    expect(client.startRecipe).toHaveBeenCalledWith(
      expect.objectContaining({ recipeId: 'Recipe#50228' }),
    );
  });

  it('keeps enough energy for the next dungeon run', async () => {
    const client = {
      getGearItemsCatalog: vi.fn().mockResolvedValue([necklaceCatalog]),
      getOffchainStatic: vi.fn().mockResolvedValue({ recipes: [necklaceRecipe] }),
      getGearInstances: vi.fn().mockResolvedValue([]),
      getItemBalances: vi.fn().mockResolvedValue([{ ID_CID: 99, BALANCE_CID: 2 }]),
      getEnergy: vi.fn().mockResolvedValue(energy(59)),
      startRecipe: vi.fn(),
      setGear: vi.fn(),
      salvageGear: vi.fn(),
      repairGear: vi.fn(),
    } as unknown as GigaClient;
    const events: DungeonCharmEvent[] = [];

    const manager = await automation(client, events);

    await expect(manager.prepareForRun()).resolves.toBe(false);
    expect(client.startRecipe).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: 'skipped',
      reason: 'для крафта Hexchain Necklace нужно сохранить 40 энергии на ран',
    });
  });
});
