import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'erc1271-sig.json');

describe.skipIf(!existsSync(FIXTURE_PATH))('signLoginMessage (with fixture)', () => {
  it('produces signature matching fixture for known key + timestamp', async () => {
    // Dynamic import + fixture load — only when fixture exists
    const { makeSigner, signLoginMessage } = await import('../../src/wallet/signer.js');
    const { readFile } = await import('fs/promises');
    const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as {
      testKey: `0x${string}`;
      timestamp: number;
      expectedAgw: string;
      expectedSignature: string;
    };

    const signer = await makeSigner({
      name: 'test',
      privateKey: fixture.testKey,
      proxy: { type: 'http', host: '127.0.0.1', port: 1 },
    });
    const { signature, address } = await signLoginMessage(signer, fixture.timestamp);
    expect(address.toLowerCase()).toBe(fixture.expectedAgw.toLowerCase());
    expect(signature).toBe(fixture.expectedSignature);
  });
});

// Smoke test — runs always, just verifies module loads + types are correct
describe('signer module', () => {
  it('exports makeSigner and signLoginMessage', async () => {
    const mod = await import('../../src/wallet/signer.js');
    expect(typeof mod.makeSigner).toBe('function');
    expect(typeof mod.signLoginMessage).toBe('function');
  });
});
