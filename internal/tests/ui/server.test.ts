import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startUiServer, stopUiServer } from '../../src/ui/server.js';
import type { AgwCliRunner } from '../../src/wallet/agw-delegated.js';
import { decryptToMemory } from '../../src/config/encrypted-files.js';
import { parseAccountsFromText } from '../../src/config/load-from-files.js';

let dataDir: string | undefined;

afterEach(async () => {
  await stopUiServer();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe('desktop UI server', () => {
  it('controls desktop developer diagnostics through localhost only', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'gigabot-ui-'));
    let enabled = false;
    const events: unknown[] = [];
    const status = () => ({
      available: true,
      enabled,
      directory: join(dataDir!, 'diagnostics'),
      currentFile: enabled ? 'diagnostics-test.jsonl' : null,
      files: [],
    });
    const diagnostics = {
      status,
      setEnabled: vi.fn((value: boolean) => {
        enabled = value;
        return status();
      }),
      record: vi.fn((source: string, event: string, data?: unknown) => {
        events.push({ source, event, data });
      }),
      recent: vi.fn(() => events),
      openFolder: vi.fn(async () => undefined),
    };
    const handle = await startUiServer({
      port: 0,
      dataDir,
      appRoot: resolve('.'),
      desktop: true,
      openBrowser: false,
      diagnostics,
    });

    const initial = await fetch(`${handle.url}/api/developer/status`);
    expect(await initial.json()).toMatchObject({ diagnostics: { enabled: false } });
    const toggle = await fetch(`${handle.url}/api/developer/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(await toggle.json()).toMatchObject({ diagnostics: { enabled: true } });
    await fetch(`${handle.url}/api/developer/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'frontend', event: 'test_event', data: { ok: true } }),
    });
    const recent = await fetch(`${handle.url}/api/developer/recent`);
    expect(await recent.json()).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ source: 'frontend', event: 'test_event' }),
      ]),
    });
    expect(diagnostics.openFolder).not.toHaveBeenCalled();
  });

  it('serves browser AGW auth and stores the resulting session only in the encrypted bundle', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'gigabot-ui-'));
    const address = `0x${'a'.repeat(40)}`;
    const now = Date.now();
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ address, exp: Math.floor((now + 2 * 60 * 60_000) / 1000) }),
    ).toString('base64url');
    const jwt = `${header}.${payload}.signature`;
    const signerAddress = `0x${'b'.repeat(40)}`;
    const tollanNonce = 'tollan-nonce-test';
    const handle = await startUiServer({
      port: 0,
      dataDir,
      appRoot: resolve('.'),
      desktop: true,
      openBrowser: false,
      tollanRequestNonce: async (_config, signer, agw) => {
        expect(signer).toBe(signerAddress);
        expect(agw).toBe(address);
        return {
          nonce: tollanNonce,
          allowed: true,
          sessionCookies: ['tollan-challenge=test; Path=/'],
        };
      },
      tollanLogin: async (_config, input) => {
        expect(input.sessionCookies).toEqual(['tollan-challenge=test; Path=/']);
        return {
          agwAddress: input.agwAddress,
          signerAddress: input.signerAddress,
          state: {
            payload: {
              sub: 'tollan-user-test',
              address: input.agwAddress,
              signer: input.signerAddress,
            },
            account: { accountName: 'Test noob', defaultAccount: true },
          },
          cookies: ['tollan-session=test; Path=/'],
          capturedAt: now,
        };
      },
    });

    const loginResponse = await fetch(`${handle.url}/api/game-auth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedAddress: address,
        accountAlias: 'acc1',
      }),
    });
    expect(loginResponse.status).toBe(202);
    const login = (await loginResponse.json()) as {
      operation: {
        id: string;
        loginUrl: string;
        state: string;
      };
    };
    expect(login.operation).not.toHaveProperty('callbackSecret');
    expect(login.operation.state).toBe('awaiting_browser');
    const externalUrl = new URL(login.operation.loginUrl);
    expect(externalUrl.origin).toBe(handle.url);
    expect(externalUrl.pathname).toMatch(/^\/game-auth\/[a-f0-9]{48}\/[a-f0-9]{48}$/);

    const authPageResponse = await fetch(externalUrl);
    expect(authPageResponse.status).toBe(200);
    expect(authPageResponse.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await authPageResponse.text()).toContain('Безопасный вход через Abstract');

    const pathParts = externalUrl.pathname.split('/');
    const callbackUrl = `${handle.url}/api/game-auth/callback/${pathParts[2]}/${pathParts[3]}`;

    const preflightResponse = await fetch(callbackUrl!, {
      method: 'OPTIONS',
      headers: {
        origin: handle.url,
        'access-control-request-method': 'POST',
        'access-control-request-private-network': 'true',
      },
    });
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get('access-control-allow-origin')).toBe(handle.url);

    const incompleteCallbackResponse = await fetch(callbackUrl!, {
      method: 'POST',
      headers: {
        origin: handle.url,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        authResponse: JSON.stringify({
          jwt,
          expiresAt: now + 2 * 60 * 60_000,
          gameAccount: { primaryUsername: 'testnoob' },
        }),
      }),
    });
    expect(incompleteCallbackResponse.status).toBe(200);
    expect(await incompleteCallbackResponse.json()).toMatchObject({
      ok: true,
      tollanConnected: false,
      tollanWarning: expect.stringContaining('Tollan'),
    });

    const tollanOnlyResponse = await fetch(`${handle.url}/api/game-auth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedAddress: address,
        accountAlias: 'acc1',
        needsGame: false,
        needsTollan: true,
      }),
    });
    expect(tollanOnlyResponse.status).toBe(202);
    const tollanOnly = (await tollanOnlyResponse.json()) as {
      operation: { id: string; loginUrl: string; state: string };
    };
    const tollanOnlyUrl = new URL(tollanOnly.operation.loginUrl);
    const tollanPathParts = tollanOnlyUrl.pathname.split('/');
    const tollanOnlyCallbackUrl = `${handle.url}/api/game-auth/callback/${tollanPathParts[2]}/${tollanPathParts[3]}`;
    const tollanOnlyNonceUrl = `${handle.url}/api/game-auth/tollan/nonce/${tollanPathParts[2]}/${tollanPathParts[3]}`;

    const nonceResponse = await fetch(tollanOnlyNonceUrl, {
      method: 'POST',
      headers: {
        origin: handle.url,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ signerAddress }),
    });
    expect(nonceResponse.status).toBe(200);
    expect(await nonceResponse.json()).toEqual({ nonce: tollanNonce, allowed: true });

    const callbackResponse = await fetch(tollanOnlyCallbackUrl, {
      method: 'POST',
      headers: {
        origin: handle.url,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        tollanAuth: { signerAddress, nonce: tollanNonce, signature: '0x1234' },
      }),
    });
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.json()).toMatchObject({
      ok: true,
      address,
      tollanConnected: true,
    });

    const operationResponse = await fetch(
      `${handle.url}/api/game-auth/operations/${tollanOnly.operation.id}`,
    );
    expect(operationResponse.status).toBe(200);
    expect(await operationResponse.json()).toMatchObject({
      operation: { state: 'completed', expectedAddress: address },
    });

    const setupResponse = await fetch(`${handle.url}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        password: 'test-password',
        accounts: `abstract:${address} | session=${'d'.repeat(32)}`,
        proxies: '127.0.0.1:8080',
      }),
    });
    expect(setupResponse.status).toBe(200);
    const vaultCookie = setupResponse.headers.get('set-cookie')?.split(';', 1)[0];
    expect(vaultCookie).toMatch(/^abstract_hub_vault=/);

    const sessionUnlockResponse = await fetch(`${handle.url}/api/game-auth/needed`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: vaultCookie!,
      },
      body: JSON.stringify({ password: '__abstract_hub_vault_session__' }),
    });
    expect(sessionUnlockResponse.status).toBe(200);
    expect(await sessionUnlockResponse.json()).toEqual({ accounts: [] });

    const bundle = await decryptToMemory('test-password', {
      encPath: join(dataDir, 'secrets.enc'),
    });
    expect(bundle.accounts).not.toContain(jwt);
    expect(bundle.gameSessions?.[address]).toMatchObject({ jwt, address });
    expect(bundle.tollanSessions?.[address]).toMatchObject({
      agwAddress: address,
      signerAddress,
    });

    const tollanStatusResponse = await fetch(`${handle.url}/api/tollan/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    expect(tollanStatusResponse.status).toBe(200);
    expect(await tollanStatusResponse.json()).toMatchObject({
      accounts: [{ displayName: '@testnoob', connected: true }],
    });
    const savedAccountAlias = parseAccountsFromText({
      accountsText: bundle.accounts,
      proxiesText: bundle.proxies,
    })[0]!.account.name;

    const cambriaStartResponse = await fetch(`${handle.url}/api/cambria-auth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password', accountAlias: savedAccountAlias }),
    });
    expect(cambriaStartResponse.status).toBe(202);
    const cambriaStart = (await cambriaStartResponse.json()) as {
      operation: { id: string; loginUrl: string; state: string };
    };
    expect(cambriaStart.operation.state).toBe('awaiting_browser');
    const cambriaLoginUrl = new URL(cambriaStart.operation.loginUrl);
    expect(cambriaLoginUrl.pathname).toMatch(/^\/cambria-auth\/[a-f0-9]{48}\/[a-f0-9]{48}$/);
    const cambriaPageResponse = await fetch(cambriaLoginUrl);
    expect(cambriaPageResponse.status).toBe(200);
    expect(await cambriaPageResponse.text()).toContain('Безопасный вход Cambria через Abstract');

    const cambriaPath = cambriaLoginUrl.pathname.split('/');
    const cambriaCallbackResponse = await fetch(
      `${handle.url}/api/cambria-auth/callback/${cambriaPath[2]}/${cambriaPath[3]}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          auth: {
            user: {
              id: 'did:privy:cambria-browser',
              linked_accounts: [{ type: 'cross_app', smart_wallets: [{ address }] }],
            },
            token: 'cambria-customer-token',
            refresh_token: 'cambria-refresh-token',
            identity_token: 'cambria-identity-token',
          },
        }),
      },
    );
    expect(cambriaCallbackResponse.status).toBe(200);
    expect(await cambriaCallbackResponse.json()).toEqual({ ok: true, address });

    const bundleWithCambria = await decryptToMemory('test-password', {
      encPath: join(dataDir, 'secrets.enc'),
    });
    expect(bundleWithCambria.cambriaSessions?.[address]).toMatchObject({
      address,
      userId: 'did:privy:cambria-browser',
      customerToken: 'cambria-customer-token',
    });
  });

  it('serves the dashboard and desktop status on a free localhost port', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'gigabot-ui-'));
    const handle = await startUiServer({
      port: 0,
      dataDir,
      appRoot: resolve('.'),
      desktop: true,
      openBrowser: false,
    });

    const statusResponse = await fetch(`${handle.url}/api/status`);
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      running: false,
      hasSecrets: false,
      desktop: true,
      platform: process.platform,
    });

    const dashboardResponse = await fetch(handle.url);
    expect(dashboardResponse.status).toBe(200);
    const dashboard = await dashboardResponse.text();
    expect(dashboard).toContain('Кувшины, сундуки, данжи');
    expect(dashboard).toContain('Flash-бейджи');
    expect(dashboard).not.toContain('id="tab-label-badges" hidden');
    expect(dashboard).toContain('id="form-badges" class="panel badge-controls" hidden');
    expect(dashboard).toContain('Активных бейджей нет');
    expect(dashboard).toContain('Genesis Loot');
    expect(dashboard).toContain('id="badges-max-spend"');
    expect(dashboard).toContain('step="any"');
    expect(dashboard).toContain('Получить бейдж');
    expect(dashboard).not.toContain('class="command-dock"');
    expect(dashboard).toContain('id="build-signature"');
    expect(dashboard).toContain('assets/abstract-logo.png');
    expect(dashboard).toContain('assets/gigaverse-logo.png');
    expect(dashboard).toContain('assets/cambria-logo.png');
    expect(dashboard).toContain('assets/tollan-logo.png');
    expect(dashboard).toContain('assets/tollan-cover.jpg');
    expect(dashboard).not.toContain('assets/gigling-racing-badge.png');
    expect(dashboard).toContain('id="theme-toggle"');
    expect(dashboard).toContain('role="switch"');
    expect(dashboard).toContain('theme-init.js');
    expect(dashboard).toContain('id="form-tollan"');
    expect(dashboard).toContain('https://hub.tollan.io/game/practice');
    expect(dashboard).not.toContain('value="discover"');

    const styleResponse = await fetch(`${handle.url}/style.css`);
    expect(styleResponse.status).toBe(200);
    const style = await styleResponse.text();
    expect(style).toContain('.tabs::before');
    expect(style).toContain('.btn--primary::after');
    expect(style).toContain('inset: 0;');
    expect(style).toContain('@keyframes badge-border-glow');
    expect(style).toContain('@keyframes blur-reveal');
    expect(style).toContain('.tab-active-rail');
    expect(style).not.toContain('.command-dock');
    expect(style).toContain('@keyframes border-orbit');
    expect(style).toContain('@keyframes title-blur-in');
    expect(style).toContain("html[data-theme='dark']");
    expect(style).toContain('.theme-toggle-thumb');
    expect(style).toContain('cubic-bezier(0.34, 1.56, 0.64, 1)');
    expect(style).toContain('.inv-condition-track');
    expect(style).toContain('.tollan-account');
    expect(style).toContain('scrollbar-gutter: stable');
    expect(style).toContain("html[data-theme='dark'] .inventory-view-toggle span");
    expect(style).not.toContain('.inventory-filter input::after');
    expect(style).not.toContain('rgba(201, 240, 93');

    const gigaverseLogoResponse = await fetch(`${handle.url}/assets/gigaverse-logo.png`);
    expect(gigaverseLogoResponse.status).toBe(200);
    expect(gigaverseLogoResponse.headers.get('content-type')).toContain('image/png');

    const badgeImageResponse = await fetch(`${handle.url}/assets/gigling-racing-badge.png`);
    expect(badgeImageResponse.status).toBe(404);

    const appResponse = await fetch(`${handle.url}/app.js`);
    expect(appResponse.status).toBe(200);
    const appScript = await appResponse.text();
    expect(appScript).toContain('new Set(backgroundActivityTabs)');
    expect(appScript).toContain(
      "setBackgroundActivity('badges', !campaignClosed && inProgress > 0)",
    );
    expect(appScript).toContain('if (badgeCampaignClosed())');
    expect(appScript).toContain("setBackgroundActivity('tollan', active > 0)");
    expect(appScript).toContain('if (tabLabel) tabLabel.hidden = false');
    expect(appScript).not.toContain("if (currentTab === 'badges') showTab('overview')");
    expect(appScript).toContain("document.querySelector('.badge-campaign-mark').dataset.badgeId");
    expect(appScript).not.toContain(
      "document.querySelector('.badge-campaign-mark').textContent = String(campaign.id)",
    );

    const hubResponse = await fetch(`${handle.url}/api/hub`);
    expect(await hubResponse.json()).toMatchObject({
      modules: {
        badges: {
          rewardsUrl: 'https://portal.abs.xyz/rewards',
          flash: null,
        },
        cambria: {
          lobbyUrl: 'https://lobby.cambria.gg',
        },
        tollan: {
          practiceUrl: 'https://hub.tollan.io/game/practice',
          automationAvailable: false,
        },
      },
    });
  });

  it('validates first-time Abstract onboarding before starting the wallet flow', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'gigabot-ui-'));
    const handle = await startUiServer({
      port: 0,
      dataDir,
      appRoot: resolve('.'),
      desktop: true,
      openBrowser: false,
    });

    const response = await fetch(`${handle.url}/api/abstract/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '../unsafe', expectedAddress: 'not-an-address' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Некорректный идентификатор подключения Abstract',
    });
  });

  it('bridges the hosted Abstract callback back to the waiting local CLI', async () => {
    const state = 'c'.repeat(32);
    const address = '0x1111111111111111111111111111111111111111';
    let callbackRequestUrl = '';
    let releaseAuth: (() => void) | undefined;
    const authReceived = new Promise<void>((resolveAuth) => {
      releaseAuth = resolveAuth;
    });
    const callbackServer: Server = createServer((req, res) => {
      callbackRequestUrl = req.url ?? '';
      res.statusCode = 200;
      res.end('Session received');
      releaseAuth?.();
    });
    await new Promise<void>((resolveListen) =>
      callbackServer.listen(0, '127.0.0.1', resolveListen),
    );
    const callbackAddress = callbackServer.address();
    if (!callbackAddress || typeof callbackAddress === 'string') {
      throw new Error('Test callback server did not bind');
    }
    const cliCallback = `http://127.0.0.1:${callbackAddress.port}/callback/test?state=${state}`;
    const hostedApproval = new URL('https://cli.abs.xyz/session/new');
    hostedApproval.searchParams.set('callback_url', cliCallback);
    hostedApproval.searchParams.set('chain_id', '2741');
    hostedApproval.searchParams.set('action', 'init');

    const runner: AgwCliRunner = async (_account, args, options) => {
      if (args[0] === 'auth') {
        options?.onApprovalUrl?.(hostedApproval.toString());
        await authReceived;
        return { ok: true };
      }
      return {
        status: 'active',
        readiness: 'active_write_ready',
        writeReady: true,
        accountAddress: address,
        chainId: 2741,
        policyPreset: 'custom',
        enabledTools: ['send_transaction', 'sign_message'],
      };
    };

    try {
      dataDir = await mkdtemp(join(tmpdir(), 'gigabot-ui-'));
      const handle = await startUiServer({
        port: 0,
        dataDir,
        appRoot: resolve('.'),
        desktop: true,
        openBrowser: false,
        agwCliRunner: runner,
      });

      const onboardingResponse = await fetch(`${handle.url}/api/abstract/onboard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'd'.repeat(32) }),
      });
      expect(onboardingResponse.status).toBe(202);
      const onboarding = (await onboardingResponse.json()) as {
        operation: Record<string, unknown> & { id: string; approvalUrl: string };
      };
      expect(onboarding.operation).not.toHaveProperty('callbackTarget');
      expect(onboarding.operation).not.toHaveProperty('callbackSecret');
      expect(onboarding.operation).not.toHaveProperty('abortController');

      const approval = new URL(onboarding.operation.approvalUrl);
      const bridgeUrl = approval.searchParams.get('callback_url');
      expect(bridgeUrl).toBeTruthy();
      expect(new URL(bridgeUrl!).origin).toBe(handle.url);

      const preflight = await fetch(bridgeUrl!, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://cli.abs.xyz',
          'access-control-request-method': 'GET',
          'access-control-request-private-network': 'true',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('https://cli.abs.xyz');
      expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');

      const browserCallback = new URL(bridgeUrl!);
      browserCallback.searchParams.set('session', 'signed-session-token');
      const callbackResponse = await fetch(browserCallback, {
        headers: { origin: 'https://cli.abs.xyz' },
      });
      expect(callbackResponse.status).toBe(200);
      expect(callbackRequestUrl).toContain(`state=${state}`);
      expect(callbackRequestUrl).toContain('session=signed-session-token');

      let finalOperation: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        const operationResponse = await fetch(
          `${handle.url}/api/abstract/operations/${onboarding.operation.id}`,
        );
        const payload = (await operationResponse.json()) as {
          operation: Record<string, unknown>;
        };
        finalOperation = payload.operation;
        if (finalOperation['state'] === 'completed') break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      expect(finalOperation).toMatchObject({
        state: 'completed',
        callbackReceivedAt: expect.any(Number),
      });
    } finally {
      await new Promise<void>((resolveClose) => callbackServer.close(() => resolveClose()));
    }
  });
});
