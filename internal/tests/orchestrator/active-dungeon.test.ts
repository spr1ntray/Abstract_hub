/**
 * Regression tests for the stale-active-dungeon startup scenario.
 *
 * The bug: when the bot starts with an active run already in progress, the
 * orchestrator used to call flee() with lastActionToken='' (unset at startup).
 * The server rejected with HTTP 400 because the token did not match the
 * expected value embedded in the active run.
 *
 * The fix: getDungeonState() is used as the canonical source of truth.  When
 * it returns a non-null `run`, the orchestrator calls setLastActionToken() with
 * the token from the state response BEFORE calling flee(), so the outgoing
 * request echoes the correct replay-protection token.
 */

import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { pino } from 'pino';
import { GigaClient } from '../../src/api/client.js';
import type { Account } from '../../src/vault/schema.js';

const silentLog = pino({ level: 'silent' });

const stubAccount: Account = {
  name: 'test',
  privateKey: ('0x' + 'a'.repeat(64)) as `0x${string}`,
  proxy: { type: 'http', host: '127.0.0.1', port: 1 },
};

/** Minimal successful ActionResponse for flee / start_run. */
function actionReply(actionToken = 'next-tok'): object {
  return {
    success: true,
    actionToken,
    message: 'ok',
    data: {
      run: { players: [], lootPhase: false, lootOptions: [] },
      entity: { COMPLETE_CID: true, ROOM_NUM_CID: 3 },
      events: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Core regression: setLastActionToken → flee echoes the right token
// ---------------------------------------------------------------------------

describe('stale active dungeon — actionToken sync before flee', () => {
  it('flee sends the token learned from getDungeonState, not the empty startup default', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const STALE_TOKEN = '1779560436189';

    // Step 1: getDungeonState returns an active run with a specific actionToken
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/state', method: 'GET' })
      .reply(200, {
        success: true,
        run: { ROOM_NUM_CID: 3, COMPLETE_CID: false },
        actionToken: Number(STALE_TOKEN), // server sends as a numeric timestamp
      });

    // Step 2: flee must echo STALE_TOKEN (not empty string)
    let capturedFleeBody: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, (req: { body?: unknown }) => {
        capturedFleeBody = typeof req.body === 'string' ? req.body : undefined;
        return actionReply('post-flee-tok');
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt');

    // --- Simulate what the orchestrator now does ---

    const state = await c.getDungeonState();
    expect(state.run).not.toBeNull();
    expect(state.run).toBeDefined();

    // Normalise token (server sends numeric)
    const staleTok =
      typeof state.actionToken === 'number' ? String(state.actionToken) : (state.actionToken ?? '');

    // Orchestrator syncs token before flee
    c.setLastActionToken(staleTok);
    expect(c.getActionToken()).toBe(STALE_TOKEN);

    // Flee must echo the stale token
    await c.flee();
    expect(capturedFleeBody).toContain(`"actionToken":"${STALE_TOKEN}"`);
    expect(capturedFleeBody).toContain('"action":"flee"');

    await agent.close();
  }, 10_000);

  it('when getDungeonState returns no active run, setLastActionToken is not called and flee is skipped', async () => {
    // This test asserts the "no stale run" code path: when state.run is null,
    // we skip setLastActionToken + flee entirely.  Here we simply verify that
    // getDungeonState correctly surfaces a null run so the conditional works.
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/state', method: 'GET' })
      .reply(200, { success: true, run: null });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt');

    const state = await c.getDungeonState();

    // Orchestrator guard: if (!state.run) → skip flee
    expect(state.run).toBeNull();

    // Token stays at default empty — no setLastActionToken called
    expect(c.getActionToken()).toBe('');

    await agent.close();
  });

  it('string actionToken from getDungeonState is passed through without modification', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/state', method: 'GET' })
      .reply(200, {
        success: true,
        run: { ROOM_NUM_CID: 1, COMPLETE_CID: false },
        actionToken: '9876543210', // already a string
      });

    let capturedFleeBody: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, (req: { body?: unknown }) => {
        capturedFleeBody = typeof req.body === 'string' ? req.body : undefined;
        return actionReply('ok');
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt');

    const state = await c.getDungeonState();
    const staleTok =
      typeof state.actionToken === 'number' ? String(state.actionToken) : (state.actionToken ?? '');

    c.setLastActionToken(staleTok);
    await c.flee();

    expect(capturedFleeBody).toContain('"actionToken":"9876543210"');

    await agent.close();
  }, 10_000);
});
