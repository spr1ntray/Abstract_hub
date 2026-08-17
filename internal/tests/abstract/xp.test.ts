import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AbstractXpStore, summarizePortalExperience } from '../../src/abstract/xp.js';
import {
  isPortalExperienceHttpResponse,
  isPortalExperienceResponse,
  PORTAL_EXPERIENCE_LIMIT,
  portalSessionWalletAddress,
  readPortalXpWithAdsPower,
} from '../../src/abstract/xp-browser.js';
import type { AdsPowerBrowserController } from '../../src/adspower/browser.js';

const address = `0x${'a'.repeat(40)}`;

describe('Abstract XP', () => {
  const privyToken = (walletAddress: string): string => {
    const payload = Buffer.from(
      JSON.stringify({ custom_metadata: JSON.stringify({ walletAddress }) }),
    ).toString('base64url');
    return `header.${payload}.signature`;
  };

  it('sorts weekly epochs and calculates the recap', () => {
    const snapshot = summarizePortalExperience(
      {
        lastEpoch: 12,
        items: [
          { userId: '1', epoch: 11, points: 31, season: 2 },
          { userId: '1', epoch: 12, points: 237, season: 2, description: 'Apps' },
        ],
      },
      { lifetimeXp: 12_345 },
    );

    expect(snapshot).toMatchObject({
      totalXp: 268,
      pendingPoints: 0,
      latestEpoch: 12,
      latestPoints: 237,
      currentEpoch: 13,
      lifetimeXp: 12_345,
    });
    expect(snapshot.items.map((item) => item.epoch)).toEqual([12, 11]);
  });

  it('keeps current-week XP separate from the last confirmed epoch', () => {
    const snapshot = summarizePortalExperience({
      lastEpoch: 80,
      items: [
        { userId: '1', epoch: 81, points: 30, season: 2 },
        { userId: '1', epoch: 80, points: 130, season: 2 },
      ],
    });

    expect(snapshot).toMatchObject({
      currentEpoch: 81,
      latestEpoch: 80,
      latestPoints: 130,
      pendingPoints: 30,
      totalXp: 160,
    });
  });

  it('recognizes only the official Portal experience response', () => {
    expect(
      isPortalExperienceResponse('https://backend.portal.abs.xyz/api/user/me/experience?limit=100'),
    ).toBe(true);
    expect(isPortalExperienceResponse('https://portal.abs.xyz/rewards')).toBe(false);
    expect(isPortalExperienceResponse('not a url')).toBe(false);
  });

  it('ignores the empty CORS preflight that caused the XP parser error', () => {
    const response = (method: string, status: number) => ({
      url: () => 'https://backend.portal.abs.xyz/api/user/me/experience?limit=100',
      request: () => ({ method: () => method }),
      status: () => status,
    });

    expect(isPortalExperienceHttpResponse(response('OPTIONS', 204))).toBe(false);
    expect(isPortalExperienceHttpResponse(response('GET', 200))).toBe(true);
  });

  it('verifies the AGW address carried by the authenticated Portal session', () => {
    expect(portalSessionWalletAddress({ 'x-privy-token': privyToken(address) })).toBe(address);
    expect(portalSessionWalletAddress({ authorization: `Bearer ${privyToken(address)}` })).toBe(
      address,
    );
    expect(portalSessionWalletAddress({ 'x-privy-token': 'invalid' })).toBeUndefined();
  });

  it('reads XP from the existing first-party Portal session without SIWE', async () => {
    const experienceResponse = {
      url: () => 'https://backend.portal.abs.xyz/api/user/me/experience?limit=100',
      ok: () => true,
      status: () => 200,
      request: () => ({ method: () => 'GET', headers: () => ({ 'x-privy-token': 'session' }) }),
      json: vi.fn(async () => ({
        lastEpoch: 8,
        items: [{ userId: '42', epoch: 8, points: 125, season: 2 }],
      })),
    };
    const profileResponse = {
      url: () => 'https://backend.portal.abs.xyz/api/user/me',
      ok: () => true,
      status: () => 200,
      request: () => ({ method: () => 'GET', headers: () => ({ 'x-privy-token': 'session' }) }),
      json: vi.fn(async () => ({
        user: {
          id: '42',
          name: 'Portal User',
          walletAddress: address,
          totalExperiencePoints: 4_250,
        },
      })),
    };
    const page = {
      url: vi.fn(() => 'about:blank'),
      goto: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
      waitForResponse: vi
        .fn()
        .mockResolvedValueOnce(experienceResponse)
        .mockResolvedValueOnce(profileResponse),
      evaluate: vi.fn(async () => ({
        user: { id: '42', name: 'Portal User', walletAddress: address },
      })),
    };
    const release = vi.fn(async () => undefined);
    const openPage = vi.fn(async () => ({
      profileId: 'profile-one',
      browser: {},
      page,
      release,
    }));
    const result = await readPortalXpWithAdsPower({
      browsers: { openPage } as unknown as AdsPowerBrowserController,
      adsPower: { apiUrl: 'http://127.0.0.1:50325', apiKey: 'test' },
      profileId: 'profile-one',
      rewardsUrl: 'https://portal.abs.xyz/rewards',
      expectedAddress: address,
    });

    expect(result).toMatchObject({
      profileName: 'Portal User',
      lifetimeXp: 4_250,
      experience: { lastEpoch: 8 },
    });
    expect(openPage).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: false,
        background: true,
        navigate: false,
        startIfNeeded: true,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('re-fetches the exact official XP endpoint when Portal answers the page request with 304', async () => {
    const experienceResponse = {
      url: () => 'https://backend.portal.abs.xyz/api/user/me/experience?limit=100',
      ok: () => false,
      status: () => 304,
      request: () => ({
        method: () => 'GET',
        headers: () => ({ 'x-privy-token': 'privy-session-token' }),
      }),
      json: vi.fn(async () => undefined),
    };
    const profileResponse = {
      url: () => 'https://backend.portal.abs.xyz/api/user/me',
      ok: () => true,
      status: () => 200,
      request: () => ({
        method: () => 'GET',
        headers: () => ({ 'x-privy-token': 'privy-session-token' }),
      }),
      json: vi.fn(async () => ({
        user: { id: '42', walletAddress: address, totalExperiencePoints: 160 },
      })),
    };
    const page = {
      url: vi.fn(() => 'about:blank'),
      goto: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
      waitForResponse: vi
        .fn()
        .mockResolvedValueOnce(experienceResponse)
        .mockResolvedValueOnce(profileResponse),
      evaluate: vi.fn().mockResolvedValueOnce({
        status: 200,
        body: {
          lastEpoch: 80,
          pagination: { page: 1, limit: 100, totalPages: 1, totalItems: 80 },
          items: [
            { userId: '42', epoch: 81, points: 30, season: 2 },
            { userId: '42', epoch: 80, points: 130, season: 2 },
          ],
        },
      }),
    };
    const release = vi.fn(async () => undefined);
    const result = await readPortalXpWithAdsPower({
      browsers: {
        openPage: vi.fn(async () => ({ profileId: 'profile-one', browser: {}, page, release })),
      } as unknown as AdsPowerBrowserController,
      adsPower: { apiUrl: 'http://127.0.0.1:50325', apiKey: 'test' },
      profileId: 'profile-one',
      rewardsUrl: 'https://portal.abs.xyz/rewards',
      expectedAddress: address,
    });

    expect(result).toMatchObject({ lifetimeXp: 160, experience: { lastEpoch: 80 } });
    expect(result.experience.items[0]).toMatchObject({ epoch: 81, points: 30 });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(PORTAL_EXPERIENCE_LIMIT).toBe(100);
    expect(page.evaluate.mock.calls[0]?.[1]).toBe(
      'https://backend.portal.abs.xyz/api/user/me/experience',
    );
    expect(page.evaluate.mock.calls[0]?.[2]).toEqual({
      'x-privy-token': 'privy-session-token',
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps parsed XP when the profile response is skipped but Privy confirms the AGW', async () => {
    const token = privyToken(address);
    const experienceResponse = {
      url: () => 'https://backend.portal.abs.xyz/api/user/me/experience?limit=100',
      ok: () => true,
      status: () => 200,
      request: () => ({ method: () => 'GET', headers: () => ({ 'x-privy-token': token }) }),
      json: vi.fn(async () => ({
        lastEpoch: 81,
        items: [{ userId: '42', epoch: 81, points: 60, season: 2 }],
      })),
    };
    const page = {
      url: vi.fn(() => 'about:blank'),
      goto: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
      waitForResponse: vi
        .fn()
        .mockResolvedValueOnce(experienceResponse)
        .mockResolvedValueOnce(undefined),
      evaluate: vi.fn(async () => ({ status: 404, body: { message: 'Not found' } })),
    };
    const release = vi.fn(async () => undefined);
    const result = await readPortalXpWithAdsPower({
      browsers: {
        openPage: vi.fn(async () => ({ profileId: 'profile-one', browser: {}, page, release })),
      } as unknown as AdsPowerBrowserController,
      adsPower: { apiUrl: 'http://127.0.0.1:50325', apiKey: 'test' },
      profileId: 'profile-one',
      rewardsUrl: 'https://portal.abs.xyz/rewards',
      expectedAddress: address,
    });

    expect(result).toMatchObject({ experience: { lastEpoch: 81 } });
    expect(release).toHaveBeenCalledOnce();
  });

  it('marks pending XP found on the first successful sync as a new arrival', () => {
    const directory = mkdtempSync(join(tmpdir(), 'abstract-xp-pending-'));
    const store = new AbstractXpStore(join(directory, 'xp.json'));
    const snapshot = summarizePortalExperience(
      {
        lastEpoch: 80,
        items: [
          { userId: 1, epoch: 81, points: 30, season: 1 },
          { userId: 1, epoch: 80, points: 130, season: 1 },
        ],
      },
      { lifetimeXp: 160 },
    );

    expect(store.record(address, snapshot)).toMatchObject({
      totalXp: 160,
      pendingPoints: 30,
      newPoints: 30,
      hasNewXp: true,
    });
    expect(store.acknowledge(address)).toMatchObject({ newPoints: 0, hasNewXp: false });
  });

  it('persists and marks a later weekly update as new', () => {
    const directory = mkdtempSync(join(tmpdir(), 'abstract-xp-'));
    const path = join(directory, 'xp.json');
    const store = new AbstractXpStore(path);
    const first = summarizePortalExperience({
      lastEpoch: 4,
      items: [{ userId: 1, epoch: 4, points: 19, season: 1 }],
    });
    expect(store.record(address, first).hasNewXp).toBe(false);

    const second = summarizePortalExperience({
      lastEpoch: 5,
      items: [
        { userId: 1, epoch: 5, points: 31, season: 1 },
        { userId: 1, epoch: 4, points: 19, season: 1 },
      ],
    });
    expect(store.record(address, second)).toMatchObject({
      latestEpoch: 5,
      latestPoints: 31,
      totalXp: 50,
      newPoints: 31,
      hasNewXp: true,
    });
    expect(store.acknowledge(address)?.hasNewXp).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
  });
});
