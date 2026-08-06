import type { Logger } from 'pino';
import type { GigaClient } from '../api/client.js';
import type { GearInstance, RecipeStartResponse } from '../api/types.js';
import { HttpError, NoEnergyError } from '../api/errors.js';
import { humanizeFromRange, sleep } from '../timing.js';
import { loadTimingConfig } from '../timing-config.js';

const tcfg = loadTimingConfig();

export const NODE_ENERGY_COST = 5;
const PAPER_HANDS_ITEM_ID = 234;
const ROCK_HANDS_ITEM_ID = 235;
const PAPER_HANDS_CRAFT_RECIPE_ID = 'Recipe#50234';
const PAPER_HANDS_CRAFT_NODE_INDEX = 0;

interface PotRecipe {
  recipeId: string;
  label: string;
  gloveItemId: number;
  gloveName: string;
  durabilityCost: number;
  nodeIndexes: number[];
  craftRecipeId?: string;
  craftInputs?: CraftInput[];
}

interface ChestRecipe {
  recipeId: string;
  label: string;
  nodeIndex: number;
  requiresJuice?: boolean;
}

interface CraftInput {
  itemId: number;
  amount: number;
}

interface ItemCatalog {
  gameItems: Map<number, string>;
  gearItems: Map<number, string>;
}

export interface GloveInventorySummary {
  total: number;
  usable: number;
  repairable: number;
  spent: number;
  samples: string[];
}

const POT_RECIPES: PotRecipe[] = [
  {
    recipeId: 'Recipe#700001',
    label: 'Blue Pot',
    gloveItemId: PAPER_HANDS_ITEM_ID,
    gloveName: 'Paper Hands',
    durabilityCost: 2,
    nodeIndexes: [0, 1, 2, 3],
    craftRecipeId: PAPER_HANDS_CRAFT_RECIPE_ID,
    craftInputs: [
      { itemId: 21, amount: 16 },
      { itemId: 4, amount: 4 },
      { itemId: 7, amount: 4 },
    ],
  },
  {
    recipeId: 'Recipe#700002',
    label: 'Tan Pot',
    gloveItemId: ROCK_HANDS_ITEM_ID,
    gloveName: 'Rock Hands',
    durabilityCost: 2,
    nodeIndexes: [0, 1],
  },
];

const CHEST_RECIPES: ChestRecipe[] = [
  { recipeId: 'Recipe#700000', label: 'Noob Chest', nodeIndex: 0 },
  { recipeId: 'Recipe#700003', label: 'Juiced Chest', nodeIndex: 0, requiresJuice: true },
];

export interface NodeReward {
  itemId: number;
  amount: number;
  name?: string;
  kind?: 'item' | 'gear';
}

export interface NodeRewardSummary {
  potsBroken: number;
  chestsClaimed: number;
  repairs: number;
  crafted: number;
  salvaged: number;
  skipped: number;
  noEnergy: boolean;
  rewards: NodeReward[];
}

export async function runNodeRewards(opts: {
  client: GigaClient;
  agwAddress: string;
  noobId: number;
  log: Logger;
  onEvent?: (event: NodeRewardEvent) => void;
}): Promise<NodeRewardSummary> {
  const { client, agwAddress, noobId, log, onEvent } = opts;
  let gear = await client.getGearInstances(agwAddress);
  const catalog = await loadItemCatalog(client, log);
  let balances: Map<number, number> | undefined;
  let balancesLoaded = false;
  let isPlayerJuiced: boolean | undefined;
  const rewards = new Map<string, NodeReward>();
  const summary: NodeRewardSummary = {
    potsBroken: 0,
    chestsClaimed: 0,
    repairs: 0,
    crafted: 0,
    salvaged: 0,
    skipped: 0,
    noEnergy: false,
    rewards: [],
  };

  onEvent?.({
    type: 'begin',
    paperHands: summarizeGloves(gear, PAPER_HANDS_ITEM_ID, 2),
    rockHands: summarizeGloves(gear, ROCK_HANDS_ITEM_ID, 2),
  });

  for (const recipe of POT_RECIPES) {
    for (const nodeIndex of recipe.nodeIndexes) {
      const energy = await client.getEnergy(agwAddress);
      isPlayerJuiced = energy.isPlayerJuiced;
      if (energy.energyValue < NODE_ENERGY_COST) {
        summary.noEnergy = true;
        onEvent?.({ type: 'no-energy', remaining: energy.energyValue });
        log.info(
          { remaining: energy.energyValue, needed: NODE_ENERGY_COST, recipeId: recipe.recipeId },
          'node rewards: not enough energy for more pots',
        );
        break;
      }

      let glove = pickUsableGlove(gear, recipe);
      if (!glove) {
        const repaired = await repairOneGlove(client, gear, recipe, log);
        if (repaired) {
          summary.repairs++;
          onEvent?.({
            type: 'repair',
            gloveName: recipe.gloveName,
            gearInstanceId: repaired.docId,
          });
          glove = repaired;
          await jitter();
        }
      }

      let craftSkipReason: string | undefined;
      if (!glove) {
        const salvaged = await salvageSpentGloves(client, gear, recipe, log, onEvent);
        summary.salvaged += salvaged;
        if (salvaged > 0) await jitter();
      }

      if (!glove && recipe.craftRecipeId) {
        const missingInput = await getMissingCraftInput();
        if (missingInput) {
          craftSkipReason = formatMissingCraftInput(missingInput, catalog);
          log.info(
            {
              recipeId: recipe.craftRecipeId,
              missingItemId: missingInput.itemId,
              need: missingInput.need,
              have: missingInput.have,
            },
            'node rewards: glove craft skipped by local balance check',
          );
        } else {
          await jitter();
          try {
            const response = await client.startRecipe({
              recipeId: recipe.craftRecipeId,
              noobId,
              gearInstanceId: '',
              nodeIndex: PAPER_HANDS_CRAFT_NODE_INDEX,
              quantity: 1,
            });
            summary.crafted++;
            addRewards(rewards, response, catalog);
            onEvent?.({
              type: 'craft',
              label: recipe.gloveName,
              rewards: extractRewards(response, catalog),
            });
            log.info({ recipeId: recipe.craftRecipeId }, 'node rewards: glove crafted');
            gear = await client.getGearInstances(agwAddress);
            glove = pickUsableGlove(gear, recipe);
          } catch (e) {
            if (isSkippableNodeError(e) || e instanceof NoEnergyError) {
              craftSkipReason = errorSummary(e, catalog);
              log.info(
                { recipeId: recipe.craftRecipeId, err: e },
                'node rewards: glove craft skipped',
              );
            } else {
              throw e;
            }
          }
        }

        async function getMissingCraftInput(): Promise<
          { itemId: number; need: number; have: number } | undefined
        > {
          if (!recipe.craftInputs) return undefined;
          if (!balancesLoaded) {
            balancesLoaded = true;
            balances = await loadItemBalances(client, log);
          }
          return balances ? findMissingCraftInput(recipe.craftInputs, balances) : undefined;
        }
      }

      if (!glove) {
        summary.skipped++;
        const gloveSummary = summarizeGloves(gear, recipe.gloveItemId, recipe.durabilityCost);
        const reason = craftSkipReason
          ? `${missingGloveReason(recipe, gloveSummary)}; крафт: ${craftSkipReason}`
          : missingGloveReason(recipe, gloveSummary);
        onEvent?.({ type: 'skip', label: recipe.label, reason });
        log.info(
          { recipeId: recipe.recipeId, nodeIndex, gloveItemId: recipe.gloveItemId, gloveSummary },
          'node rewards: no usable glove',
        );
        break;
      }

      await jitter();
      try {
        const response = await client.startRecipe({
          recipeId: recipe.recipeId,
          noobId,
          gearInstanceId: glove.docId,
          nodeIndex,
          quantity: 1,
        });
        glove.DURABILITY_CID = Math.max(0, glove.DURABILITY_CID - recipe.durabilityCost);
        summary.potsBroken++;
        addRewards(rewards, response, catalog);
        onEvent?.({
          type: 'pot',
          label: recipe.label,
          nodeIndex,
          rewards: extractRewards(response, catalog),
        });
        log.info(
          { recipeId: recipe.recipeId, nodeIndex, gearInstanceId: glove.docId },
          'node rewards: pot broken',
        );
      } catch (e) {
        if (e instanceof NoEnergyError) {
          summary.noEnergy = true;
          onEvent?.({ type: 'no-energy', remaining: 0 });
          log.info({ recipeId: recipe.recipeId, nodeIndex }, 'node rewards: energy drained');
          break;
        }
        if (isSkippableNodeError(e)) {
          summary.skipped++;
          const reason = errorSummary(e, catalog);
          onEvent?.({ type: 'skip', label: recipe.label, reason });
          log.info({ recipeId: recipe.recipeId, nodeIndex, err: e }, 'node rewards: pot skipped');
          continue;
        }
        throw e;
      }
    }

    if (summary.noEnergy) break;
  }

  for (const recipe of POT_RECIPES) {
    const salvaged = await salvageSpentGloves(client, gear, recipe, log, onEvent);
    summary.salvaged += salvaged;
    if (salvaged > 0) await jitter();
  }

  for (const chest of CHEST_RECIPES) {
    if (chest.requiresJuice) {
      if (isPlayerJuiced === undefined) {
        try {
          const energy = await client.getEnergy(agwAddress);
          isPlayerJuiced = energy.isPlayerJuiced;
        } catch (e) {
          log.warn({ recipeId: chest.recipeId, err: e }, 'node rewards: juice status unavailable');
        }
      }
      if (isPlayerJuiced === false) {
        summary.skipped++;
        const reason = 'аккаунт не juiced';
        onEvent?.({ type: 'skip', label: chest.label, reason });
        log.info({ recipeId: chest.recipeId }, 'node rewards: juiced chest skipped');
        continue;
      }
    }

    await jitter();
    try {
      const response = await client.startRecipe({
        recipeId: chest.recipeId,
        noobId,
        gearInstanceId: '',
        nodeIndex: chest.nodeIndex,
        quantity: 1,
      });
      summary.chestsClaimed++;
      addRewards(rewards, response, catalog);
      onEvent?.({ type: 'chest', label: chest.label, rewards: extractRewards(response, catalog) });
      log.info({ recipeId: chest.recipeId }, 'node rewards: chest claimed');
    } catch (e) {
      if (isSkippableNodeError(e) || e instanceof NoEnergyError) {
        summary.skipped++;
        const reason = errorSummary(e, catalog);
        onEvent?.({ type: 'skip', label: chest.label, reason });
        log.info({ recipeId: chest.recipeId, err: e }, 'node rewards: chest skipped');
        continue;
      }
      throw e;
    }
  }

  summary.rewards = [...rewards.values()];
  onEvent?.({ type: 'done', summary });
  return summary;
}

export type NodeRewardEvent =
  | { type: 'begin'; paperHands: GloveInventorySummary; rockHands: GloveInventorySummary }
  | { type: 'repair'; gloveName: string; gearInstanceId: string }
  | { type: 'craft'; label: string; rewards: NodeReward[] }
  | { type: 'salvage'; gloveName: string; gearInstanceId: string }
  | { type: 'pot'; label: string; nodeIndex: number; rewards: NodeReward[] }
  | { type: 'chest'; label: string; rewards: NodeReward[] }
  | { type: 'skip'; label: string; reason: string }
  | { type: 'no-energy'; remaining: number }
  | { type: 'done'; summary: NodeRewardSummary };

function pickUsableGlove(gear: GearInstance[], recipe: PotRecipe): GearInstance | undefined {
  return gear
    .filter(
      (g) => g.GAME_ITEM_ID_CID === recipe.gloveItemId && g.DURABILITY_CID >= recipe.durabilityCost,
    )
    .sort((a, b) => a.DURABILITY_CID - b.DURABILITY_CID)[0];
}

async function salvageSpentGloves(
  client: GigaClient,
  gear: GearInstance[],
  recipe: PotRecipe,
  log: Logger,
  onEvent?: (event: NodeRewardEvent) => void,
): Promise<number> {
  const candidates = gear.filter(
    (g) =>
      g.GAME_ITEM_ID_CID === recipe.gloveItemId &&
      g.DURABILITY_CID < recipe.durabilityCost &&
      repairCount(g) >= 1,
  );
  let salvaged = 0;

  for (const candidate of candidates) {
    try {
      await client.salvageGear(candidate.docId);
      const idx = gear.findIndex((g) => g.docId === candidate.docId);
      if (idx >= 0) gear.splice(idx, 1);
      salvaged++;
      onEvent?.({
        type: 'salvage',
        gloveName: recipe.gloveName,
        gearInstanceId: candidate.docId,
      });
      log.info({ gearInstanceId: candidate.docId }, 'node rewards: glove salvaged');
    } catch (e) {
      if (isSkippableNodeError(e)) {
        log.info({ gearInstanceId: candidate.docId, err: e }, 'node rewards: salvage skipped');
        continue;
      }
      throw e;
    }
  }

  return salvaged;
}

async function repairOneGlove(
  client: GigaClient,
  gear: GearInstance[],
  recipe: PotRecipe,
  log: Logger,
): Promise<GearInstance | undefined> {
  const candidate = gear
    .filter(
      (g) =>
        g.GAME_ITEM_ID_CID === recipe.gloveItemId &&
        g.DURABILITY_CID < recipe.durabilityCost &&
        repairCount(g) < 1,
    )
    .sort((a, b) => a.DURABILITY_CID - b.DURABILITY_CID)[0];
  if (!candidate) return undefined;

  try {
    const repaired = await client.repairGear(candidate.docId);
    const updated = repaired.entities?.find((g) => g.docId === candidate.docId);
    if (!updated) return undefined;
    const idx = gear.findIndex((g) => g.docId === updated.docId);
    if (idx >= 0) gear[idx] = updated;
    else gear.push(updated);
    log.info(
      { gearInstanceId: updated.docId, durability: updated.DURABILITY_CID },
      'node rewards: glove repaired',
    );
    return updated.DURABILITY_CID >= recipe.durabilityCost ? updated : undefined;
  } catch (e) {
    if (isSkippableNodeError(e)) {
      log.info({ gearInstanceId: candidate.docId, err: e }, 'node rewards: glove repair skipped');
      return undefined;
    }
    throw e;
  }
}

function repairCount(g: GearInstance): number {
  return typeof g.REPAIR_COUNT_CID === 'number' ? g.REPAIR_COUNT_CID : 0;
}

function summarizeGloves(
  gear: GearInstance[],
  itemId: number,
  durabilityCost: number,
): GloveInventorySummary {
  const gloves = gear.filter((g) => g.GAME_ITEM_ID_CID === itemId);
  return {
    total: gloves.length,
    usable: gloves.filter((g) => g.DURABILITY_CID >= durabilityCost).length,
    repairable: gloves.filter((g) => g.DURABILITY_CID < durabilityCost && repairCount(g) < 1)
      .length,
    spent: gloves.filter((g) => g.DURABILITY_CID < durabilityCost && repairCount(g) >= 1).length,
    samples: gloves.slice(0, 4).map((g) => `${g.DURABILITY_CID}/r${repairCount(g)}`),
  };
}

function missingGloveReason(recipe: PotRecipe, summary: GloveInventorySummary): string {
  if (summary.total === 0) return `нет ${recipe.gloveName}`;
  return `нет usable ${recipe.gloveName} (всего ${summary.total}, usable ${summary.usable}, repairable ${summary.repairable}, spent ${summary.spent})`;
}

function addRewards(
  rewards: Map<string, NodeReward>,
  response: RecipeStartResponse,
  catalog: ItemCatalog,
): void {
  for (const r of extractRewards(response, catalog)) {
    const key = `${r.kind ?? 'item'}:${r.itemId}`;
    const current = rewards.get(key);
    if (current) current.amount += r.amount;
    else rewards.set(key, { ...r });
  }
}

function extractRewards(response: RecipeStartResponse, catalog: ItemCatalog): NodeReward[] {
  const out: NodeReward[] = [];
  for (const entity of response.entities ?? []) {
    const ids = entity.LOOT_ID_CID_array ?? [];
    const amounts = entity.LOOT_AMOUNT_CID_array ?? [];
    const fulfillers = entity.LOOT_FULFILLER_ID_CID_array ?? [];
    for (let i = 0; i < ids.length; i++) {
      const itemId = ids[i];
      if (typeof itemId !== 'number') continue;
      const amount = typeof amounts[i] === 'number' ? amounts[i]! : 1;
      const fulfiller = fulfillers[i];
      const kind =
        (typeof fulfiller === 'string' && /gear/i.test(fulfiller)) ||
        (!fulfiller && catalog.gearItems.has(itemId) && !catalog.gameItems.has(itemId))
          ? 'gear'
          : 'item';
      out.push({ itemId, amount, kind, name: itemName(catalog, itemId, kind) });
    }
  }
  return out;
}

async function loadItemCatalog(client: GigaClient, log: Logger): Promise<ItemCatalog> {
  const catalog: ItemCatalog = {
    gameItems: new Map([
      [2, 'Dungeon Scrap'],
      [4, 'Bolt'],
      [7, 'Ethereal Thread'],
      [21, 'Wood'],
      [25, 'Stone'],
      [185, 'Workbench XP'],
    ]),
    gearItems: new Map([
      [PAPER_HANDS_ITEM_ID, 'Paper Hands [GEAR]'],
      [ROCK_HANDS_ITEM_ID, 'Rock Hands [GEAR]'],
    ]),
  };

  try {
    const gameItems = await client.getGameItemsCatalog();
    for (const item of gameItems) {
      const id = parseItemId(item.GAME_ITEM_ID_CID ?? item.ID_CID ?? item.docId);
      if (id !== undefined && typeof item.NAME_CID === 'string' && item.NAME_CID.length > 0) {
        catalog.gameItems.set(id, item.NAME_CID);
      }
    }
  } catch (e) {
    log.warn({ err: e }, 'node rewards: game item catalog unavailable');
  }

  try {
    const gearItems = await client.getGearItemsCatalog();
    for (const item of gearItems) {
      const id = parseItemId(item.GAME_ITEM_ID_CID);
      if (id !== undefined && typeof item.NAME_CID === 'string' && item.NAME_CID.length > 0) {
        catalog.gearItems.set(id, item.NAME_CID);
      }
    }
  } catch (e) {
    log.warn({ err: e }, 'node rewards: gear item catalog unavailable');
  }

  return catalog;
}

async function loadItemBalances(
  client: GigaClient,
  log: Logger,
): Promise<Map<number, number> | undefined> {
  try {
    const balances = await client.getItemBalances();
    const out = new Map<number, number>();
    for (const balance of balances) {
      const id = parseItemId(balance.ID_CID);
      if (id !== undefined && typeof balance.BALANCE_CID === 'number') {
        out.set(id, balance.BALANCE_CID);
      }
    }
    return out;
  } catch (e) {
    log.warn({ err: e }, 'node rewards: item balances unavailable before craft');
    return undefined;
  }
}

function findMissingCraftInput(
  inputs: CraftInput[],
  balances: Map<number, number>,
): { itemId: number; need: number; have: number } | undefined {
  for (const input of inputs) {
    const have = balances.get(input.itemId) ?? 0;
    if (have < input.amount) return { itemId: input.itemId, need: input.amount, have };
  }
  return undefined;
}

function formatMissingCraftInput(
  missing: { itemId: number; need: number; have: number },
  catalog: ItemCatalog,
): string {
  return `не хватает ${itemName(catalog, missing.itemId, 'item')} (нужно ${missing.need}, есть ${missing.have})`;
}

function itemName(catalog: ItemCatalog, itemId: number, kind: 'item' | 'gear'): string {
  const direct = kind === 'gear' ? catalog.gearItems.get(itemId) : catalog.gameItems.get(itemId);
  return (
    direct ?? catalog.gameItems.get(itemId) ?? catalog.gearItems.get(itemId) ?? `item#${itemId}`
  );
}

function parseItemId(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

function isSkippableNodeError(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  if (e.status >= 400 && e.status < 500) return true;
  if (e.status >= 500 && /player is not juiced/i.test(httpErrorText(e))) return true;
  return false;
}

function errorSummary(e: unknown, catalog: ItemCatalog): string {
  if (e instanceof NoEnergyError) return 'не хватает энергии';
  if (e instanceof HttpError) {
    const msg = httpErrorText(e);
    if (msg.length > 0) return withItemNames(msg, catalog);
    return `HTTP ${e.status}`;
  }
  return e instanceof Error ? withItemNames(e.message, catalog) : String(e);
}

function httpErrorText(e: HttpError): string {
  const body = e.body;
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    const msg = obj['message'] ?? obj['error'];
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return e.message;
}

function withItemNames(message: string, catalog: ItemCatalog): string {
  return message.replace(/\bitem\s+(\d+)\b/gi, (match, idRaw: string) => {
    const id = Number(idRaw);
    const name = itemName(catalog, id, 'item');
    return name === `item#${id}` ? match : name;
  });
}

async function jitter(): Promise<void> {
  await sleep(humanizeFromRange(tcfg.action));
}
