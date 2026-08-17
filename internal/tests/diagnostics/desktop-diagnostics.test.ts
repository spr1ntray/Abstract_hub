import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { DesktopDiagnostics, sanitizeDiagnosticValue } =
  require('../../../desktop/diagnostics.cjs') as {
    DesktopDiagnostics: new (input: {
      dataDir: string;
      shell: { openPath: (path: string) => Promise<string> };
      metadata?: Record<string, unknown>;
    }) => {
      setEnabled(enabled: boolean): {
        currentFile: string | null;
        directory: string;
      };
      record(source: string, event: string, data?: unknown): void;
    };
    sanitizeDiagnosticValue: (value: unknown) => unknown;
  };

let dataDir: string | undefined;

afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe('desktop developer diagnostics', () => {
  it('records operational details while redacting credentials and one-time links', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'abstract-hub-diagnostics-'));
    const diagnostics = new DesktopDiagnostics({
      dataDir,
      shell: { openPath: vi.fn(async () => '') },
      metadata: { version: 'test' },
    });
    const status = diagnostics.setEnabled(true);
    diagnostics.record('game-auth', 'request_failed', {
      password: 'master-password',
      signature: `0x${'a'.repeat(130)}`,
      authorization: 'Bearer secret-access-token',
      error: `POST /api/game-auth/callback/${'b'.repeat(48)}/${'c'.repeat(48)} failed`,
      proxy: 'http://proxy-user:proxy-pass@127.0.0.1:8080',
    });

    const content = await readFile(join(status.directory, status.currentFile!), 'utf8');
    expect(content).toContain('request_failed');
    expect(content).toContain('[REDACTED]');
    expect(content).toContain('[REDACTED-LINK-SECRET]');
    expect(content).not.toContain('master-password');
    expect(content).not.toContain('secret-access-token');
    expect(content).not.toContain('proxy-pass');
    expect(content).not.toContain('c'.repeat(48));
  });

  it('scrubs private keys nested inside error strings', () => {
    expect(
      JSON.stringify(sanitizeDiagnosticValue({ error: `failure for 0x${'d'.repeat(64)}` })),
    ).toContain('[REDACTED-PRIVATE-KEY]');
  });
});
