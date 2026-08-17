import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  TollanBrowserSessions,
  isTransientTollanLoadError,
  readTollanResponseBody,
  successfulTollanResponse,
  tollanClientEndpoint,
  tollanPracticeStartPlan,
} = require('../../../desktop/tollan-browser.cjs') as {
  TollanBrowserSessions: { prototype: Record<string, unknown> };
  isTransientTollanLoadError: (error: unknown) => boolean;
  readTollanResponseBody: (
    debug: { sendCommand: (method: string, params: unknown) => Promise<unknown> },
    requestId: string,
    status: number,
  ) => Promise<Record<string, unknown>>;
  successfulTollanResponse: (status: number, body: { success?: boolean }) => boolean;
  tollanClientEndpoint: (url: string) => string | null;
  tollanPracticeStartPlan: (cycle?: number) => Array<{
    type: 'click' | 'key';
    xRatio?: number;
    yRatio?: number;
    keyCode?: string;
  }>;
};

describe('Tollan browser runner', () => {
  it('recognizes successful Practice responses with query params and no success field', () => {
    expect(
      tollanClientEndpoint('https://hub.tollan.io/api/client/practice-start?build=2026.08.07'),
    ).toBe('practice-start');
    expect(tollanClientEndpoint('https://hub.tollan.io/api/client/practice-score/')).toBe(
      'practice-score',
    );
    expect(tollanClientEndpoint('https://hub.tollan.io/api/client/profile')).toBeNull();
    expect(successfulTollanResponse(204, {})).toBe(true);
    expect(successfulTollanResponse(200, { success: false })).toBe(false);
    expect(successfulTollanResponse(500, { success: true })).toBe(false);
  });

  it('keeps a successful empty Practice response when Chromium has no body', async () => {
    const debug = {
      sendCommand: vi.fn().mockRejectedValue(new Error('No data found for resource')),
    };

    await expect(readTollanResponseBody(debug, 'request-1', 204)).resolves.toEqual({});
    expect(debug.sendCommand).not.toHaveBeenCalled();
    await expect(readTollanResponseBody(debug, 'request-2', 200)).resolves.toEqual({});
    expect(debug.sendCommand).toHaveBeenCalledOnce();
  });

  it('uses the current free Practice flow instead of the removed Monk selector', () => {
    const pointerPlan = tollanPracticeStartPlan(0);
    const clicks = pointerPlan
      .filter((action) => action.type === 'click')
      .map((action) => [action.xRatio, action.yRatio]);

    expect(clicks).toContainEqual([0.226, 0.42]);
    expect(clicks).toContainEqual([0.412, 0.716]);
    expect(clicks).toContainEqual([0.5, 0.882]);
    expect(clicks).not.toContainEqual([0.23, 0.53]);
  });

  it('has a keyboard fallback matching Tollan current Unity navigation graph', () => {
    const keyPlan = tollanPracticeStartPlan(1)
      .filter((action) => action.type === 'key')
      .map((action) => action.keyCode);

    expect(keyPlan).toEqual(['Escape', 'Down', 'Enter', 'Right', 'Enter', 'Down', 'Enter']);
  });

  it('stops input retries when the current empty HTTP 200 start response arrives', async () => {
    const manager = Object.create(TollanBrowserSessions.prototype) as {
      update: (
        state: { snapshot: Record<string, unknown> },
        patch: Record<string, unknown>,
      ) => void;
      trace: ReturnType<typeof vi.fn>;
      startNetworkMonitor: (state: unknown, window: unknown) => Promise<() => void>;
    };
    manager.update = (state, patch) => Object.assign(state.snapshot, patch);
    manager.trace = vi.fn();

    const debug = Object.assign(new EventEmitter(), {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: vi.fn(() => true),
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Network.getResponseBody') throw new Error('No data found for resource');
        return {};
      }),
    });
    const state = {
      snapshot: { state: 'starting', message: 'Запускаем Practice' },
      practiceStartRequestedAt: 0,
    };
    const stop = await manager.startNetworkMonitor(state, { webContents: { debugger: debug } });

    debug.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'start-1',
      request: { method: 'POST', url: 'https://hub.tollan.io/api/client/practice-start' },
    });
    expect(state.practiceStartRequestedAt).toBeGreaterThan(0);

    debug.emit('message', {}, 'Network.responseReceived', {
      requestId: 'start-1',
      type: 'Fetch',
      response: { status: 200, url: 'https://hub.tollan.io/api/client/practice-start' },
    });
    debug.emit('message', {}, 'Network.loadingFinished', { requestId: 'start-1' });

    await vi.waitFor(() => expect(state.snapshot.state).toBe('playing'));
    expect(state.practiceStartRequestedAt).toBe(0);
    stop();
  });

  it('waits for the official Practice link after restoring the saved login', async () => {
    const manager = Object.create(TollanBrowserSessions.prototype) as {
      injectAuthState: ReturnType<typeof vi.fn>;
      waitForPracticeLink: (input: unknown, state: unknown, window: unknown) => Promise<unknown>;
    };
    manager.injectAuthState = vi.fn(async () => true);
    const executeJavaScript = vi.fn(async () => ({
      href: 'https://hub.tollan.io/game/practice',
      text: 'Practice',
      direct: false,
    }));

    await expect(
      manager.waitForPracticeLink(
        {
          hubUrl: 'https://hub.tollan.io',
          practicePath: '/game/practice',
          claimMissionActionId: '6d9edff5194c9b25d732a52bc7aeb8e4439a12ae',
        },
        { stopRequested: false },
        { isDestroyed: () => false, webContents: { executeJavaScript } },
      ),
    ).resolves.toEqual({
      href: 'https://hub.tollan.io/game/practice',
      text: 'Practice',
      direct: false,
    });
    expect(manager.injectAuthState).toHaveBeenCalledOnce();
  });

  it('uses the official Practice route when the launcher UI is late', async () => {
    const manager = Object.create(TollanBrowserSessions.prototype) as {
      waitForPracticeLink: (
        input: unknown,
        state: unknown,
        window: unknown,
        timeoutMs: number,
      ) => Promise<unknown>;
    };

    await expect(
      manager.waitForPracticeLink(
        {
          hubUrl: 'https://hub.tollan.io',
          practicePath: '/game/practice',
          claimMissionActionId: '6d9edff5194c9b25d732a52bc7aeb8e4439a12ae',
        },
        { stopRequested: false },
        { isDestroyed: () => false, webContents: { executeJavaScript: vi.fn() } },
        0,
      ),
    ).resolves.toEqual({
      href: 'https://hub.tollan.io/game/practice',
      text: 'Practice',
      direct: true,
    });
  });

  it('retries a transient Electron network change', async () => {
    const manager = Object.create(TollanBrowserSessions.prototype) as {
      update: ReturnType<typeof vi.fn>;
      loadUrlWithRetries: (
        state: unknown,
        window: unknown,
        url: string,
        retryDelays: number[],
      ) => Promise<void>;
    };
    manager.update = vi.fn();
    const networkChanged = Object.assign(new Error('ERR_NETWORK_CHANGED (-21)'), {
      code: 'ERR_NETWORK_CHANGED',
      errno: -21,
    });
    const loadURL = vi.fn().mockRejectedValueOnce(networkChanged).mockResolvedValueOnce(undefined);

    await expect(
      manager.loadUrlWithRetries(
        { stopRequested: false },
        { isDestroyed: () => false, loadURL },
        'https://hub.tollan.io',
        [0],
      ),
    ).resolves.toBeUndefined();
    expect(loadURL).toHaveBeenCalledTimes(2);
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: expect.stringContaining('Повторяем загрузку Tollan') }),
    );
    expect(isTransientTollanLoadError(networkChanged)).toBe(true);
    expect(isTransientTollanLoadError(new Error('ERR_NAME_NOT_RESOLVED'))).toBe(false);
  });

  it('allows only the official Practice popup and returns its game window', async () => {
    const manager = Object.create(TollanBrowserSessions.prototype) as {
      update: ReturnType<typeof vi.fn>;
      waitForPracticeLink: ReturnType<typeof vi.fn>;
      openPractice: (input: unknown, state: unknown, window: unknown) => Promise<unknown>;
    };
    manager.update = vi.fn();
    manager.waitForPracticeLink = vi.fn(async () => ({
      href: 'https://hub.tollan.io/game/practice',
    }));

    const gameWindow = {
      setMenu: vi.fn(),
      webContents: { setAudioMuted: vi.fn() },
    };
    let openHandler: ((details: { url: string }) => { action: string }) | undefined;
    const launcher = {
      webContents: {
        setWindowOpenHandler: vi.fn((handler) => {
          openHandler = handler;
        }),
        once: vi.fn((_event, listener) => listener(gameWindow)),
        executeJavaScript: vi.fn(async () => true),
      },
    };
    const input = {
      accountAlias: 'main',
      hubUrl: 'https://hub.tollan.io',
      practicePath: '/game/practice',
      claimMissionActionId: '6d9edff5194c9b25d732a52bc7aeb8e4439a12ae',
    };

    await expect(
      manager.openPractice(input, { partition: 'persist:tollan' }, launcher),
    ).resolves.toBe(gameWindow);
    expect(openHandler?.({ url: 'https://hub.tollan.io/game/practice' }).action).toBe('allow');
    expect(openHandler?.({ url: 'https://example.com/game/practice' }).action).toBe('deny');
    expect(launcher.webContents.executeJavaScript).toHaveBeenCalledOnce();
  });
});
