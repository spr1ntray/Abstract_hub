import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { answerProxyLogin } = require('../../../desktop/proxy-login.cjs') as {
  answerProxyLogin: (
    states: Map<string, unknown>,
    event: object,
    webContents: object | undefined,
    authInfo: object,
    callback: (username: string, password: string) => void,
  ) => boolean;
};

describe('desktop proxy login router', () => {
  it('answers an Electron one-time callback only once across browser modules', () => {
    const browserSession = {};
    const states = new Map([
      [
        'account',
        {
          browserSession,
          proxy: { host: 'proxy.example', port: 8080, username: 'user', password: 'pass' },
        },
      ],
    ]);
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    const authInfo = { isProxy: true, host: 'proxy.example', port: 8080 };

    expect(answerProxyLogin(states, event, { session: browserSession }, authInfo, callback)).toBe(
      true,
    );
    expect(answerProxyLogin(states, event, { session: browserSession }, authInfo, callback)).toBe(
      false,
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith('user', 'pass');
  });

  it('does not route a webContents challenge by a coincidental proxy address', () => {
    const states = new Map([
      [
        'account',
        {
          browserSession: {},
          proxy: { host: 'proxy.example', port: 8080, username: 'user', password: 'pass' },
        },
      ],
    ]);

    expect(
      answerProxyLogin(
        states,
        { preventDefault: vi.fn() },
        { session: {} },
        { isProxy: true, host: 'proxy.example', port: 8080 },
        vi.fn(),
      ),
    ).toBe(false);
  });
});
