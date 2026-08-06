import { describe, it, expect, vi } from 'vitest';
import {
  extractAccountSummaryFields,
  formatLoginSummary,
  checkAccountReadiness,
  PreflightError,
  safelyAbandonRun,
  runHealthCheck,
  extractActiveRun,
} from '../../src/orchestrator/preflight.js';
import type {
  GameAccount,
  DungeonStateResponse,
  DungeonTodayResponse,
  EnergyState,
} from '../../src/api/types.js';
import type { GigaClient } from '../../src/api/client.js';
import type { BuildPlan } from '../../src/loot/types.js';
import { pino } from 'pino';

const silentLog = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// extractAccountSummaryFields
// ---------------------------------------------------------------------------

describe('extractAccountSummaryFields', () => {
  it('extracts all fields from a complete gameAccount', () => {
    const ga: GameAccount = {
      username: 'player_one',
      canEnterGame: true,
      hasAcceptedLegal: true,
      noob: { _id: '75769', LEVEL_CID: 1 },
    };
    const fields = extractAccountSummaryFields(ga, 1_800_000_000_000);
    expect(fields.username).toBe('player_one');
    expect(fields.canEnterGame).toBe(true);
    expect(fields.hasAcceptedLegal).toBe(true);
    expect(fields.noobId).toBe('75769');
    expect(fields.noobLevel).toBe(1);
    expect(fields.expiresAt).toBe(1_800_000_000_000);
  });

  it('returns undefined for all optional fields when gameAccount is empty', () => {
    const fields = extractAccountSummaryFields({}, 0);
    expect(fields.username).toBeUndefined();
    expect(fields.canEnterGame).toBeUndefined();
    expect(fields.hasAcceptedLegal).toBeUndefined();
    expect(fields.noobId).toBeUndefined();
    expect(fields.noobLevel).toBeUndefined();
  });

  it('returns noobId=undefined when noob is null', () => {
    const ga: GameAccount = { noob: null };
    const fields = extractAccountSummaryFields(ga, 0);
    expect(fields.noobId).toBeUndefined();
  });

  it('returns noobLevel=undefined when LEVEL_CID is missing from noob', () => {
    const ga: GameAccount = { noob: { _id: '42' } };
    const fields = extractAccountSummaryFields(ga, 0);
    expect(fields.noobId).toBe('42');
    expect(fields.noobLevel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatLoginSummary
// ---------------------------------------------------------------------------

describe('formatLoginSummary', () => {
  it('formats a complete summary correctly', () => {
    const summary = formatLoginSummary({
      username: 'player_one',
      canEnterGame: true,
      hasAcceptedLegal: true,
      noobId: '75769',
      noobLevel: 1,
      // 2026-05-26 19:22 UTC
      expiresAt: new Date('2026-05-26T19:22:00.000Z').getTime(),
    });
    expect(summary).toContain('username=player_one');
    expect(summary).toContain('canEnterGame=true');
    expect(summary).toContain('hasAcceptedLegal=true');
    expect(summary).toContain('noob=#75769 (LEVEL_CID=1)');
    expect(summary).toContain('expiresAt=2026-05-26 19:22 UTC');
  });

  it('shows (not minted) when noobId is undefined', () => {
    const summary = formatLoginSummary({
      username: 'acc1',
      canEnterGame: false,
      hasAcceptedLegal: false,
      noobId: undefined,
      noobLevel: undefined,
      expiresAt: 0,
    });
    expect(summary).toContain('noob=(not minted)');
  });

  it('uses ? for unknown username', () => {
    const summary = formatLoginSummary({
      username: undefined,
      canEnterGame: undefined,
      hasAcceptedLegal: undefined,
      noobId: '1',
      noobLevel: undefined,
      expiresAt: 0,
    });
    expect(summary).toContain('username=?');
  });

  it('omits LEVEL_CID when noobLevel is undefined', () => {
    const summary = formatLoginSummary({
      username: 'x',
      canEnterGame: true,
      hasAcceptedLegal: true,
      noobId: '99',
      noobLevel: undefined,
      expiresAt: 0,
    });
    expect(summary).toContain('noob=#99');
    expect(summary).not.toContain('LEVEL_CID');
  });
});

// ---------------------------------------------------------------------------
// checkAccountReadiness
// ---------------------------------------------------------------------------

describe('checkAccountReadiness', () => {
  it('does not throw when canEnterGame=true and noob is present', () => {
    const ga: GameAccount = {
      username: 'ok',
      canEnterGame: true,
      hasAcceptedLegal: true,
      noob: { _id: '1' },
    };
    expect(() => checkAccountReadiness(ga, 0, 'ok', silentLog)).not.toThrow();
  });

  it('throws PreflightError when canEnterGame is false', () => {
    const ga: GameAccount = {
      username: 'locked',
      canEnterGame: false,
      hasAcceptedLegal: false,
      noob: { _id: '1' },
    };
    expect(() => checkAccountReadiness(ga, 0, 'locked', silentLog)).toThrow(PreflightError);
  });

  it('throws PreflightError when noob is null (not minted)', () => {
    const ga: GameAccount = {
      username: 'nomint',
      canEnterGame: true,
      hasAcceptedLegal: true,
      noob: null,
    };
    expect(() => checkAccountReadiness(ga, 0, 'nomint', silentLog)).toThrow(PreflightError);
  });

  it('throws PreflightError when noob is absent', () => {
    const ga: GameAccount = { username: 'x', canEnterGame: true, hasAcceptedLegal: true };
    expect(() => checkAccountReadiness(ga, 0, 'x', silentLog)).toThrow(PreflightError);
  });

  it('PreflightError message includes actionable hint', () => {
    const ga: GameAccount = { username: 'x', canEnterGame: false, noob: null };
    let err: PreflightError | undefined;
    try {
      checkAccountReadiness(ga, 0, 'x', silentLog);
    } catch (e) {
      if (e instanceof PreflightError) err = e;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('gigaverse.io');
    expect(err!.message).toContain('mint a noob NFT');
  });

  it('does NOT throw when canEnterGame is undefined (absent from response)', () => {
    // Older API versions may omit the field — we should not penalize that
    const ga: GameAccount = { username: 'x', noob: { _id: '5' } };
    expect(() => checkAccountReadiness(ga, 0, 'x', silentLog)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// safelyAbandonRun
// ---------------------------------------------------------------------------

const plan: BuildPlan = {
  priorities: { UpgradeRock_ATK: 100, UpgradeScissor_ATK: 90, default: 10 },
  defaultScore: 10,
  rules: [],
};

describe('safelyAbandonRun', () => {
  it('flees immediately when there is no lootPhase', async () => {
    const client = {
      setLastActionToken: vi.fn(),
      pickLoot: vi.fn(),
      flee: vi.fn().mockResolvedValue({ actionToken: '999' }),
    } as unknown as GigaClient;

    const state = {
      run: { ROOM_NUM_CID: 7, actionToken: '123' },
      actionToken: '123',
    } as DungeonStateResponse;

    const result = await safelyAbandonRun(client, state, plan, silentLog);
    expect(result.ok).toBe(true);
    expect(result.salvagedBoons).toEqual([]);
    expect(client.pickLoot as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(client.flee as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect(client.setLastActionToken as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('123');
  });

  it('picks waiting loot before fleeing — does not lose unused items', async () => {
    const pickResponse = {
      actionToken: '5',
      data: { run: { lootPhase: false, lootOptions: [] } },
    };
    const client = {
      setLastActionToken: vi.fn(),
      pickLoot: vi.fn().mockResolvedValue(pickResponse),
      flee: vi.fn().mockResolvedValue({ actionToken: '6' }),
    } as unknown as GigaClient;

    const state = {
      run: {
        ROOM_NUM_CID: 5,
        lootPhase: true,
        lootOptions: [{ boonTypeString: 'AddMaxHealth' }, { boonTypeString: 'UpgradeRock_ATK' }],
      },
      actionToken: '42',
    } as unknown as DungeonStateResponse;

    const result = await safelyAbandonRun(client, state, plan, silentLog);
    expect(result.ok).toBe(true);
    expect(result.salvagedBoons).toEqual(['UpgradeRock_ATK']);
    expect(client.pickLoot as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(2);
    expect(client.flee as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });

  it('reports ok=false when flee throws', async () => {
    const client = {
      setLastActionToken: vi.fn(),
      pickLoot: vi.fn(),
      flee: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as GigaClient;

    const result = await safelyAbandonRun(
      client,
      { run: { ROOM_NUM_CID: 2 }, actionToken: '1' },
      plan,
      silentLog,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
  });

  it('handles lootPhase nested under data.run', async () => {
    const client = {
      setLastActionToken: vi.fn(),
      pickLoot: vi.fn().mockResolvedValue({ actionToken: '2', data: { run: {} } }),
      flee: vi.fn().mockResolvedValue({ actionToken: '3' }),
    } as unknown as GigaClient;

    const state = {
      run: {
        ROOM_NUM_CID: 3,
        data: {
          run: {
            lootPhase: true,
            lootOptions: [{ boonTypeString: 'UpgradeRock_ATK' }],
          },
        },
      },
      actionToken: 0,
    } as unknown as DungeonStateResponse;

    const result = await safelyAbandonRun(client, state, plan, silentLog);
    expect(result.salvagedBoons).toEqual(['UpgradeRock_ATK']);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runHealthCheck
// ---------------------------------------------------------------------------

function mkClient(opts: {
  energy?: Partial<EnergyState>;
  energyThrows?: boolean;
  state?: DungeonStateResponse;
  stateThrows?: boolean;
  today?: DungeonTodayResponse;
  todayThrows?: boolean;
}): GigaClient {
  return {
    setLastActionToken: vi.fn(),
    pickLoot: vi.fn(),
    flee: vi.fn().mockResolvedValue({}),
    getEnergy: opts.energyThrows
      ? vi.fn().mockRejectedValue(new Error('net down'))
      : vi.fn().mockResolvedValue({
          energyValue: 240,
          maxEnergy: 240,
          regenPerSecond: 0,
          regenPerHour: 0,
          secondsSinceLastUpdate: 0,
          isPlayerJuiced: false,
          ...opts.energy,
        } as EnergyState),
    getDungeonState: opts.stateThrows
      ? vi.fn().mockRejectedValue(new Error('boom'))
      : vi.fn().mockResolvedValue(opts.state ?? {}),
    getDungeonToday: opts.todayThrows
      ? vi.fn().mockRejectedValue(new Error('boom'))
      : vi.fn().mockResolvedValue(opts.today ?? { dungeons: [{ dungeonId: 1, name: 'D5000' }] }),
  } as unknown as GigaClient;
}

const validGameAccount: GameAccount = {
  username: 'tester',
  canEnterGame: true,
  hasAcceptedLegal: true,
  noob: { _id: '42', LEVEL_CID: 5 },
};

describe('runHealthCheck', () => {
  it('all-clear: ready=true and canRunDungeon=true with no warnings', async () => {
    const result = await runHealthCheck({
      client: mkClient({}),
      agwAddress: '0xabc',
      dungeonId: 1,
      gameAccount: validGameAccount,
      expiresAt: Date.now() + 1000 * 60 * 60 * 48, // +48h
      accountName: 'ok',
      log: silentLog,
    });
    expect(result.ready).toBe(true);
    expect(result.canRunDungeon).toBe(true);
    expect(result.steps.find((s) => s.label === 'Аккаунт')?.status).toBe('ok');
    expect(result.steps.find((s) => s.label === 'Сессия')?.status).toBe('ok');
    expect(result.steps.find((s) => s.label === 'Энергия')?.status).toBe('ok');
    expect(result.steps.find((s) => s.label === 'Активный ран')?.status).toBe('ok');
    expect(result.steps.find((s) => s.label === 'Данж сегодня')?.status).toBe('ok');
  });

  it('warns but keeps account ready when energy is below one run', async () => {
    const result = await runHealthCheck({
      client: mkClient({ energy: { energyValue: 10, maxEnergy: 240 } }),
      agwAddress: '0xabc',
      dungeonId: 1,
      gameAccount: validGameAccount,
      expiresAt: Date.now() + 1000 * 60 * 60 * 48,
      accountName: 'low',
      log: silentLog,
    });
    expect(result.ready).toBe(true);
    expect(result.canRunDungeon).toBe(false);
    expect(result.steps.find((s) => s.label === 'Энергия')?.status).toBe('warn');
  });

  it('keeps account ready but blocks fresh dungeon runs when dungeon is not in today list', async () => {
    const result = await runHealthCheck({
      client: mkClient({
        today: { dungeons: [{ _id: 'd3', dungeonId: 3, name: 'Underhaul' }] },
      }),
      agwAddress: '0xabc',
      dungeonId: 1,
      gameAccount: validGameAccount,
      expiresAt: Date.now() + 1000 * 60 * 60 * 48,
      accountName: 'wrongd',
      log: silentLog,
    });
    expect(result.ready).toBe(true);
    expect(result.canRunDungeon).toBe(false);
    expect(result.steps.find((s) => s.label === 'Данж сегодня')?.status).toBe('fail');
  });

  it('reports stale run as warn and forwards staleRun for the caller to resume', async () => {
    const staleState = {
      run: { ROOM_NUM_CID: 5 },
      actionToken: '777',
    } as unknown as DungeonStateResponse;
    const client = mkClient({ state: staleState });
    const result = await runHealthCheck({
      client,
      agwAddress: '0xabc',
      dungeonId: 1,
      gameAccount: validGameAccount,
      expiresAt: Date.now() + 1000 * 60 * 60 * 48,
      accountName: 'stale',
      log: silentLog,
    });
    const step = result.steps.find((s) => s.label === 'Активный ран');
    expect(step?.status).toBe('warn');
    expect(step?.detail).toContain('этаж 2');
    // health-check no longer flees — that's the caller's job via resumeRun
    expect(client.flee as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(result.staleRun).toBe(staleState);
    expect(result.ready).toBe(true);
    expect(result.canRunDungeon).toBe(true);
  });

  it('fails when noob NFT is not minted', async () => {
    const result = await runHealthCheck({
      client: mkClient({}),
      agwAddress: '0xabc',
      dungeonId: 1,
      gameAccount: { canEnterGame: true, noob: null },
      expiresAt: Date.now() + 1000 * 60 * 60 * 48,
      accountName: 'nomint',
      log: silentLog,
    });
    expect(result.ready).toBe(false);
    expect(result.canRunDungeon).toBe(false);
    expect(result.steps.find((s) => s.label === 'Аккаунт')?.status).toBe('fail');
  });

  it('fails when the game session is expired', async () => {
    const result = await runHealthCheck({
      client: mkClient({}),
      agwAddress: '0xabc',
      dungeonId: 1,
      gameAccount: validGameAccount,
      expiresAt: Date.now() - 1000, // already expired
      accountName: 'exp',
      log: silentLog,
    });
    expect(result.ready).toBe(false);
    expect(result.canRunDungeon).toBe(false);
    expect(result.steps.find((s) => s.label === 'Сессия')?.status).toBe('fail');
  });

  it('warns but does not fail when stale-run check fails', async () => {
    const result = await runHealthCheck({
      client: mkClient({ stateThrows: true }),
      agwAddress: '0xabc',
      dungeonId: 1,
      gameAccount: validGameAccount,
      expiresAt: Date.now() + 1000 * 60 * 60 * 48,
      accountName: 'flaky',
      log: silentLog,
    });
    // Health check stays ready=true — start_run will surface real issues
    expect(result.ready).toBe(true);
    expect(result.canRunDungeon).toBe(true);
    expect(result.steps.find((s) => s.label === 'Активный ран')?.status).toBe('warn');
  });

  it('detects stale run hidden under entities[0] (shape drift seen 2026-05-31)', async () => {
    const client = mkClient({
      state: {
        entities: [{ ROOM_NUM_CID: 7 }],
        actionToken: '1780232186835',
      } as unknown as DungeonStateResponse,
    });
    const result = await runHealthCheck({
      client,
      agwAddress: '0xabc',
      dungeonId: 1,
      gameAccount: validGameAccount,
      expiresAt: Date.now() + 1000 * 60 * 60 * 48,
      accountName: 'hidden',
      log: silentLog,
    });
    expect(result.steps.find((s) => s.label === 'Активный ран')?.status).toBe('warn');
    expect(result.staleRun).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// extractActiveRun — defends against shape drift in /api/game/dungeon/state
// ---------------------------------------------------------------------------

describe('extractActiveRun', () => {
  it('returns state.run when present', () => {
    const r = extractActiveRun({ run: { ROOM_NUM_CID: 3 } } as unknown as DungeonStateResponse);
    expect((r as { ROOM_NUM_CID?: number } | undefined)?.ROOM_NUM_CID).toBe(3);
  });

  it('falls back to state.entity', () => {
    const r = extractActiveRun({
      entity: { ROOM_NUM_CID: 5 },
    } as unknown as DungeonStateResponse);
    expect((r as { ROOM_NUM_CID?: number } | undefined)?.ROOM_NUM_CID).toBe(5);
  });

  it('falls back to state.entities[0]', () => {
    const r = extractActiveRun({
      entities: [{ ROOM_NUM_CID: 9 }],
    } as unknown as DungeonStateResponse);
    expect((r as { ROOM_NUM_CID?: number } | undefined)?.ROOM_NUM_CID).toBe(9);
  });

  it('falls back to state.data.run', () => {
    const r = extractActiveRun({
      data: { run: { ROOM_NUM_CID: 12 } },
    } as unknown as DungeonStateResponse);
    expect((r as { ROOM_NUM_CID?: number } | undefined)?.ROOM_NUM_CID).toBe(12);
  });

  it('returns undefined for empty / null state', () => {
    expect(extractActiveRun({} as DungeonStateResponse)).toBeUndefined();
    expect(extractActiveRun({ entities: [] } as unknown as DungeonStateResponse)).toBeUndefined();
    expect(extractActiveRun(null as unknown as DungeonStateResponse)).toBeUndefined();
  });

  it('prefers run over entity/entities (no double-counting)', () => {
    const r = extractActiveRun({
      run: { ROOM_NUM_CID: 1 },
      entity: { ROOM_NUM_CID: 99 },
      entities: [{ ROOM_NUM_CID: 99 }],
    } as unknown as DungeonStateResponse);
    expect((r as { ROOM_NUM_CID?: number } | undefined)?.ROOM_NUM_CID).toBe(1);
  });
});
