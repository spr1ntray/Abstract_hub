import type { Logger } from 'pino';
import type { GigaClient } from '../api/client.js';
import type {
  GearInstance,
  GearItemCatalogEntry,
  ItemBalanceEntity,
  OffchainRecipeEntry,
} from '../api/types.js';
import { isProtectedMarketItem } from '../marketplace/pricing.js';

const CHARM_SLOT_TYPE = 6;
const CHARM_SLOT_INDEX = 0;
const DUNGEON_ENERGY_RESERVE = 40;

interface ItemAmount {
  itemId: number;
  amount: number;
}

interface CharmDefinition {
  itemId: number;
  name: string;
  tier: number;
  maxRepairs: number;
  repairInputs: ItemAmount[];
}

interface CharmRecipe {
  recipeId: string;
  name: string;
  outputItemId: number;
  energy: number;
  inputs: ItemAmount[];
}

export type DungeonCharmEvent =
  | { type: 'ready'; name: string; durability: number }
  | { type: 'equipped'; name: string; durability: number }
  | { type: 'repaired'; name: string; durability: number; repairCount: number }
  | { type: 'crafted'; name: string; recipeId: string }
  | { type: 'salvaged'; name: string }
  | { type: 'skipped'; reason: string };

export interface DungeonCharmAutomation {
  prepareForRun(): Promise<boolean>;
  cleanupAfterRun(): Promise<void>;
}

export async function createDungeonCharmAutomation(opts: {
  client: GigaClient;
  agwAddress: string;
  noobId: number;
  log: Logger;
  onEvent?: (event: DungeonCharmEvent) => void;
}): Promise<DungeonCharmAutomation> {
  const [gearCatalog, staticData] = await Promise.all([
    opts.client.getGearItemsCatalog(),
    opts.client.getOffchainStatic(),
  ]);
  const definitions = parseCharmDefinitions(gearCatalog);
  if (definitions.size === 0) throw new Error('Gigaverse не вернул каталог амулетов');
  const recipes = parseCharmRecipes(staticData.recipes ?? [], definitions);
  return new LiveDungeonCharmAutomation({ ...opts, definitions, recipes });
}

class LiveDungeonCharmAutomation implements DungeonCharmAutomation {
  private readonly client: GigaClient;
  private readonly agwAddress: string;
  private readonly noobId: number;
  private readonly log: Logger;
  private readonly onEvent: ((event: DungeonCharmEvent) => void) | undefined;
  private readonly definitions: Map<number, CharmDefinition>;
  private readonly recipes: CharmRecipe[];
  private announcedReadyId: string | undefined;
  private lastSkipReason: string | undefined;

  constructor(opts: {
    client: GigaClient;
    agwAddress: string;
    noobId: number;
    log: Logger;
    onEvent?: (event: DungeonCharmEvent) => void;
    definitions: Map<number, CharmDefinition>;
    recipes: CharmRecipe[];
  }) {
    this.client = opts.client;
    this.agwAddress = opts.agwAddress;
    this.noobId = opts.noobId;
    this.log = opts.log;
    this.onEvent = opts.onEvent;
    this.definitions = opts.definitions;
    this.recipes = opts.recipes;
  }

  async prepareForRun(): Promise<boolean> {
    let gear = await this.client.getGearInstances(this.agwAddress);
    gear = await this.salvageFinishedCharms(gear);

    const usable = this.pickUsableCharm(gear);
    if (usable) return await this.ensureEquipped(usable);

    const balances = balanceMap(await this.client.getItemBalances());
    const repaired = await this.repairOneCharm(gear, balances);
    if (repaired) return await this.ensureEquipped(repaired);

    const recipe = this.pickCraftableRecipe(balances);
    if (!recipe) {
      this.skipOnce('нет материалов для доступного амулета');
      return false;
    }

    const energy = await this.client.getEnergy(this.agwAddress);
    if (energy.energyValue < recipe.energy + DUNGEON_ENERGY_RESERVE) {
      this.skipOnce(
        `для крафта ${recipe.name} нужно сохранить ${DUNGEON_ENERGY_RESERVE} энергии на ран`,
      );
      return false;
    }

    try {
      await this.client.startRecipe({
        recipeId: recipe.recipeId,
        noobId: this.noobId,
        gearInstanceId: '',
        nodeIndex: 0,
        quantity: 1,
      });
      this.onEvent?.({ type: 'crafted', name: recipe.name, recipeId: recipe.recipeId });
      this.log.info(
        { recipeId: recipe.recipeId, outputItemId: recipe.outputItemId },
        'dungeon charm crafted',
      );
    } catch (error) {
      this.log.warn({ recipeId: recipe.recipeId, err: error }, 'dungeon charm craft skipped');
      this.skipOnce(`крафт ${recipe.name} не выполнен: ${errorMessage(error)}`);
      return false;
    }

    const crafted = await this.waitForCraftedCharm(recipe.outputItemId);
    if (!crafted) {
      this.skipOnce(`${recipe.name} скрафчен, но новый экземпляр пока не появился`);
      return false;
    }
    return await this.ensureEquipped(crafted);
  }

  async cleanupAfterRun(): Promise<void> {
    const gear = await this.client.getGearInstances(this.agwAddress);
    await this.salvageFinishedCharms(gear);
  }

  private async salvageFinishedCharms(gear: GearInstance[]): Promise<GearInstance[]> {
    const remaining = [...gear];
    const finished = gear.filter((instance) => {
      const definition = this.definitions.get(instance.GAME_ITEM_ID_CID);
      return (
        definition !== undefined &&
        instance.DURABILITY_CID <= 0 &&
        repairCount(instance) >= definition.maxRepairs
      );
    });

    for (const instance of finished) {
      const definition = this.definitions.get(instance.GAME_ITEM_ID_CID)!;
      try {
        await this.client.salvageGear(instance.docId);
        const index = remaining.findIndex((entry) => entry.docId === instance.docId);
        if (index >= 0) remaining.splice(index, 1);
        if (this.announcedReadyId === instance.docId) this.announcedReadyId = undefined;
        this.onEvent?.({ type: 'salvaged', name: definition.name });
        this.log.info({ gearInstanceId: instance.docId }, 'finished dungeon charm salvaged');
      } catch (error) {
        this.log.warn(
          { gearInstanceId: instance.docId, err: error },
          'finished dungeon charm salvage skipped',
        );
      }
    }
    return remaining;
  }

  private pickUsableCharm(gear: GearInstance[]): GearInstance | undefined {
    return gear
      .filter(
        (instance) =>
          this.definitions.has(instance.GAME_ITEM_ID_CID) && instance.DURABILITY_CID > 0,
      )
      .sort((left, right) => {
        const leftEquipped = left.EQUIPPED_TO_SLOT_CID === CHARM_SLOT_TYPE ? 1 : 0;
        const rightEquipped = right.EQUIPPED_TO_SLOT_CID === CHARM_SLOT_TYPE ? 1 : 0;
        if (leftEquipped !== rightEquipped) return rightEquipped - leftEquipped;
        const tierDelta =
          (this.definitions.get(right.GAME_ITEM_ID_CID)?.tier ?? 0) -
          (this.definitions.get(left.GAME_ITEM_ID_CID)?.tier ?? 0);
        if (tierDelta !== 0) return tierDelta;
        if (left.RARITY_CID !== right.RARITY_CID) return right.RARITY_CID - left.RARITY_CID;
        return left.DURABILITY_CID - right.DURABILITY_CID;
      })[0];
  }

  private async repairOneCharm(
    gear: GearInstance[],
    balances: Map<number, number>,
  ): Promise<GearInstance | undefined> {
    const candidates = gear
      .filter((instance) => {
        const definition = this.definitions.get(instance.GAME_ITEM_ID_CID);
        return (
          definition !== undefined &&
          instance.DURABILITY_CID <= 0 &&
          repairCount(instance) < definition.maxRepairs &&
          hasInputs(definition.repairInputs, balances)
        );
      })
      .sort((left, right) => {
        const leftTier = this.definitions.get(left.GAME_ITEM_ID_CID)?.tier ?? 0;
        const rightTier = this.definitions.get(right.GAME_ITEM_ID_CID)?.tier ?? 0;
        return rightTier - leftTier || right.RARITY_CID - left.RARITY_CID;
      });

    for (const candidate of candidates) {
      const definition = this.definitions.get(candidate.GAME_ITEM_ID_CID)!;
      try {
        const response = await this.client.repairGear(candidate.docId);
        const updated =
          response.entities?.find((entry) => entry.docId === candidate.docId) ??
          (await this.client.getGearInstances(this.agwAddress)).find(
            (entry) => entry.docId === candidate.docId,
          );
        if (!updated || updated.DURABILITY_CID <= 0) continue;
        this.onEvent?.({
          type: 'repaired',
          name: definition.name,
          durability: updated.DURABILITY_CID,
          repairCount: repairCount(updated),
        });
        this.log.info(
          { gearInstanceId: candidate.docId, durability: updated.DURABILITY_CID },
          'dungeon charm repaired',
        );
        return updated;
      } catch (error) {
        this.log.warn(
          { gearInstanceId: candidate.docId, err: error },
          'dungeon charm repair skipped',
        );
      }
    }
    return undefined;
  }

  private pickCraftableRecipe(balances: Map<number, number>): CharmRecipe | undefined {
    return this.recipes.find(
      (recipe) =>
        !recipe.inputs.some((input) => isProtectedMarketItem(input.itemId)) &&
        hasInputs(recipe.inputs, balances),
    );
  }

  private async waitForCraftedCharm(itemId: number): Promise<GearInstance | undefined> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const gear = await this.client.getGearInstances(this.agwAddress);
      const crafted = gear
        .filter((instance) => instance.GAME_ITEM_ID_CID === itemId && instance.DURABILITY_CID > 0)
        .sort((left, right) => right.DURABILITY_CID - left.DURABILITY_CID)[0];
      if (crafted) return crafted;
      if (attempt < 3) await sleep(350);
    }
    return undefined;
  }

  private async ensureEquipped(instance: GearInstance): Promise<boolean> {
    const definition = this.definitions.get(instance.GAME_ITEM_ID_CID)!;
    if (instance.EQUIPPED_TO_SLOT_CID !== CHARM_SLOT_TYPE) {
      try {
        await this.client.setGear(instance.docId, CHARM_SLOT_TYPE, CHARM_SLOT_INDEX);
      } catch (error) {
        this.log.warn({ gearInstanceId: instance.docId, err: error }, 'dungeon charm equip failed');
        this.skipOnce(`${definition.name} не удалось надеть: ${errorMessage(error)}`);
        return false;
      }
      this.onEvent?.({
        type: 'equipped',
        name: definition.name,
        durability: instance.DURABILITY_CID,
      });
      this.log.info({ gearInstanceId: instance.docId }, 'dungeon charm equipped');
    } else if (this.announcedReadyId !== instance.docId) {
      this.onEvent?.({
        type: 'ready',
        name: definition.name,
        durability: instance.DURABILITY_CID,
      });
    }
    this.announcedReadyId = instance.docId;
    this.lastSkipReason = undefined;
    return true;
  }

  private skipOnce(reason: string): void {
    if (reason === this.lastSkipReason) return;
    this.lastSkipReason = reason;
    this.onEvent?.({ type: 'skipped', reason });
  }
}

function parseCharmDefinitions(entries: GearItemCatalogEntry[]): Map<number, CharmDefinition> {
  const definitions = new Map<number, CharmDefinition>();
  for (const entry of entries) {
    if (entry.EQUIPPABLE_TO_CID !== CHARM_SLOT_TYPE) continue;
    const itemId = positiveInteger(entry.GAME_ITEM_ID_CID);
    if (itemId === undefined) continue;
    const repairIds = numberArray(entry.repairCost?.INPUT_ID_CID_array);
    const repairAmounts = numberArray(entry.repairCost?.INPUT_AMOUNT_CID_array);
    definitions.set(itemId, {
      itemId,
      name: entry.NAME_CID?.replace(/\s*\[GEAR\]\s*$/i, '') || `Амулет #${itemId}`,
      tier: positiveInteger(entry.TIER_CID) ?? 0,
      maxRepairs: positiveInteger(entry.REPAIR_COUNT_CID) ?? 0,
      repairInputs: repairIds.map((repairItemId, index) => ({
        itemId: repairItemId,
        amount: repairAmounts[index] ?? 1,
      })),
    });
  }
  return definitions;
}

function parseCharmRecipes(
  entries: OffchainRecipeEntry[],
  definitions: Map<number, CharmDefinition>,
): CharmRecipe[] {
  const recipes: CharmRecipe[] = [];
  for (const entry of entries) {
    const tags = Array.isArray(entry.TAG_CID_array) ? entry.TAG_CID_array : [];
    const filters = Array.isArray(entry.FILTERS_CID_array) ? entry.FILTERS_CID_array : [];
    if (!tags.includes('charm') && !filters.includes('Gear:Charm')) continue;
    if (typeof entry.docId !== 'string' || entry.docId.length === 0) continue;

    const lootIds = numberArray(entry.LOOT_ID_CID_array);
    const fulfillers = Array.isArray(entry.LOOT_FULFILLER_ID_CID_array)
      ? entry.LOOT_FULFILLER_ID_CID_array
      : [];
    const gearIndex = lootIds.findIndex(
      (itemId, index) =>
        definitions.has(itemId) &&
        (typeof fulfillers[index] !== 'string' || /gear/i.test(fulfillers[index]!)),
    );
    if (gearIndex < 0) continue;
    const outputItemId = lootIds[gearIndex]!;
    const inputIds = numberArray(entry.INPUT_ID_CID_array);
    const inputAmounts = numberArray(entry.INPUT_AMOUNT_CID_array);
    recipes.push({
      recipeId: entry.docId,
      name: entry.NAME_CID || definitions.get(outputItemId)?.name || `Амулет #${outputItemId}`,
      outputItemId,
      energy: positiveInteger(entry.ENERGY_CID) ?? 0,
      inputs: inputIds.map((itemId, index) => ({ itemId, amount: inputAmounts[index] ?? 1 })),
    });
  }
  return recipes.sort((left, right) => {
    const tierDelta =
      (definitions.get(right.outputItemId)?.tier ?? 0) -
      (definitions.get(left.outputItemId)?.tier ?? 0);
    if (tierDelta !== 0) return tierDelta;
    return left.recipeId.localeCompare(right.recipeId, 'en', { numeric: true });
  });
}

function balanceMap(entries: ItemBalanceEntity[]): Map<number, number> {
  const balances = new Map<number, number>();
  for (const entry of entries) {
    const itemId = positiveInteger(entry.ID_CID);
    if (itemId !== undefined && Number.isFinite(entry.BALANCE_CID)) {
      balances.set(itemId, Math.max(0, entry.BALANCE_CID));
    }
  }
  return balances;
}

function hasInputs(inputs: ItemAmount[], balances: Map<number, number>): boolean {
  return inputs.every((input) => (balances.get(input.itemId) ?? 0) >= input.amount);
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(positiveInteger).filter((entry): entry is number => entry !== undefined);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function repairCount(instance: GearInstance): number {
  return positiveInteger(instance.REPAIR_COUNT_CID) ?? 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
