import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import packJson from '../../../hub-pack.json';
import { HubPackSchema } from '../../src/hub/pack.js';
import { BadgeActionStore, blocksBadgeAction } from '../../src/badges/state.js';
import {
  assertRacingItemAccepted,
  buildRacingLobbySyncRequest,
  extractRacingActionProgress,
  findLiveRacingTarget,
  profileHasBadge,
  resolvePendingRacingAction,
  summarizeRacingInventory,
  verifyFlashCampaign,
  watchRacingItemApplication,
  type RacingGameClient,
} from '../../src/badges/gigling-racing.js';

const pack = HubPackSchema.parse(packJson);
const racing = pack.modules.gigaverse.racing;
let temporaryDir: string | undefined;

afterEach(async () => {
  if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true });
  temporaryDir = undefined;
});

describe('Gigling Racing badge', () => {
  it('counts every Dung and Butterfly variant and picks the cheapest held item', () => {
    const inventory = summarizeRacingInventory(
      [
        { ID_CID: 607, BALANCE_CID: 2 },
        { ID_CID: '603', BALANCE_CID: 1 },
        { ID_CID: 608, BALANCE_CID: 4 },
        { ID_CID: 21, BALANCE_CID: 100 },
      ],
      racing,
      new Map([
        [607, 9n],
        [603, 3n],
        [608, 6n],
      ]),
    );

    expect(inventory).toMatchObject({ dung: 6, butterfly: 1, total: 7 });
    expect(inventory.selected).toMatchObject({ itemId: 603, kind: 'Butterfly', count: 1 });
  });

  it('uses a generic Dung first when floor data is unavailable', () => {
    const inventory = summarizeRacingInventory(
      [
        { ID_CID: 608, BALANCE_CID: 5 },
        { ID_CID: 603, BALANCE_CID: 2 },
        { ID_CID: 607, BALANCE_CID: 1 },
      ],
      racing,
    );
    expect(inventory.selected?.itemId).toBe(607);
  });

  it('rechecks the selected live race and picks one of its pets', async () => {
    const syncRacingLobby = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        races: [
          { raceId: 40, phase: 1, entries: [{ petId: 1 }] },
          { raceId: 41, phase: 2, entries: [{ petId: 11 }, { petId: 12 }] },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        selectedRace: { raceId: 41, phase: 2, racePets: [11, 12] },
      });
    const client = {
      syncRacingLobby,
      useRacingItem: vi.fn(),
      tickRacingRace: vi.fn(),
    } as unknown as RacingGameClient;

    await expect(findLiveRacingTarget(client, racing, () => 0.99)).resolves.toEqual({
      raceId: 41,
      petId: 12,
    });
    expect(syncRacingLobby).toHaveBeenNthCalledWith(2, buildRacingLobbySyncRequest(41));
  });

  it('does not target a race that stopped resolving during the recheck', async () => {
    const client = {
      syncRacingLobby: vi
        .fn()
        .mockResolvedValueOnce({ races: [{ raceId: 41, phase: 2, entries: [{ petId: 11 }] }] })
        .mockResolvedValueOnce({ selectedRace: { raceId: 41, phase: 3, racePets: [11] } }),
      useRacingItem: vi.fn(),
      tickRacingRace: vi.fn(),
    } as unknown as RacingGameClient;
    await expect(findLiveRacingTarget(client, racing, () => 0)).resolves.toBeUndefined();
  });

  it('requires a positive server acknowledgement for item use', () => {
    expect(
      assertRacingItemAccepted({
        success: true,
        data: { currentTick: 91, scheduledItem: { atTick: 92, submittedAt: 1_785_607_841_435 } },
      }),
    ).toEqual({ currentTick: 91, scheduledTick: 92, submittedAt: 1_785_607_841_435 });
    expect(() => assertRacingItemAccepted({ success: false, error: 'Race is not live' })).toThrow(
      'Race is not live',
    );
    expect(() => assertRacingItemAccepted({})).toThrow('не подтвердил');
    expect(() => assertRacingItemAccepted({ success: true, data: { currentTick: 91 } })).toThrow(
      'очередь гонки',
    );
  });

  it('keeps ticking until the queued item is applied and the race finishes', async () => {
    const address = `0x${'a'.repeat(40)}`;
    const scheduledItem = {
      atTick: 1,
      itemId: 607,
      amount: 1,
      petId: 28_813,
      submittedAt: 1_785_607_841_435,
      submittedBy: address,
      appliedAt: null,
      refundedAt: null,
    };
    const tickRacingRace = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        data: {
          raceId: 29_399,
          phase: 2,
          lastResolvedTick: 0,
          finished: false,
          scheduledItems: [scheduledItem],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          raceId: 29_399,
          phase: 2,
          lastResolvedTick: 50,
          finished: false,
          scheduledItems: [{ ...scheduledItem, appliedAt: 1_785_607_868_025 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          raceId: 29_399,
          phase: 2,
          lastResolvedTick: 614,
          finished: true,
          scheduledItems: [{ ...scheduledItem, appliedAt: 1_785_607_868_025 }],
          raceResult: { completed: true },
        },
      });
    const client = {
      syncRacingLobby: vi.fn(),
      useRacingItem: vi.fn(),
      tickRacingRace,
    } as unknown as RacingGameClient;

    await expect(
      watchRacingItemApplication({
        client,
        raceId: 29_399,
        petId: 28_813,
        itemId: 607,
        address,
        submittedAt: 1_785_607_841_435,
        intervalMs: 0,
      }),
    ).resolves.toMatchObject({
      itemFound: true,
      appliedAt: 1_785_607_868_025,
      lastResolvedTick: 614,
      finished: true,
    });
    expect(tickRacingRace).toHaveBeenCalledTimes(3);

    expect(
      extractRacingActionProgress(
        {
          success: true,
          data: {
            raceId: 29_399,
            phase: 2,
            lastResolvedTick: 50,
            finished: false,
            scheduledItems: [{ ...scheduledItem, appliedAt: 1_785_607_868_025 }],
          },
        },
        { raceId: 29_399, petId: 28_813, itemId: 607, address, submittedAt: 1_785_607_841_435 },
      ),
    ).toMatchObject({ itemFound: true, appliedAt: 1_785_607_868_025 });
  });

  it('recovers the exact queued consumable after an ambiguous submit timeout', () => {
    const address = `0x${'a'.repeat(40)}`;
    expect(
      resolvePendingRacingAction(
        {
          success: true,
          data: {
            raceId: 77,
            currentTick: 12,
            finished: false,
            scheduledItems: [
              {
                atTick: 14,
                itemId: 607,
                petId: 9,
                submittedBy: address,
                submittedAt: 1_785_607_841_435,
              },
            ],
          },
        },
        {
          raceId: 77,
          petId: 9,
          itemId: 607,
          address,
          startedAt: 1_785_607_840_000,
        },
      ),
    ).toEqual({
      finished: false,
      submission: { currentTick: 12, scheduledTick: 14, submittedAt: 1_785_607_841_435 },
    });
  });

  it('does not confuse an older consumable with the pending badge action', () => {
    const address = `0x${'b'.repeat(40)}`;
    expect(
      resolvePendingRacingAction(
        {
          data: {
            raceId: 77,
            finished: true,
            scheduledItems: [
              {
                atTick: 4,
                itemId: 607,
                petId: 9,
                submittedBy: address,
                submittedAt: 1_785_600_000_000,
              },
            ],
          },
        },
        {
          raceId: 77,
          petId: 9,
          itemId: 607,
          address,
          startedAt: 1_785_607_840_000,
        },
      ),
    ).toEqual({ finished: true });
  });

  it('reads a claimed badge from the public Portal profile shape', () => {
    expect(
      profileHasBadge(
        {
          data: {
            user: {
              badges: [{ badge: { id: 58, name: 'Gigling Racing Badge' }, claimed: true }],
            },
          },
        },
        58,
      ),
    ).toBe(true);
    expect(profileHasBadge({ user: { badges: [{ badgeId: 58, claimed: false }] } }, 58)).toBe(
      false,
    );
  });

  it('rejects a stale flash campaign before spending an item', () => {
    const campaign = pack.modules.abstractBadges.flash;
    expect(() =>
      verifyFlashCampaign(
        campaign,
        {
          id: 59,
          type: 'flash',
          name: 'Next badge',
          description: '',
          requirement: '',
          url: 'https://example.com',
          timeStart: Date.now() - 1_000,
          timeEnd: Date.now() + 1_000,
        },
        Date.now(),
      ),
    ).toThrow('Portal уже сменил flash-бейдж');
  });

  it('rejects an expired flash campaign before spending an item', () => {
    const campaign = pack.modules.abstractBadges.flash;
    expect(() =>
      verifyFlashCampaign(
        campaign,
        {
          id: campaign.id,
          type: 'flash',
          name: campaign.name,
          description: '',
          requirement: '',
          url: 'https://example.com',
          timeStart: 1_000,
          timeEnd: 2_000,
        },
        2_000,
      ),
    ).toThrow('Кампания Gigling Racing завершена');
  });

  it('persists a preflight guard and blocks a second consumable spend', async () => {
    temporaryDir = await mkdtemp(join(tmpdir(), 'abstract-hub-badges-'));
    const store = new BadgeActionStore(join(temporaryDir, 'state.json'));
    const address = `0x${'a'.repeat(40)}`;
    const pending = store.begin({ badgeId: 58, address, raceId: 7, petId: 8, itemId: 607 });
    expect(blocksBadgeAction(pending)).toBe(true);
    expect(() => store.begin({ badgeId: 58, address, raceId: 9, petId: 10, itemId: 607 })).toThrow(
      'неопределённый результат',
    );

    const queued = store.markSubmitted(address, 58, {
      scheduledTick: 1,
      serverSubmittedAt: 1_785_607_841_435,
    });
    expect(queued.state).toBe('submitted');
    const completed = store.complete(address, 58, {
      appliedAt: 1_785_607_868_025,
      lastResolvedTick: 614,
    });
    expect(completed.state).toBe('completed');
    expect(completed.verifiedAt).toBeTruthy();
    const txHash = `0x${'c'.repeat(64)}`;
    const submitted = store.markClaimSubmitted(address, 58, txHash);
    expect(submitted.claimTxHash).toBe(txHash);
    expect(new BadgeActionStore(join(temporaryDir, 'state.json')).get(address, 58)).toMatchObject({
      state: 'completed',
      claimTxHash: txHash,
    });
  });

  it('allows retry after a definite rejected request', async () => {
    temporaryDir = await mkdtemp(join(tmpdir(), 'abstract-hub-badges-'));
    const store = new BadgeActionStore(join(temporaryDir, 'state.json'));
    const address = `0x${'b'.repeat(40)}`;
    store.begin({ badgeId: 58, address, raceId: 7, petId: 8, itemId: 607 });
    expect(store.fail(address, 58, 'Race ended').state).toBe('failed');
    expect(() =>
      store.begin({ badgeId: 58, address, raceId: 9, petId: 10, itemId: 607 }),
    ).not.toThrow();
  });

  it('allows a legacy queued-only completion to be performed again', async () => {
    temporaryDir = await mkdtemp(join(tmpdir(), 'abstract-hub-badges-'));
    const statePath = join(temporaryDir, 'state.json');
    const address = `0x${'c'.repeat(40)}`;
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        records: {
          [`58:${address}`]: {
            badgeId: 58,
            address,
            action: 'gigaverse_racing_item',
            state: 'completed',
            raceId: 7,
            petId: 8,
            itemId: 607,
            amount: 1,
            startedAt: '2026-08-01T12:00:00.000Z',
            completedAt: '2026-08-01T12:00:01.000Z',
          },
        },
      }),
    );
    const store = new BadgeActionStore(statePath);
    expect(blocksBadgeAction(store.get(address, 58))).toBe(false);
    expect(() =>
      store.begin({ badgeId: 58, address, raceId: 9, petId: 10, itemId: 607 }),
    ).not.toThrow();
  });
});
