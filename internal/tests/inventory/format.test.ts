import { describe, it, expect, vi } from 'vitest';
import {
  tallyItems,
  buildCatalog,
  buildGearConditionCatalog,
  extractAccountDisplayInfo,
  extractBalanceList,
  enrichCatalogWithMetadata,
  mergeCatalogs,
  parseGameItemMetadata,
  type GearInstance,
} from '../../src/inventory.js';

// ── buildCatalog ──────────────────────────────────────────────────────────────

describe('buildCatalog', () => {
  it('handles {ID, NAME} casing', () => {
    const raw = [
      { ID: 1, NAME: 'Iron Sword' },
      { ID: 2, NAME: 'Leather Cap' },
    ];
    const map = buildCatalog(raw);
    expect(map.get(1)?.name).toBe('Iron Sword');
    expect(map.get(2)?.name).toBe('Leather Cap');
  });

  it('handles lowercase {id, name}', () => {
    const raw = [{ id: 7, name: 'Fire Staff' }];
    const map = buildCatalog(raw);
    expect(map.get(7)?.name).toBe('Fire Staff');
  });

  it('returns empty map for non-array input', () => {
    expect(buildCatalog(null).size).toBe(0);
    expect(buildCatalog({ items: [] }).size).toBe(0);
    expect(buildCatalog(undefined).size).toBe(0);
  });

  it('unwraps {entities: [...]} wrapper', () => {
    const raw = { entities: [{ ID: 1, NAME: 'Sword' }] };
    expect(buildCatalog(raw).get(1)?.name).toBe('Sword');
  });

  it('handles real /api/indexer/gameitems shape with docId and NAME_CID', () => {
    const raw = {
      entities: [
        { docId: '2', tableName: 'GameItems', NAME_CID: 'Dungeon Scrap' },
        { docId: '21', tableName: 'GameItems', NAME_CID: 'Wood' },
      ],
    };
    const map = buildCatalog(raw);
    expect(map.get(2)?.name).toBe('Dungeon Scrap');
    expect(map.get(21)?.name).toBe('Wood');
  });

  it('handles real /api/gear/items shape with GAME_ITEM_ID_CID and NAME_CID', () => {
    const raw = { entities: [{ GAME_ITEM_ID_CID: 234, NAME_CID: 'Paper Hands [GEAR]' }] };
    expect(buildCatalog(raw).get(234)?.name).toBe('Paper Hands [GEAR]');
  });

  it('merges game and gear catalogs with gear names taking precedence', () => {
    const game = buildCatalog({ entities: [{ docId: '234', NAME_CID: 'Paper Hands' }] });
    const gear = buildCatalog({
      entities: [{ GAME_ITEM_ID_CID: 234, NAME_CID: 'Paper Hands [GEAR]' }],
    });
    expect(mergeCatalogs(game, gear).get(234)?.name).toBe('Paper Hands [GEAR]');
  });

  it('extracts image URLs (IMG_URL_CID)', () => {
    const raw = [{ ID: 1, NAME: 'Sword', IMG_URL_CID: 'https://cdn/sword.png' }];
    const entry = buildCatalog(raw).get(1);
    expect(entry?.image).toBe('https://cdn/sword.png');
  });

  it('skips entries with missing id or name', () => {
    const raw = [{ NAME: 'No ID' }, { ID: 5 }, { ID: 9, NAME: 'Valid' }];
    const map = buildCatalog(raw);
    expect(map.size).toBe(1);
    expect(map.get(9)?.name).toBe('Valid');
  });
});

describe('extractBalanceList', () => {
  it('normalizes /api/items/balances into inventory rows', () => {
    const rows = extractBalanceList({
      entities: [
        { ID_CID: '21', BALANCE_CID: 202, docId: 'PlayerGameItemBalance#abc-21' },
        { ID_CID: '25', BALANCE_CID: 0 },
      ],
    });
    expect(rows).toEqual([
      expect.objectContaining({
        gameItemId: 21,
        GAME_ITEM_ID_CID: 21,
        quantity: 202,
        docId: 'PlayerGameItemBalance#abc-21',
      }),
    ]);
  });
});

describe('extractAccountDisplayInfo', () => {
  it('uses primaryUsername and noob token from account profile', () => {
    const profile = {
      primaryUsername: 'player_one',
      accountEntity: { NOOB_TOKEN_CID: 12345 },
      noob: { docId: '12345' },
    };
    expect(
      extractAccountDisplayInfo(
        'acc1-a1b2c3',
        '0x1111111111111111111111111111111111111111',
        profile,
      ),
    ).toEqual({
      alias: 'acc1-a1b2c3',
      displayName: '@player_one',
      username: 'player_one',
      noobId: '12345',
    });
  });
});

// ── tallyItems ────────────────────────────────────────────────────────────────

describe('tallyItems', () => {
  const catalog = new Map<number, { name: string; image?: string }>([
    [1, { name: 'Iron Sword' }],
    [2, { name: 'Leather Cap' }],
    [3, { name: 'Healing Potion' }],
  ]);

  it('returns empty array when gear is empty', () => {
    expect(tallyItems([], catalog)).toEqual([]);
  });

  it('maps gameItemId to name via catalog', () => {
    const gear: GearInstance[] = [{ gameItemId: 1, quantity: 1, rarity: 'rare' }];
    const rows = tallyItems(gear, catalog);
    expect(rows[0]?.item).toBe('Iron Sword');
    expect(rows[0]?.rarity).toBe('rare');
  });

  it('uses item#<id> fallback when id not in catalog', () => {
    const gear: GearInstance[] = [{ gameItemId: 99, quantity: 1 }];
    const rows = tallyItems(gear, catalog);
    expect(rows[0]?.item).toBe('item#99');
  });

  it('aggregates duplicate gameItemId entries', () => {
    const gear: GearInstance[] = [
      { gameItemId: 3, quantity: 5 },
      { gameItemId: 3, quantity: 3 },
    ];
    const rows = tallyItems(gear, catalog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item).toBe('Healing Potion');
    expect(rows[0]?.qty).toBe(8);
  });

  it('marks equipped when any slot is equipped', () => {
    const gear: GearInstance[] = [
      { gameItemId: 1, quantity: 1, equipped: false },
      { gameItemId: 1, quantity: 1, equipped: true },
    ];
    const rows = tallyItems(gear, catalog);
    expect(rows[0]?.equipped).toBe(true);
  });

  it('handles isEquipped alias', () => {
    const gear: GearInstance[] = [{ gameItemId: 2, quantity: 1, isEquipped: true }];
    const rows = tallyItems(gear, catalog);
    expect(rows[0]?.equipped).toBe(true);
  });

  it('defaults qty to 1 when no quantity field present', () => {
    const gear: GearInstance[] = [{ gameItemId: 1 }];
    const rows = tallyItems(gear, catalog);
    expect(rows[0]?.qty).toBe(1);
  });

  it('handles qty and amount field aliases', () => {
    const gearQty: GearInstance[] = [{ gameItemId: 1, qty: 7 }];
    expect(tallyItems(gearQty, catalog)[0]?.qty).toBe(7);

    const gearAmt: GearInstance[] = [{ gameItemId: 1, amount: 4 }];
    expect(tallyItems(gearAmt, catalog)[0]?.qty).toBe(4);
  });

  it('sorts rows alphabetically by item name', () => {
    const gear: GearInstance[] = [
      { gameItemId: 3, quantity: 1 },
      { gameItemId: 1, quantity: 1 },
      { gameItemId: 2, quantity: 1 },
    ];
    const rows = tallyItems(gear, catalog);
    expect(rows.map((r) => r.item)).toEqual(['Healing Potion', 'Iron Sword', 'Leather Cap']);
  });

  it('skips entries missing gameItemId', () => {
    const gear = [{ quantity: 5 }] as unknown as GearInstance[];
    expect(tallyItems(gear, catalog)).toHaveLength(0);
  });

  it('accepts numeric-string IDs (gameItemId: "1")', () => {
    const gear = [{ gameItemId: '1' as unknown as number, quantity: 1 }] as GearInstance[];
    const rows = tallyItems(gear, catalog);
    expect(rows[0]?.item).toBe('Iron Sword');
  });

  it('tracks equippedQty separately from qty', () => {
    const gear: GearInstance[] = [
      { gameItemId: 1, quantity: 1, equipped: true },
      { gameItemId: 1, quantity: 1, equipped: false },
      { gameItemId: 1, quantity: 1, equipped: false },
    ];
    const rows = tallyItems(gear, catalog);
    expect(rows[0]?.qty).toBe(3);
    expect(rows[0]?.equippedQty).toBe(1);
    expect(rows[0]?.equipped).toBe(true);
  });

  it('dedupes by docId when same NFT is repeated', () => {
    const gear: GearInstance[] = [
      { gameItemId: 1, quantity: 1, docId: 'nft-abc' },
      { gameItemId: 1, quantity: 1, docId: 'nft-abc' },
    ];
    const rows = tallyItems(gear, catalog);
    expect(rows[0]?.qty).toBe(1);
  });

  it('marks unknown items and sorts them after known items', () => {
    const gear: GearInstance[] = [
      { gameItemId: 99, quantity: 1 },
      { gameItemId: 2, quantity: 1 },
      { gameItemId: 100, quantity: 1 },
    ];
    const rows = tallyItems(gear, catalog);
    expect(rows.map((r) => r.item)).toEqual(['Leather Cap', 'item#99', 'item#100']);
  });

  it('sorts unknown items numerically by id (item#9 before item#10)', () => {
    const gear: GearInstance[] = [
      { gameItemId: 10, quantity: 1 },
      { gameItemId: 9, quantity: 1 },
    ];
    const rows = tallyItems(gear, catalog);
    expect(rows.map((r) => r.gameItemId)).toEqual([9, 10]);
  });

  it('EQUIPPED_TO_SLOT_CID === 0 means unequipped', () => {
    const gear = [
      { gameItemId: 1, GAME_ITEM_ID_CID: 1, EQUIPPED_TO_SLOT_CID: 0 },
    ] as unknown as GearInstance[];
    const rows = tallyItems(gear, catalog);
    expect(rows[0]?.equipped).toBe(false);
    expect(rows[0]?.equippedQty).toBe(0);
  });

  it('reports per-instance durability, repairs and the weakest condition', () => {
    const conditions = buildGearConditionCatalog({
      entities: [{ GAME_ITEM_ID_CID: 1, DURABILITY_CID_array: [12, 14, 16, 18] }],
    });
    const gear = [
      {
        gameItemId: 1,
        quantity: 1,
        RARITY_CID: 0,
        DURABILITY_CID: 4,
        REPAIR_COUNT_CID: 1,
        EQUIPPED_TO_SLOT_CID: 2,
      },
      {
        gameItemId: 1,
        quantity: 1,
        RARITY_CID: 0,
        DURABILITY_CID: 12,
        REPAIR_COUNT_CID: 0,
        EQUIPPED_TO_SLOT_CID: 0,
      },
    ] as unknown as GearInstance[];

    expect(tallyItems(gear, catalog, conditions)[0]?.condition).toEqual({
      instances: [
        { durability: 4, maxDurability: 12, repairCount: 1, equipped: true },
        { durability: 12, maxDurability: 12, repairCount: 0, equipped: false },
      ],
      damagedCount: 1,
      brokenCount: 0,
      minimumPercent: 33,
    });
  });

  it('marks zero durability as broken', () => {
    const conditions = buildGearConditionCatalog({
      entities: [{ GAME_ITEM_ID_CID: 2, DURABILITY_CID_array: ['24'] }],
    });
    const gear = [
      { gameItemId: 2, DURABILITY_CID: 0, REPAIR_COUNT_CID: 1, RARITY_CID: 0 },
    ] as unknown as GearInstance[];
    expect(tallyItems(gear, catalog, conditions)[0]?.condition).toMatchObject({
      damagedCount: 1,
      brokenCount: 1,
      minimumPercent: 0,
    });
  });
});

describe('buildCatalog: image URL normalization', () => {
  it('rewrites bare IPFS CID to ipfs.io gateway', () => {
    const raw = [
      { ID: 1, NAME: 'X', IMG_URL_CID: 'QmTUSLCMq9YN57nqe9wkVKbqsbCJgVtV3CKtxiZA8sgvX5' },
    ];
    const entry = buildCatalog(raw).get(1);
    expect(entry?.image).toBe(
      'https://ipfs.io/ipfs/QmTUSLCMq9YN57nqe9wkVKbqsbCJgVtV3CKtxiZA8sgvX5',
    );
  });

  it('handles schema-relative URLs (//cdn)', () => {
    const raw = [{ ID: 1, NAME: 'X', IMG_URL_CID: '//cdn.example/x.png' }];
    expect(buildCatalog(raw).get(1)?.image).toBe('https://cdn.example/x.png');
  });

  it('handles ipfs:// prefix', () => {
    const raw = [{ ID: 1, NAME: 'X', IMG_URL_CID: 'ipfs://QmAbc' }];
    expect(buildCatalog(raw).get(1)?.image).toBe('https://ipfs.io/ipfs/QmAbc');
  });

  it('makes root-relative image paths point to gigaverse.io', () => {
    const raw = [{ ID: 1, NAME: 'X', IMG_URL_CID: '/images/x.png' }];
    expect(buildCatalog(raw).get(1)?.image).toBe('https://gigaverse.io/images/x.png');
  });
});

describe('game item metadata images', () => {
  it('prefers the square metadata icon over the card image', () => {
    expect(
      parseGameItemMetadata(
        {
          name: 'Dungeon Scrap',
          image: 'https://cdn.example/card.png',
          icon: 'https://cdn.example/icon.png',
        },
        'item#2',
      ),
    ).toEqual({ name: 'Dungeon Scrap', image: 'https://cdn.example/icon.png' });
  });

  it('enriches held items that have names but no catalog images', async () => {
    const getGameItemMetadata = vi.fn().mockResolvedValue({
      name: 'Metadata Wood',
      icon: 'https://cdn.example/wood.png',
    });
    const catalog = new Map([[90210, { name: 'Wood' }]]);
    const gear: GearInstance[] = [{ gameItemId: 90210, quantity: 4 }];

    const enriched = await enrichCatalogWithMetadata({ getGameItemMetadata }, gear, catalog);

    expect(getGameItemMetadata).toHaveBeenCalledWith(90210);
    expect(enriched.get(90210)).toEqual({
      name: 'Metadata Wood',
      image: 'https://cdn.example/wood.png',
    });
  });
});
