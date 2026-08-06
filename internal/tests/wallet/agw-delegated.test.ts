import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Account } from '../../src/vault/schema.js';
import {
  ABSTRACT_MAINNET_CHAIN_ID,
  assessDelegatedAgwSession,
  connectDelegatedAgw,
  delegatedAgwHome,
  extractAgwApprovalUrls,
  makeDelegatedAgwLoginSigner,
  makeDelegatedAgwSigner,
  repairDelegatedAgwDefaultPolicy,
  resolveDelegatedAgwHome,
  runAgwCli,
  type AgwCliRunner,
  type DelegatedAgwSession,
} from '../../src/wallet/agw-delegated.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
// Deliberately invalid mixed-case checksum: the CLI boundary must normalize it.
const MARKET = '0x37d6DBFa9f82ac4aCC86D49702aC0612D3aa1AfE';
const HASH = `0x${'a'.repeat(64)}`;

const account: Account = {
  name: 'acc1-111111',
  jwt: 'eyJa.eyJb.signature',
  agwAddress: ADDRESS,
  proxy: { type: 'http', host: '127.0.0.1', port: 8080 },
};

function session(overrides: Partial<DelegatedAgwSession> = {}): DelegatedAgwSession {
  return {
    status: 'active',
    readiness: 'active_write_ready',
    writeReady: true,
    accountAddress: ADDRESS,
    chainId: ABSTRACT_MAINNET_CHAIN_ID,
    policyPreset: 'contract_write',
    enabledTools: ['send_transaction', 'sign_message'],
    ...overrides,
  };
}

describe('delegated AGW', () => {
  it('keeps per-account session paths inside the configured home', () => {
    const home = delegatedAgwHome(
      { name: '../../Unsafe Name', agwAddress: ADDRESS },
      { homeRoot: '/tmp/gigabot-test' },
    );

    expect(home).toBe(resolve('/tmp/gigabot-test', 'agw-sessions', 'unsafe-name-11111111'));
  });

  it('uses a stable session id before the Abstract address is known', () => {
    const home = delegatedAgwHome(
      { name: 'temporary-row', sessionId: 'b'.repeat(32) },
      { homeRoot: '/tmp/gigabot-test' },
    );

    expect(home).toBe(resolve('/tmp/gigabot-test', 'agw-sessions', `session-${'b'.repeat(32)}`));
  });

  it('discovers the account address during first-time browser onboarding', async () => {
    const firstTimeAccount: Account = {
      name: 'setup-browser',
      sessionId: 'c'.repeat(32),
      proxy: { type: 'http', host: '127.0.0.1', port: 1 },
    };
    const runner = vi.fn<AgwCliRunner>(async (_account, args) => {
      if (args[0] === 'auth') return { ok: true };
      return { ...session() };
    });

    const result = await connectDelegatedAgw(firstTimeAccount, {}, runner);

    expect(result.state).toBe('ready');
    expect(result.session.accountAddress).toBe(ADDRESS);
  });

  it('rejects a valid session linked to another AGW account', () => {
    const result = assessDelegatedAgwSession(
      session({ accountAddress: '0x3333333333333333333333333333333333333333' }),
      ADDRESS,
    );

    expect(result.state).toBe('wrong_account');
  });

  it('requires send_transaction permission', () => {
    const result = assessDelegatedAgwSession(session({ enabledTools: ['sign_message'] }), ADDRESS);

    expect(result.state).toBe('needs_permission');
  });

  it('requires sign_message permission for unattended account access', () => {
    const result = assessDelegatedAgwSession(
      session({ enabledTools: ['send_transaction'] }),
      ADDRESS,
    );

    expect(result.state).toBe('needs_permission');
    expect(result.message).toContain('автоматический вход');
  });

  it('repairs the hosted AGW CLI default metadata without widening custom policies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gigabot-agw-policy-'));
    const home = delegatedAgwHome(account, { homeRoot: root });
    const sessionPath = join(home, 'session.json');
    const hostedDefault = {
      accountAddress: ADDRESS,
      chainId: ABSTRACT_MAINNET_CHAIN_ID,
      status: 'active',
      updatedAt: 1,
      policyMeta: {
        presetId: 'full_app_control',
        presetLabel: 'AGW CLI Default',
        enabledTools: ['sign_transaction', 'send_transaction'],
        warnings: [
          'This signer can submit transactions and typed-data signatures within the remote spend and time limits.',
          'Plain personal_sign requests are not enabled in the default policy.',
        ],
      },
      capabilitySummary: {
        enabledTools: ['sign_transaction', 'send_transaction'],
      },
    };
    await mkdir(home, { recursive: true });
    await writeFile(sessionPath, JSON.stringify(hostedDefault, null, 2), 'utf8');

    try {
      expect(repairDelegatedAgwDefaultPolicy(account, { homeRoot: root })).toBe(true);
      const repaired = JSON.parse(await readFile(sessionPath, 'utf8'));
      expect(repaired.policyMeta.enabledTools).toEqual([
        'sign_transaction',
        'send_transaction',
        'sign_message',
      ]);
      expect(repaired.capabilitySummary.enabledTools).toEqual([
        'sign_transaction',
        'send_transaction',
      ]);
      expect(repairDelegatedAgwDefaultPolicy(account, { homeRoot: root })).toBe(false);

      repaired.policyMeta = {
        ...repaired.policyMeta,
        presetId: 'custom',
        enabledTools: ['send_transaction'],
      };
      await writeFile(sessionPath, JSON.stringify(repaired, null, 2), 'utf8');
      expect(repairDelegatedAgwDefaultPolicy(account, { homeRoot: root })).toBe(false);
      const custom = JSON.parse(await readFile(sessionPath, 'utf8'));
      expect(custom.policyMeta.enabledTools).toEqual(['send_transaction']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not use a transaction-only session to sign an account login message', async () => {
    const runner = vi.fn<AgwCliRunner>(async () => ({
      ...session({ enabledTools: ['send_transaction'] }),
    }));

    await expect(makeDelegatedAgwLoginSigner(account, {}, runner)).rejects.toThrow(
      'автоматический вход',
    );
  });

  it('recovers the newest active local session by AGW address', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gigabot-agw-discovery-'));
    const sessionsRoot = join(root, 'agw-sessions');
    const stale = join(sessionsRoot, 'session-stale');
    const current = join(sessionsRoot, 'session-current');
    await mkdir(stale, { recursive: true });
    await mkdir(current, { recursive: true });
    await writeFile(
      join(stale, 'session.json'),
      JSON.stringify({ accountAddress: ADDRESS, status: 'active', updatedAt: 10 }),
    );
    await writeFile(join(stale, 'privy-auth.key'), 'encrypted-test-key');
    await writeFile(
      join(current, 'session.json'),
      JSON.stringify({ accountAddress: ADDRESS.toUpperCase(), status: 'active', updatedAt: 20 }),
    );
    await writeFile(join(current, 'privy-auth.key'), 'encrypted-test-key');
    try {
      expect(
        resolveDelegatedAgwHome({ ...account, sessionId: 'f'.repeat(32) }, { homeRoot: root }),
      ).toBe(current);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('extracts copyable connect and revoke approval URLs from CLI logs', () => {
    expect(
      extractAgwApprovalUrls(
        '[agw] Opening hosted onboarding app: https://cli.abs.xyz/session/new?a=1\n' +
          '[agw] Opening hosted revoke flow: https://cli.abs.xyz/session/revoke?b=2\n',
      ),
    ).toEqual(['https://cli.abs.xyz/session/new?a=1', 'https://cli.abs.xyz/session/revoke?b=2']);
  });

  it.skipIf(process.platform === 'win32')(
    'suppresses the CLI browser opener when the app owns the approval dialog',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'gigabot-agw-guard-'));
      const cliDir = join(root, 'app', 'node_modules', '@abstract-foundation', 'agw-cli', 'dist');
      const binDir = join(root, 'bin');
      const marker = join(root, 'browser-opened');
      await mkdir(cliDir, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(
        join(cliDir, 'index.mjs'),
        `
import childProcess from 'node:child_process';
const child = childProcess.spawn('open', ['https://example.invalid'], { stdio: 'ignore' });
await new Promise((resolve, reject) => {
  child.once('spawn', resolve);
  child.once('error', reject);
});
process.stderr.write('Opening hosted onboarding app: https://cli.abs.xyz/session/new?a=1\\n');
process.stdout.write(JSON.stringify({ guard: process.env.GIGABOT_AGW_SUPPRESS_BROWSER_OPEN }));
`,
        'utf8',
      );
      const fakeOpen = join(binDir, 'open');
      await writeFile(
        fakeOpen,
        '#!/bin/sh\nprintf invoked > "$GIGABOT_TEST_BROWSER_MARKER"\n',
        'utf8',
      );
      await chmod(fakeOpen, 0o700);

      const previousPath = process.env['PATH'];
      const previousMarker = process.env['GIGABOT_TEST_BROWSER_MARKER'];
      process.env['PATH'] = `${binDir}:${previousPath ?? ''}`;
      process.env['GIGABOT_TEST_BROWSER_MARKER'] = marker;
      try {
        const onApprovalUrl = vi.fn();
        const result = await runAgwCli(account, ['auth', 'init'], {
          appRoot: join(root, 'app'),
          homeRoot: join(root, 'home'),
          command: process.execPath,
          onApprovalUrl,
          timeoutMs: 5_000,
        });

        expect(result).toEqual({ guard: '1' });
        expect(onApprovalUrl).toHaveBeenCalledWith('https://cli.abs.xyz/session/new?a=1');
        await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (previousPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = previousPath;
        if (previousMarker === undefined) delete process.env['GIGABOT_TEST_BROWSER_MARKER'];
        else process.env['GIGABOT_TEST_BROWSER_MARKER'] = previousMarker;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('normalizes the target, previews, then broadcasts the transaction', async () => {
    const runner = vi.fn<AgwCliRunner>(async (_account, args) => {
      if (args[0] === 'session') {
        return {
          status: 'active',
          readiness: 'active_write_ready',
          writeReady: true,
          accountAddress: ADDRESS,
          chainId: ABSTRACT_MAINNET_CHAIN_ID,
          policyPreset: 'contract_write',
          enabledTools: ['send_transaction', 'sign_message'],
        };
      }
      if (args.includes('--dry-run')) return { preview: true };
      return { broadcast: true, txHash: HASH };
    });

    const signer = await makeDelegatedAgwSigner(account, {}, runner);
    const txHash = await signer.sendTransaction({ to: MARKET, data: '0x1234', value: 0n });

    expect(txHash).toBe(HASH);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls[1]?.[1]).toContain('--dry-run');
    expect(runner.mock.calls[2]?.[1]).toContain('--execute');
    const dryRunArgs = runner.mock.calls[1]?.[1] ?? [];
    const jsonIndex = dryRunArgs.indexOf('--json');
    expect(JSON.parse(dryRunArgs[jsonIndex + 1]!)).toEqual({
      to: MARKET.toLowerCase(),
      data: '0x1234',
      value: '0',
    });
  });

  it('previews and signs a Gigaverse login message through the delegated account', async () => {
    const signature = `0x${'b'.repeat(130)}`;
    const runner = vi.fn<AgwCliRunner>(async (_account, args) => {
      if (args[0] === 'session') {
        return {
          status: 'active',
          readiness: 'active_write_ready',
          writeReady: true,
          accountAddress: ADDRESS,
          chainId: ABSTRACT_MAINNET_CHAIN_ID,
          policyPreset: 'custom',
          enabledTools: ['send_transaction', 'sign_message'],
        };
      }
      if (args.includes('--dry-run')) return { preview: true };
      return { accountAddress: ADDRESS, signature };
    });

    const signer = await makeDelegatedAgwLoginSigner(account, {}, runner);

    await expect(signer.signMessage({ message: 'Login to Gigaverse at 1' })).resolves.toBe(
      signature,
    );
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls[1]?.[1]).toContain('--dry-run');
    expect(runner.mock.calls[2]?.[1]).toContain('--execute');
  });
});
