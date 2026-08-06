import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

interface BrowserRequest {
  body?: string;
  headers?: Record<string, string>;
}

const require = createRequire(import.meta.url);
const {
  browserRequestHeaders,
  collectWalletAddresses,
  CambriaBrowserSessions,
  seedExternalProfile,
} = require('../../../desktop/cambria-browser.cjs') as {
  browserRequestHeaders: (request: BrowserRequest) => Record<string, string>;
  collectWalletAddresses: (value: unknown) => Set<string>;
  CambriaBrowserSessions: { prototype: Record<string, unknown> };
  seedExternalProfile: (
    browser: { name: string; userDataDir: string },
    targetRoot: string,
  ) => { profileName: string; seeded: boolean };
};

describe('Cambria external browser bridge', () => {
  it('uses the browser cookie session without forwarding a conflicting bearer token', () => {
    expect(
      browserRequestHeaders({
        body: '{}',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer customer-token',
          cookie: 'privy-token=secret-cookie',
          origin: 'https://lobby.cambria.gg',
          'x-privy-token': 'identity-token',
        },
      }),
    ).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      origin: 'https://lobby.cambria.gg',
      'x-privy-token': 'identity-token',
    });
  });

  it('does not treat Unauthorized as a reusable browser session', async () => {
    const manager = Object.create(CambriaBrowserSessions.prototype) as {
      fetch: () => Promise<{ status: number }>;
      probe: (input: unknown, state: unknown) => Promise<boolean>;
    };
    manager.fetch = async () => ({ status: 401 });
    await expect(manager.probe({ apiBase: 'https://api.cambria.gg' }, {})).resolves.toBe(false);
  });

  it('recognizes the expected AGW inside a Privy cross-app session', () => {
    expect(
      collectWalletAddresses({
        user: {
          linked_accounts: [
            {
              type: 'cross_app',
              smart_wallets: [{ address: '0xABcdef0123456789abCDef0123456789aBCDEf01' }],
              embedded_wallets: [{ address: '0x1111111111111111111111111111111111111111' }],
            },
          ],
        },
      }),
    ).toContain('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('opens the official Cambria flow in an external browser without synthetic credentials', async () => {
    const state = { key: 'account' };
    const manager = Object.create(CambriaBrowserSessions.prototype) as {
      stateFor: () => typeof state;
      configureProxy: ReturnType<typeof vi.fn>;
      seedCookies: ReturnType<typeof vi.fn>;
      probe: ReturnType<typeof vi.fn>;
      openExternalAuth: ReturnType<typeof vi.fn>;
      verifyInternal: (input: unknown) => Promise<void>;
    };
    manager.stateFor = () => state;
    manager.configureProxy = vi.fn(async () => undefined);
    manager.seedCookies = vi.fn(async () => undefined);
    manager.probe = vi.fn(async () => false);
    manager.openExternalAuth = vi.fn(async () => undefined);

    const input = {
      address: '0xabcdef0123456789abcdef0123456789abcdef01',
      lobbyUrl: 'https://lobby.cambria.gg',
      apiBase: 'https://lobby-api.cambria.gg',
      privyApiBase: 'https://privy.cambria.gg',
      privyAppId: 'cambria-app',
      privyClient: 'react-auth:test',
      proxy: { type: 'http', host: '127.0.0.1', port: 8080 },
    };
    await manager.verifyInternal(input);

    expect(manager.seedCookies).toHaveBeenCalledWith(input, state);
    expect(manager.openExternalAuth).toHaveBeenCalledWith(input, state);
  });

  it('seeds a managed browser from the active profile without copying unrelated browsing data', () => {
    const root = mkdtempSync(join(tmpdir(), 'abstract-hub-cambria-'));
    const source = join(root, 'source');
    const target = join(root, 'target');
    mkdirSync(join(source, 'Profile 2', 'Local Storage'), { recursive: true });
    mkdirSync(join(source, 'Profile 2', 'IndexedDB', 'https_lobby.cambria.gg_0'), {
      recursive: true,
    });
    mkdirSync(join(source, 'Profile 2', 'IndexedDB', 'https_mail.example_0'), {
      recursive: true,
    });
    writeFileSync(
      join(source, 'Local State'),
      JSON.stringify({ profile: { last_active_profiles: ['Profile 2'] } }),
    );
    writeFileSync(join(source, 'Profile 2', 'Cookies'), 'encrypted cookies');
    writeFileSync(
      join(source, 'Profile 2', 'Preferences'),
      JSON.stringify({ profile: { exit_type: 'Crashed' }, session: { restore_on_startup: 1 } }),
    );
    writeFileSync(join(source, 'Profile 2', 'Local Storage', 'state'), 'browser state');
    writeFileSync(
      join(source, 'Profile 2', 'IndexedDB', 'https_lobby.cambria.gg_0', 'data'),
      'cambria',
    );
    writeFileSync(join(source, 'Profile 2', 'IndexedDB', 'https_mail.example_0', 'data'), 'mail');
    writeFileSync(join(source, 'Profile 2', 'History'), 'history');

    expect(seedExternalProfile({ name: 'Test Browser', userDataDir: source }, target)).toEqual({
      profileName: 'Profile 2',
      seeded: true,
    });
    expect(readFileSync(join(target, 'Profile 2', 'Cookies'), 'utf8')).toBe('encrypted cookies');
    expect(JSON.parse(readFileSync(join(target, 'Profile 2', 'Preferences'), 'utf8'))).toEqual({
      profile: { exit_type: 'Normal', exited_cleanly: true },
      session: { restore_on_startup: 5, startup_urls: [] },
    });
    expect(
      readFileSync(
        join(target, 'Profile 2', 'IndexedDB', 'https_lobby.cambria.gg_0', 'data'),
        'utf8',
      ),
    ).toBe('cambria');
    expect(() => readFileSync(join(target, 'Profile 2', 'History'), 'utf8')).toThrow();
    expect(() =>
      readFileSync(join(target, 'Profile 2', 'IndexedDB', 'https_mail.example_0', 'data'), 'utf8'),
    ).toThrow();
  });

  it('imports only Cambria cookies into the persistent application session', async () => {
    const set = vi.fn(async () => undefined);
    const manager = Object.create(CambriaBrowserSessions.prototype) as {
      importCambriaCookies: (
        state: unknown,
        cookies: Array<Record<string, unknown>>,
      ) => Promise<number>;
    };
    const imported = await manager.importCambriaCookies({ browserSession: { cookies: { set } } }, [
      {
        name: 'privy-token',
        value: 'secret',
        domain: '.cambria.gg',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'None',
        expires: 1_900_000_000,
      },
      {
        name: 'abstract-session',
        value: 'do-not-copy',
        domain: '.abs.xyz',
        path: '/',
        secure: true,
      },
    ]);

    expect(imported).toBe(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'privy-token',
        value: 'secret',
        domain: '.cambria.gg',
        sameSite: 'no_restriction',
      }),
    );
  });

  it('aborts a browser request that never returns', async () => {
    const browserFetch = vi.fn(
      async (_url: string, options: { signal: AbortSignal }): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    );
    const manager = Object.create(CambriaBrowserSessions.prototype) as {
      fetch: (
        state: { browserSession: { fetch: typeof browserFetch } },
        request: { url: string; method: string; headers: Record<string, string> },
        timeoutMs: number,
      ) => Promise<unknown>;
    };

    await expect(
      manager.fetch(
        { browserSession: { fetch: browserFetch } },
        {
          url: 'https://lobby-api.cambria.gg/user/current',
          method: 'GET',
          headers: { accept: 'application/json' },
        },
        1,
      ),
    ).rejects.toThrow('Cambria не ответила вовремя (1с)');
  });
});
