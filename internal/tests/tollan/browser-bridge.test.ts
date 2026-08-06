import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { TollanBrowserSessions } = require('../../../desktop/tollan-browser.cjs') as {
  TollanBrowserSessions: { prototype: Record<string, unknown> };
};

describe('Tollan browser runner', () => {
  it('waits for the official Practice link after restoring the saved login', async () => {
    const manager = Object.create(TollanBrowserSessions.prototype) as {
      injectAuthState: ReturnType<typeof vi.fn>;
      waitForPracticeLink: (input: unknown, state: unknown, window: unknown) => Promise<unknown>;
    };
    manager.injectAuthState = vi.fn(async () => true);
    const executeJavaScript = vi.fn(async () => ({
      href: 'https://hub.tollan.io/game/practice',
      text: 'Practice',
    }));

    await expect(
      manager.waitForPracticeLink(
        {
          hubUrl: 'https://hub.tollan.io',
          practicePath: '/game/practice',
        },
        { stopRequested: false },
        { isDestroyed: () => false, webContents: { executeJavaScript } },
      ),
    ).resolves.toEqual({ href: 'https://hub.tollan.io/game/practice', text: 'Practice' });
    expect(manager.injectAuthState).toHaveBeenCalledOnce();
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
    };

    await expect(
      manager.openPractice(input, { partition: 'persist:tollan' }, launcher),
    ).resolves.toBe(gameWindow);
    expect(openHandler?.({ url: 'https://hub.tollan.io/game/practice' }).action).toBe('allow');
    expect(openHandler?.({ url: 'https://example.com/game/practice' }).action).toBe('deny');
    expect(launcher.webContents.executeJavaScript).toHaveBeenCalledOnce();
  });
});
