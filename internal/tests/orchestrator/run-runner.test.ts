import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import { runOne, resumeRun } from '../../src/orchestrator/run-runner.js';
import type { DungeonStateResponse } from '../../src/api/types.js';
import { HttpError } from '../../src/api/errors.js';
import type { ActionResponse } from '../../src/api/types.js';
import type { GigaClient } from '../../src/api/client.js';
import type { BuildPlan } from '../../src/loot/types.js';

const silentLog = pino({ level: 'silent' });

function mkResp(over: {
  complete?: boolean;
  room?: number;
  lastMove?: '' | 'rock' | 'scissor' | 'paper';
  lootPhase?: boolean;
  lootOptions?: { boonTypeString: string }[];
  meHp?: number;
  enemyId?: string;
}): ActionResponse {
  return {
    success: true,
    message: 'ok',
    actionToken: 't',
    data: {
      run: {
        players: [
          // me
          {
            rock: {
              startingATK: 5,
              startingDEF: 0,
              currentATK: 5,
              currentDEF: 0,
              currentCharges: 3,
              maxCharges: 3,
            },
            paper: {
              startingATK: 0,
              startingDEF: 0,
              currentATK: 0,
              currentDEF: 0,
              currentCharges: 3,
              maxCharges: 3,
            },
            scissor: {
              startingATK: 5,
              startingDEF: 0,
              currentATK: 5,
              currentDEF: 0,
              currentCharges: 3,
              maxCharges: 3,
            },
            health: { current: over.meHp ?? 10, starting: 10, currentMax: 10, startingMax: 10 },
            shield: { current: 0, starting: 0 },
            lastMove: over.lastMove ?? '',
            thisPlayerWin: false,
            otherPlayerWin: false,
            statusEffects: [],
            activeEffects: [],
          },
          // enemy
          {
            id: over.enemyId ?? 'Enemy Room 1',
            rock: {
              startingATK: 3,
              startingDEF: 0,
              currentATK: 3,
              currentDEF: 0,
              currentCharges: 3,
              maxCharges: 3,
            },
            paper: {
              startingATK: 0,
              startingDEF: 0,
              currentATK: 0,
              currentDEF: 0,
              currentCharges: 3,
              maxCharges: 3,
            },
            scissor: {
              startingATK: 3,
              startingDEF: 0,
              currentATK: 3,
              currentDEF: 0,
              currentCharges: 3,
              maxCharges: 3,
            },
            health: { current: 1, starting: 5, currentMax: 5, startingMax: 5 },
            shield: { current: 0, starting: 0 },
            lastMove: '',
            thisPlayerWin: false,
            otherPlayerWin: false,
            statusEffects: [],
            activeEffects: [],
          },
        ],
        lootPhase: over.lootPhase ?? false,
        lootOptions: (over.lootOptions ?? []).map((o, i) => ({
          docId: 'd' + i,
          RARITY_CID: 0,
          UINT256_CID: 0,
          selectedVal1: 1,
          selectedVal2: 0,
          boonTypeString: o.boonTypeString,
        })),
      },
      entity: {
        ROOM_NUM_CID: over.room ?? 1,
        ENEMY_CID: 0,
        COMPLETE_CID: over.complete ?? false,
        LEVEL_CID: 0,
        data: { gearInstances: [], roomInvaderItemsEarned: [] },
      },
      events: [],
    },
  };
}

const plan: BuildPlan = {
  priorities: { UpgradeRock_ATK: 100, AddMaxHealth: 50 },
  defaultScore: 10,
  rules: [],
};

describe('runOne', () => {
  it('plays start → 2 moves → complete', async () => {
    const client = {
      startRun: vi.fn().mockResolvedValueOnce(mkResp({ room: 1 })),
      move: vi
        .fn()
        .mockResolvedValueOnce(mkResp({ room: 1, lastMove: 'rock' }))
        .mockResolvedValueOnce(mkResp({ room: 2, complete: true })),
      pickLoot: vi.fn(),
    } as unknown as GigaClient;

    const summary = await runOne(client, 1, plan, silentLog);

    expect(summary.completed).toBe(true);
    expect(summary.died).toBe(false);
    expect(summary.rooms).toBe(2);
    expect(client.startRun as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(1);
    expect(client.move as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2);
    expect(client.pickLoot as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('picks loot when offered', async () => {
    const client = {
      startRun: vi.fn().mockResolvedValueOnce(mkResp({})),
      move: vi.fn(),
      pickLoot: vi.fn().mockResolvedValueOnce(mkResp({ complete: true, room: 2 })),
      lootThinking: vi.fn().mockResolvedValue(undefined),
    } as unknown as GigaClient;

    // Override startRun to return lootPhase
    (client.startRun as ReturnType<typeof vi.fn>).mockReset();
    (client.startRun as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResp({
        lootPhase: true,
        lootOptions: [{ boonTypeString: 'AddMaxHealth' }, { boonTypeString: 'UpgradeRock_ATK' }],
      }),
    );

    const summary = await runOne(client, 1, plan, silentLog);

    expect(client.pickLoot as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(2); // higher priority is UpgradeRock_ATK at index 2
    expect(summary.picks).toEqual(['UpgradeRock_ATK']);
    expect(summary.completed).toBe(true);
  });

  it('detects death', async () => {
    const client = {
      startRun: vi.fn().mockResolvedValueOnce(mkResp({ room: 1 })),
      move: vi.fn().mockResolvedValueOnce(mkResp({ room: 1, meHp: 0 })),
      pickLoot: vi.fn(),
    } as unknown as GigaClient;

    const summary = await runOne(client, 1, plan, silentLog);
    expect(summary.died).toBe(true);
    expect(summary.completed).toBe(false);
  });

  it('flees PvP opponent only when GIGABOT_FLEE_PVP=true (opt-in)', async () => {
    const prev = process.env.GIGABOT_FLEE_PVP;
    process.env.GIGABOT_FLEE_PVP = 'true';
    try {
      const playerAddr = '0x' + 'a'.repeat(40);
      const client = {
        startRun: vi.fn().mockResolvedValueOnce(mkResp({ room: 2, enemyId: playerAddr })),
        move: vi.fn(),
        flee: vi.fn().mockResolvedValueOnce(mkResp({ room: 2, enemyId: playerAddr })),
        pickLoot: vi.fn(),
      } as unknown as GigaClient;

      const summary = await runOne(client, 1, plan, silentLog);

      expect(summary.fled).toBe(true);
      expect(summary.died).toBe(false);
      expect(client.flee as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
      expect(client.move as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.GIGABOT_FLEE_PVP;
      else process.env.GIGABOT_FLEE_PVP = prev;
    }
  });

  it('does NOT flee when enemy.id is a monster name', async () => {
    const client = {
      startRun: vi.fn().mockResolvedValueOnce(mkResp({ room: 1, enemyId: 'Black Knight' })),
      move: vi.fn().mockResolvedValueOnce(mkResp({ room: 2, complete: true })),
      flee: vi.fn(),
      pickLoot: vi.fn(),
    } as unknown as GigaClient;

    const summary = await runOne(client, 1, plan, silentLog);

    expect(summary.fled).toBe(false);
    expect(summary.completed).toBe(true);
    expect(client.flee as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(client.move as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });
});

describe('resumeRun', () => {
  it('probes with move when stale state has no lootPhase, then continues to completion', async () => {
    const client = {
      setLastActionToken: vi.fn(),
      move: vi
        .fn()
        // probe action — server responds with current combat state
        .mockResolvedValueOnce(mkResp({ room: 3, lastMove: 'paper' }))
        // next combat step completes the run
        .mockResolvedValueOnce(mkResp({ room: 4, complete: true })),
      pickLoot: vi.fn(),
      flee: vi.fn(),
      lootThinking: vi.fn().mockResolvedValue(undefined),
    } as unknown as GigaClient;

    const state = {
      run: { ROOM_NUM_CID: 3 },
      actionToken: '12345',
    } as unknown as DungeonStateResponse;

    const summary = await resumeRun(client, 1, plan, silentLog, state);

    expect(summary.resumed).toBe(true);
    expect(summary.completed).toBe(true);
    expect(client.setLastActionToken as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('12345');
    // probe = move('paper'); then a subsequent move closes the run
    expect((client.move as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('paper');
    expect(client.flee as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('probes with pickLoot(1) when stale state shows lootPhase', async () => {
    const client = {
      setLastActionToken: vi.fn(),
      move: vi.fn(),
      pickLoot: vi
        .fn()
        // probe — picks loot at index 1
        .mockResolvedValueOnce(
          mkResp({
            room: 2,
            lootPhase: true,
            lootOptions: [{ boonTypeString: 'UpgradeRock_ATK' }],
          }),
        )
        // After the loot pick, next response is a fresh combat step (no lootPhase)
        .mockResolvedValueOnce(mkResp({ room: 2, complete: true })),
      flee: vi.fn(),
      lootThinking: vi.fn().mockResolvedValue(undefined),
    } as unknown as GigaClient;

    const state = {
      run: { ROOM_NUM_CID: 2, lootPhase: true },
      actionToken: '888',
    } as unknown as DungeonStateResponse;

    const summary = await resumeRun(client, 1, plan, silentLog, state);

    expect(summary.resumed).toBe(true);
    // First pickLoot is the probe; nothing else triggers it because next response is COMPLETE
    expect(client.pickLoot as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(1);
  });

  it('flips probe action when first probe returns HttpError', async () => {
    const client = {
      setLastActionToken: vi.fn(),
      // first probe (move) fails — server says "not in combat phase"
      move: vi.fn().mockRejectedValueOnce(new HttpError(500, { error: 'not in combat' })),
      // fallback probe via pickLoot succeeds
      pickLoot: vi.fn().mockResolvedValueOnce(mkResp({ room: 2, complete: true })),
      flee: vi.fn(),
      lootThinking: vi.fn().mockResolvedValue(undefined),
    } as unknown as GigaClient;

    const state = {
      run: { ROOM_NUM_CID: 2 }, // no lootPhase flag → probe with move first
      actionToken: '5',
    } as unknown as DungeonStateResponse;

    const summary = await resumeRun(client, 1, plan, silentLog, state);

    expect(summary.resumed).toBe(true);
    expect(summary.completed).toBe(true);
    expect(client.move as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect(client.pickLoot as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(1);
  });
});
