import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { pino } from 'pino';
import { GigaClient } from '../../src/api/client.js';
import { NoEnergyError, SessionExpiredError, HttpError } from '../../src/api/errors.js';
import type { Account } from '../../src/vault/schema.js';
import type { EnergyState } from '../../src/api/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ReqLike = {
  headers?: Headers | Record<string, string>;
  body?: unknown;
};

function extractHeader(req: ReqLike, name: string): string | undefined {
  const h = req.headers;
  if (!h) return undefined;
  if (typeof (h as Headers).get === 'function') {
    return (h as Headers).get(name) ?? undefined;
  }
  const rec = h as Record<string, string>;
  return rec[name] ?? rec[name.toLowerCase()];
}

/** Minimal ActionResponse fixture — enough for the client to parse. */
function actionReply(actionToken = 'tok-default'): object {
  return {
    success: true,
    actionToken,
    message: 'ok',
    data: {
      run: { players: [], lootPhase: false, lootOptions: [] },
      entity: { COMPLETE_CID: false, ROOM_NUM_CID: 1 },
      events: [],
    },
  };
}

const stubAccount: Account = {
  name: 'test',
  privateKey: ('0x' + 'a'.repeat(64)) as `0x${string}`,
  proxy: { type: 'http', host: '127.0.0.1', port: 1 },
};
const silentLog = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Core HTTP behaviour
// ---------------------------------------------------------------------------

describe('GigaClient — core HTTP', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
  });

  afterEach(async () => {
    await agent.close();
  });

  it('returns parsed body on 200', async () => {
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/test', method: 'POST' })
      .reply(200, { ok: true });
    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    await expect(c.post('/api/test', {})).resolves.toEqual({ ok: true });
  });

  it('throws NoEnergyError on 400 with energy message', async () => {
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/test', method: 'POST' })
      .reply(400, { message: 'no_energy' });
    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    await expect(c.post('/api/test', {})).rejects.toBeInstanceOf(NoEnergyError);
  });

  it('throws SessionExpiredError on 401', async () => {
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/test', method: 'POST' })
      .reply(401, {});
    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    await expect(c.post('/api/test', {})).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('throws SessionExpiredError on 403', async () => {
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/test', method: 'POST' })
      .reply(403, {});
    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    await expect(c.post('/api/test', {})).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('retries 5xx and eventually succeeds', async () => {
    const pool = agent.get('https://gigaverse.io');
    pool.intercept({ path: '/api/test', method: 'POST' }).reply(500, {});
    pool.intercept({ path: '/api/test', method: 'POST' }).reply(200, { ok: 2 });
    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    await expect(c.post('/api/test', {})).resolves.toEqual({ ok: 2 });
  }, 10_000);

  it('does NOT retry 4xx', async () => {
    let calls = 0;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/test', method: 'POST' })
      .reply(404, () => {
        calls++;
        return { message: 'not found' };
      })
      .times(5);
    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    await expect(c.post('/api/test', {})).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bearer JWT auth
// ---------------------------------------------------------------------------

describe('GigaClient — Bearer JWT auth', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
  });

  afterEach(async () => {
    await agent.close();
  });

  it('throws SessionExpiredError when authed call made before setJwt', async () => {
    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    await expect(c.post('/api/test', {}, { authed: true })).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it('sends Authorization: Bearer <jwt> header after setJwt', async () => {
    let capturedAuth: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/me', method: 'GET' })
      .reply(200, (req: ReqLike) => {
        capturedAuth = extractHeader(req, 'authorization');
        return { addr: 'ok' };
      });
    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('eyJhbGciOiJIUzI1NiJ9.testpayload.sig');
    await c.get('/api/me', { authed: true });
    expect(capturedAuth).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.testpayload.sig');
  });

  it('does NOT send a cookie header', async () => {
    let capturedCookie: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/me', method: 'GET' })
      .reply(200, (req: ReqLike) => {
        capturedCookie = extractHeader(req, 'cookie');
        return { addr: 'ok' };
      });
    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('any.jwt.here');
    await c.get('/api/me', { authed: true });
    expect(capturedCookie).toBeUndefined();
  });

  it('setJwt can update the JWT mid-flight (second call uses new token)', async () => {
    let secondAuth: string | undefined;
    const pool = agent.get('https://gigaverse.io');
    pool.intercept({ path: '/api/me', method: 'GET' }).reply(200, { addr: 'ok' });
    pool.intercept({ path: '/api/me', method: 'GET' }).reply(200, (req: ReqLike) => {
      secondAuth = extractHeader(req, 'authorization');
      return { addr: 'ok' };
    });
    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('first-jwt');
    await c.get('/api/me', { authed: true });
    c.setJwt('updated-jwt');
    await c.get('/api/me', { authed: true });
    expect(secondAuth).toBe('Bearer updated-jwt');
  });
});

describe('GigaClient — Racing', () => {
  it('never retries use-item after an ambiguous server failure', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    let calls = 0;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/racing/race/77/use-item', method: 'POST' })
      .reply(500, () => {
        calls++;
        return { success: false, error: 'temporary failure' };
      });
    const client = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    client.setJwt('racing-jwt');

    await expect(
      client.useRacingItem(77, { petId: 12, itemId: 607, amount: 1 }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
    await agent.close();
  });

  it('ticks a live race with the authenticated empty POST used by the UI', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/racing/race/77/tick', method: 'POST' })
      .reply(200, { success: true, data: { raceId: 77, finished: false } });
    const client = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    client.setJwt('racing-jwt');

    await expect(client.tickRacingRace(77)).resolves.toMatchObject({ success: true });
    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// actionToken threading
// ---------------------------------------------------------------------------

describe('GigaClient — actionToken threading', () => {
  it('start_run sends empty actionToken; second action echoes server token', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const bodies: string[] = [];
    const pool = agent.get('https://gigaverse.io');

    // First call: start_run → server returns actionToken "1234"
    pool
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        bodies.push(typeof req.body === 'string' ? req.body : '');
        return actionReply('1234');
      });

    // Second call: move → must echo "1234"
    pool
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        bodies.push(typeof req.body === 'string' ? req.body : '');
        return actionReply('5678');
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt.tok');

    await c.startRun(1);
    // After startRun, lastActionToken should be "1234"
    expect(c.getActionToken()).toBe('1234');

    await c.move('rock');

    // start_run body must have actionToken: ""
    expect(bodies[0]).toContain('"actionToken":""');
    // move body must echo "1234"
    expect(bodies[1]).toContain('"actionToken":"1234"');

    await agent.close();
  }, 10_000);

  it('pickLoot threads the last actionToken', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get('https://gigaverse.io');
    pool
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, actionReply('abc'));
    let lootBody: string | undefined;
    pool
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        lootBody = typeof req.body === 'string' ? req.body : undefined;
        return actionReply('def');
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt.tok');

    await c.startRun(3);
    await c.pickLoot(2);

    expect(lootBody).toContain('"actionToken":"abc"');
    expect(lootBody).toContain('"action":"loot_two"');

    await agent.close();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// getEnergy
// ---------------------------------------------------------------------------

describe('GigaClient — getEnergy', () => {
  it('parses the energy entity shape correctly', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const energyPayload: EnergyState = {
      energyValue: 120,
      maxEnergy: 200,
      regenPerSecond: 1,
      regenPerHour: 3600,
      secondsSinceLastUpdate: 5,
      isPlayerJuiced: false,
    };

    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/offchain/player/energy/0xDEAD', method: 'GET' })
      .reply(200, {
        entities: [{ parsedData: energyPayload }],
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt.tok');

    const result = await c.getEnergy('0xDEAD');
    expect(result).toEqual(energyPayload);

    await agent.close();
  });

  it('throws when entities array is empty', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/offchain/player/energy/0xDEAD', method: 'GET' })
      .reply(200, { entities: [] });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt.tok');

    await expect(c.getEnergy('0xDEAD')).rejects.toThrow('energy: empty entities response');

    await agent.close();
  });

  it('sends authed request (Bearer header present)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedAuth: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/offchain/player/energy/0xABCD', method: 'GET' })
      .reply(200, (req: ReqLike) => {
        capturedAuth = extractHeader(req, 'authorization');
        return {
          entities: [
            {
              parsedData: {
                energyValue: 40,
                maxEnergy: 200,
                regenPerSecond: 1,
                regenPerHour: 3600,
                secondsSinceLastUpdate: 0,
                isPlayerJuiced: false,
              },
            },
          ],
        };
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('energy-test-jwt');
    await c.getEnergy('0xABCD');

    expect(capturedAuth).toBe('Bearer energy-test-jwt');

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// Gear / recipes
// ---------------------------------------------------------------------------

describe('GigaClient — gear and recipes', () => {
  it('fetches game item and gear catalogs for display names', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get('https://gigaverse.io');
    pool.intercept({ path: '/api/indexer/gameitems', method: 'GET' }).reply(200, {
      entities: [{ docId: '21', NAME_CID: 'Wood' }],
    });
    pool.intercept({ path: '/api/gear/items', method: 'GET' }).reply(200, {
      entities: [{ GAME_ITEM_ID_CID: 234, NAME_CID: 'Paper Hands [GEAR]' }],
    });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });

    await expect(c.getGameItemsCatalog()).resolves.toEqual([{ docId: '21', NAME_CID: 'Wood' }]);
    await expect(c.getGearItemsCatalog()).resolves.toEqual([
      { GAME_ITEM_ID_CID: 234, NAME_CID: 'Paper Hands [GEAR]' },
    ]);

    await agent.close();
  });

  it('fetches public game item metadata with image fields', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get('https://gigaverse.io');
    pool.intercept({ path: '/api/metadata/gameItem/2', method: 'GET' }).reply(200, {
      name: 'Dungeon Scrap',
      image: 'https://cdn.example/card.png',
      icon: 'https://cdn.example/icon.png',
    });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });

    await expect(c.getGameItemMetadata(2)).resolves.toEqual({
      name: 'Dungeon Scrap',
      image: 'https://cdn.example/card.png',
      icon: 'https://cdn.example/icon.png',
    });

    await agent.close();
  });

  it('fetches authenticated item balances before crafting', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedAuth: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/items/balances', method: 'GET' })
      .reply(200, (req: ReqLike) => {
        capturedAuth = extractHeader(req, 'authorization');
        return { entities: [{ ID_CID: '21', BALANCE_CID: 2 }] };
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('balance-jwt');

    await expect(c.getItemBalances()).resolves.toEqual([{ ID_CID: '21', BALANCE_CID: 2 }]);
    expect(capturedAuth).toBe('Bearer balance-jwt');

    await agent.close();
  });

  it('fetches authenticated offchain recipes for workbench automation', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedAuth: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/offchain/static', method: 'GET' })
      .reply(200, (req: ReqLike) => {
        capturedAuth = extractHeader(req, 'authorization');
        return {
          recipes: [{ docId: 'Recipe#50215', NAME_CID: 'Hexchain Necklace' }],
        };
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('static-jwt');

    await expect(c.getOffchainStatic()).resolves.toEqual({
      recipes: [{ docId: 'Recipe#50215', NAME_CID: 'Hexchain Necklace' }],
    });
    expect(capturedAuth).toBe('Bearer static-jwt');

    await agent.close();
  });

  it('startRecipe POSTs the exact offchain recipe payload', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedBody: string | undefined;
    let capturedAuth: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/offchain/recipes/start', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        capturedBody = typeof req.body === 'string' ? req.body : undefined;
        capturedAuth = extractHeader(req, 'authorization');
        return { entities: [] };
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('recipe-jwt');
    await c.startRecipe({
      recipeId: 'Recipe#50234',
      noobId: 75769,
      gearInstanceId: '',
      nodeIndex: 0,
      quantity: 1,
    });

    expect(capturedAuth).toBe('Bearer recipe-jwt');
    expect(JSON.parse(capturedBody ?? '{}')).toEqual({
      recipeId: 'Recipe#50234',
      noobId: 75769,
      gearInstanceId: '',
      nodeIndex: 0,
      quantity: 1,
    });

    await agent.close();
  });

  it('salvageGear POSTs the gear instance id', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedBody: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/gear/salvage', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        capturedBody = typeof req.body === 'string' ? req.body : undefined;
        return { entities: [] };
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('gear-jwt');
    await c.salvageGear('GearInstance#234_1778960003_370611e0');

    expect(JSON.parse(capturedBody ?? '{}')).toEqual({
      gearInstanceId: 'GearInstance#234_1778960003_370611e0',
    });

    await agent.close();
  });

  it('setGear POSTs the exact charm slot tuple used by the game', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedBody: string | undefined;
    let capturedAuth: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/gear/set', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        capturedBody = typeof req.body === 'string' ? req.body : undefined;
        capturedAuth = extractHeader(req, 'authorization');
        return { entities: [] };
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('gear-jwt');
    await c.setGear('GearInstance#215_1786213763_16b58a10', 6, 0);

    expect(capturedAuth).toBe('Bearer gear-jwt');
    expect(JSON.parse(capturedBody ?? '{}')).toEqual({
      gearInstanceId: 'GearInstance#215_1786213763_16b58a10',
      slotType: 6,
      slotIndex: 0,
    });

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// action() helper — startRun sends correct dungeonId
// ---------------------------------------------------------------------------

describe('GigaClient — action helpers', () => {
  it('startRun POSTs to /api/game/dungeon/action with correct dungeonId and empty actionToken', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedBody: string | undefined;
    let capturedAuth: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        capturedBody = typeof req.body === 'string' ? req.body : undefined;
        capturedAuth = extractHeader(req, 'authorization');
        return actionReply('t');
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('session=xyz');
    await c.startRun(1);

    expect(capturedAuth).toBe('Bearer session=xyz');
    expect(capturedBody).toContain('"action":"start_run"');
    expect(capturedBody).toContain('"dungeonId":1');
    expect(capturedBody).toContain('"actionToken":""');

    await agent.close();
  }, 10_000);

  it.each([
    ['read ECONNRESET', 'ECONNRESET'],
    ['HTTP/2: "stream timeout after 20000"', 'UND_ERR_INFO'],
    [
      'Connect Timeout Error (attempted address: 192.0.2.10:7492, timeout: 10000ms)',
      'UND_ERR_CONNECT_TIMEOUT',
    ],
    ['read EADDRNOTAVAIL', 'EADDRNOTAVAIL'],
  ])(
    'retries a dungeon action after transient transport error: %s',
    async (message, code) => {
      const agent = new MockAgent();
      agent.disableNetConnect();

      const pool = agent.get('https://gigaverse.io');
      pool
        .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
        .replyWithError(Object.assign(new Error(message), { code }));
      pool
        .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
        .reply(200, actionReply('recovered-token'));

      const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
      c.setJwt('test.jwt');

      await expect(c.startRun(1)).resolves.toMatchObject({ actionToken: 'recovered-token' });
      expect(c.getActionToken()).toBe('recovered-token');

      await agent.close();
    },
    10_000,
  );

  it('does not retry a permanent 4xx dungeon action error', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    let calls = 0;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(400, () => {
        calls++;
        return { message: 'invalid action' };
      })
      .times(3);

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt');

    await expect(c.startRun(1)).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);

    await agent.close();
  }, 10_000);

  it('flee POSTs action="flee" and resets actionToken to empty', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    let firstBody: string | undefined;
    let secondBody: string | undefined;
    const pool = agent.get('https://gigaverse.io');
    pool
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        firstBody = typeof req.body === 'string' ? req.body : undefined;
        return actionReply('TOKEN-FROM-FLEE');
      });
    pool
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        secondBody = typeof req.body === 'string' ? req.body : undefined;
        return actionReply('next');
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('jwt-x');
    await c.flee();
    await c.startRun(1);

    expect(firstBody).toContain('"action":"flee"');
    // After flee, next start_run must reset to empty actionToken (NOT echo "TOKEN-FROM-FLEE")
    expect(secondBody).toContain('"action":"start_run"');
    expect(secondBody).toContain('"actionToken":""');

    await agent.close();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// getDungeonState
// ---------------------------------------------------------------------------

describe('GigaClient — getDungeonState', () => {
  it('returns parsed state when run is active', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const activeRun = { ROOM_NUM_CID: 3, COMPLETE_CID: false };
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/state', method: 'GET' })
      .reply(200, { success: true, run: activeRun });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt');
    const state = await c.getDungeonState();

    expect(state.success).toBe(true);
    expect(state.run).toEqual(activeRun);

    await agent.close();
  });

  it('returns empty object (not throws) when request fails', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/state', method: 'GET' })
      .reply(500, { message: 'server error' });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt');
    // Should NOT throw — diagnostics are best-effort
    const state = await c.getDungeonState();
    expect(state).toEqual({});

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// getDungeonToday
// ---------------------------------------------------------------------------

describe('GigaClient — getDungeonToday', () => {
  it('returns parsed dungeons list', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const dungeons = [
      { _id: 'abc', dungeonId: 1, name: 'Dungeon 5000', juicedMaxRunsPerDay: 10, maxRoom: 20 },
      { _id: 'def', dungeonId: 3, name: 'Underhaul', juicedMaxRunsPerDay: 5, maxRoom: 10 },
    ];
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/today', method: 'GET' })
      .reply(200, { success: true, dungeons });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt');
    const today = await c.getDungeonToday();

    expect(today.success).toBe(true);
    expect(today.dungeons).toHaveLength(2);
    expect(today.dungeons?.[0]?.dungeonId).toBe(1);

    await agent.close();
  });

  it('returns empty object (not throws) when request fails', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/today', method: 'GET' })
      .reply(401, {});

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt');
    // Should NOT throw even on 4xx (diagnostics are best-effort)
    // Note: 401 triggers SessionExpiredError inside send(), which getDungeonToday catches
    const today = await c.getDungeonToday();
    expect(today).toEqual({});

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// setLastActionToken
// ---------------------------------------------------------------------------

describe('GigaClient — setLastActionToken', () => {
  it('updates lastActionToken so subsequent action calls echo the new value', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedBody: string | undefined;
    agent
      .get('https://gigaverse.io')
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        capturedBody = typeof req.body === 'string' ? req.body : undefined;
        return actionReply('next-tok');
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt');

    // Explicitly set a token as if we learned it from getDungeonState
    c.setLastActionToken('1779560436189');
    expect(c.getActionToken()).toBe('1779560436189');

    // The flee action must echo this externally-set token
    await c.flee();
    expect(capturedBody).toContain('"actionToken":"1779560436189"');

    await agent.close();
  }, 10_000);

  it('getActionToken returns the value set by setLastActionToken', () => {
    const c = new GigaClient(stubAccount, silentLog);
    expect(c.getActionToken()).toBe('');
    c.setLastActionToken('abc123');
    expect(c.getActionToken()).toBe('abc123');
  });
});

// ---------------------------------------------------------------------------
// Auto-correct actionToken from 500 server hint
// ---------------------------------------------------------------------------

describe('GigaClient — auto-extract actionToken from 500 hint', () => {
  it('updates lastActionToken and retries when 500 body contains "!= <token>"', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get('https://gigaverse.io');
    const bodies: string[] = [];

    // First attempt: server rejects with "Invalid action token  != 1779560436189"
    pool
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(500, { error: 'Invalid action token  != 1779560436189' });

    // Second attempt (retry): server accepts and returns success
    pool
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        bodies.push(typeof req.body === 'string' ? req.body : '');
        return actionReply('corrected-tok');
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt');

    // Start with a wrong (empty) token
    await c.startRun(1);

    // The retry must have used the server-hinted token "1779560436189"
    expect(bodies[0]).toContain('"actionToken":"1779560436189"');

    await agent.close();
  }, 15_000);

  it('updates lastActionToken when error is in "message" field', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get('https://gigaverse.io');
    const bodies: string[] = [];

    pool
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(500, { message: 'token mismatch != 9876543210' });

    pool
      .intercept({ path: '/api/game/dungeon/action', method: 'POST' })
      .reply(200, (req: ReqLike) => {
        bodies.push(typeof req.body === 'string' ? req.body : '');
        return actionReply('ok');
      });

    const c = new GigaClient(stubAccount, silentLog, { dispatcher: agent });
    c.setJwt('test.jwt');

    await c.startRun(1);

    expect(bodies[0]).toContain('"actionToken":"9876543210"');

    await agent.close();
  }, 15_000);
});
