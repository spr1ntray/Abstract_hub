import { describe, expect, it, vi } from 'vitest';
import {
  AdsPowerApiError,
  AdsPowerClient,
  normalizeAdsPowerApiUrl,
  normalizeAdsPowerProfileId,
} from '../../src/adspower/client.js';
import { centeredAdsPowerWindowBounds } from '../../src/adspower/browser.js';
import { ADSPOWER_MUTE_AUDIO_SCRIPT, muteAdsPowerPageAudio } from '../../src/adspower/audio.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AdsPower Local API client', () => {
  it('installs the tab audio guard before navigation and enforces it immediately', async () => {
    const evaluateOnNewDocument = vi.fn(async () => ({ identifier: 'mute-script' }));
    const evaluate = vi.fn(async () => undefined);
    const page = {
      evaluateOnNewDocument,
      evaluate,
    } as unknown as Parameters<typeof muteAdsPowerPageAudio>[0];

    await muteAdsPowerPageAudio(page);

    expect(evaluateOnNewDocument).toHaveBeenCalledWith(ADSPOWER_MUTE_AUDIO_SCRIPT);
    expect(evaluate).toHaveBeenCalledWith(ADSPOWER_MUTE_AUDIO_SCRIPT);
    expect(ADSPOWER_MUTE_AUDIO_SCRIPT).toContain("wrapAudioContext('AudioContext')");
    expect(ADSPOWER_MUTE_AUDIO_SCRIPT).toContain("querySelectorAll('audio, video')");
    expect(ADSPOWER_MUTE_AUDIO_SCRIPT).toContain('setInterval(enforce, 250)');
  });

  it('centres the visible worker window inside the current screen', () => {
    expect(
      centeredAdsPowerWindowBounds(
        { availLeft: 0, availTop: 25, availWidth: 1920, availHeight: 1055 },
        { width: 1600, height: 1000 },
      ),
    ).toEqual({ left: 320, top: 143, width: 1280, height: 820, windowState: 'normal' });
  });

  it('allows only official loopback Local API addresses', () => {
    expect(normalizeAdsPowerApiUrl()).toBe('http://127.0.0.1:50325');
    expect(normalizeAdsPowerApiUrl('http://localhost:60000/')).toBe('http://localhost:60000');
    expect(() => normalizeAdsPowerApiUrl('https://example.com')).toThrow(AdsPowerApiError);
    expect(() => normalizeAdsPowerApiUrl('http://127.0.0.1:50325/api')).toThrow(/базовый адрес/);
    expect(normalizeAdsPowerProfileId('j4abc_123-x')).toBe('j4abc_123-x');
    expect(() => normalizeAdsPowerProfileId('../wrong')).toThrow(/профиля AdsPower/);
  });

  it('loads profile IDs and sends the shared API key only in Authorization', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain('/api/v1/user/list?page=1&page_size=100');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer shared-secret');
      return jsonResponse({
        code: 0,
        msg: 'success',
        data: {
          list: [
            {
              user_id: 'profile_one',
              serial_number: '7',
              name: 'Abstract 1',
              group_id: '2',
              group_name: 'Main',
              last_open_time: '12345',
            },
          ],
        },
      });
    });
    const client = new AdsPowerClient(
      { apiUrl: 'http://127.0.0.1:50325', apiKey: 'shared-secret' },
      fetchMock as typeof fetch,
      0,
    );

    await expect(client.listProfiles()).resolves.toEqual([
      {
        id: 'profile_one',
        serialNumber: '7',
        name: 'Abstract 1',
        groupId: '2',
        groupName: 'Main',
        lastOpenTime: 12345,
      },
    ]);
  });

  it('reuses an already open profile and its CDP endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: {
          status: 'Active',
          ws: {
            puppeteer: 'ws://127.0.0.1:51000/devtools/browser/test',
            selenium: '127.0.0.1:51000',
          },
        },
      }),
    );
    const client = new AdsPowerClient(
      { apiUrl: 'http://127.0.0.1:50325', apiKey: 'shared-secret' },
      fetchMock as typeof fetch,
      0,
    );

    await expect(client.startBrowser('profile_one')).resolves.toMatchObject({
      profileId: 'profile_one',
      status: 'Active',
      puppeteerWs: 'ws://127.0.0.1:51000/devtools/browser/test',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('starts a clean worker profile and closes it through the V2 API', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { status: 'Inactive' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { ws: { puppeteer: 'ws://127.0.0.1:51000/devtools/browser/test' } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'success' }));
    const client = new AdsPowerClient(
      { apiUrl: 'http://127.0.0.1:50325', apiKey: 'shared-secret' },
      fetchMock,
      0,
    );

    await client.startBrowser('profile_one', { restoreTabs: false, background: true });
    await client.stopBrowser('profile_one');

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://127.0.0.1:50325/api/v2/browser-profile/start',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      profile_id: 'profile_one',
      last_opened_tabs: '0',
      launch_args: expect.arrayContaining([
        '--start-minimized',
        '--disable-background-timer-throttling',
      ]),
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('http://127.0.0.1:50325/api/v2/browser-profile/stop');
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      profile_id: 'profile_one',
    });
  });

  it('surfaces AdsPower errors without echoing the API key', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: -1, msg: 'Require api-key' }));
    const client = new AdsPowerClient(
      { apiUrl: 'http://127.0.0.1:50325', apiKey: 'do-not-leak' },
      fetchMock as typeof fetch,
      0,
    );

    await expect(client.listProfiles()).rejects.toThrow('Require api-key');
    await expect(client.listProfiles()).rejects.not.toThrow('do-not-leak');
  });
});
