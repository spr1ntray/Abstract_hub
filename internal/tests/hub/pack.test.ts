import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import packJson from '../../../hub-pack.json';
import { compareVersions, HubPackManager, HubPackSchema } from '../../src/hub/pack.js';

let dataDir: string | undefined;

afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe('Hub data packs', () => {
  it('compares core and dated pack versions numerically', () => {
    expect(compareVersions('0.1.11', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('2026.07.30.2', '2026.07.30.10')).toBeLessThan(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('installs a validated pending pack atomically and can roll it back', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'abstract-hub-pack-'));
    const next = {
      ...HubPackSchema.parse(packJson),
      packVersion: '2026.08.01.2',
      publishedAt: '2026-08-01T22:00:00.000Z',
    };
    const manager = new HubPackManager({
      appRoot: resolve('.'),
      dataDir,
      remotePackUrl: 'https://updates.example/pack.json',
      releaseApiUrl: 'https://updates.example/release.json',
      fetchText: async (url) =>
        url.endsWith('/pack.json') ? JSON.stringify(next) : '{"tag_name":"v0.1.11"}',
    });

    const checked = await manager.check();
    expect(checked.pendingPackVersion).toBe(next.packVersion);
    expect(manager.installPending().packVersion).toBe(next.packVersion);
    expect(
      JSON.parse(await readFile(join(dataDir, 'hub-updates', 'hub-pack.json'), 'utf8')),
    ).toMatchObject({
      packVersion: next.packVersion,
    });
    expect(manager.rollback().packVersion).toBe(packJson.packVersion);
  });

  it('rejects an installed pack that changes the vote contract', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'abstract-hub-pack-'));
    await mkdir(join(dataDir, 'hub-updates'));
    await writeFile(
      join(dataDir, 'hub-updates', 'hub-pack.json'),
      JSON.stringify({
        ...packJson,
        packVersion: '2026.07.30.9',
        modules: {
          ...packJson.modules,
          abstractDiscover: {
            ...packJson.modules.abstractDiscover,
            voteContract: `0x${'f'.repeat(40)}`,
          },
        },
      }),
    );
    const manager = new HubPackManager({ appRoot: resolve('.'), dataDir });
    expect(manager.status()).toMatchObject({
      packVersion: packJson.packVersion,
      packSource: 'bundled',
    });
  });

  it('treats a missing remote pack as bundled-current instead of an update error', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'abstract-hub-pack-'));
    const manager = new HubPackManager({
      appRoot: resolve('.'),
      dataDir,
      fetchText: async (url) => {
        if (url.includes('releases')) return '{"tag_name":"v0.1.12"}';
        throw new Error('HTTP 404');
      },
    });

    expect(await manager.check()).toMatchObject({
      packVersion: packJson.packVersion,
      packSource: 'bundled',
    });
    expect(manager.status().warning).toBeUndefined();
  });
});
