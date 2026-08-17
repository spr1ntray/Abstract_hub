import type { HTTPResponse, Page } from 'puppeteer-core';
import { z } from 'zod';
import { AdsPowerBrowserController } from '../adspower/browser.js';
import type { AdsPowerConfig } from '../adspower/types.js';
import { PortalExperienceSchema, type PortalExperience } from './xp.js';

export { PORTAL_EXPERIENCE_LIMIT } from './xp.js';

const PORTAL_ORIGIN = 'https://portal.abs.xyz';
const PORTAL_BACKEND_ORIGIN = 'https://backend.portal.abs.xyz';
const EXPERIENCE_PATH = '/api/user/me/experience';
const PROFILE_PATH = '/api/user/me';
const RESPONSE_TIMEOUT_MS = 90_000;
const RESPONSE_CAPTURE_GRACE_MS = 12_000;

const PortalProfileSchema = z.object({
  user: z
    .object({
      id: z.union([z.string(), z.number()]).optional(),
      walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      name: z.string().optional(),
      totalExperiencePoints: z.coerce.number().finite().nonnegative().optional(),
    })
    .passthrough(),
});

export interface PortalXpBrowserResult {
  experience: PortalExperience;
  profileName?: string;
  lifetimeXp?: number;
}

export interface ReadPortalXpInput {
  browsers: AdsPowerBrowserController;
  adsPower: AdsPowerConfig;
  profileId: string;
  rewardsUrl: string;
  expectedAddress: string;
  startProfile?: boolean;
}

function responsePath(response: HTTPResponse): string | undefined {
  try {
    return new URL(response.url()).pathname.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

export function isPortalExperienceResponse(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, '') === EXPERIENCE_PATH;
  } catch {
    return false;
  }
}

export function isPortalExperienceHttpResponse(response: {
  request(): { method(): string };
  status(): number;
  url(): string;
}): boolean {
  return (
    isPortalExperienceResponse(response.url()) &&
    response.request().method() === 'GET' &&
    ![204, 205].includes(response.status())
  );
}

function isPortalProfileResponse(response: HTTPResponse): boolean {
  return responsePath(response) === PROFILE_PATH && response.request().method() === 'GET';
}

async function responseJson(response: HTTPResponse): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

interface PortalFetchResult {
  status: number;
  body: unknown;
}

async function fetchPortalJson(
  page: Page,
  url: string,
  authHeaders: Record<string, string> = {},
): Promise<PortalFetchResult> {
  return (await page.evaluate(
    async (target, forwardedHeaders) => {
      try {
        const response = await fetch(target, {
          cache: 'no-store',
          credentials: 'include',
          headers: { accept: 'application/json', ...forwardedHeaders },
        });
        const text = await response.text();
        let body: unknown;
        try {
          body = text ? (JSON.parse(text) as unknown) : undefined;
        } catch {
          body = text || undefined;
        }
        return { status: response.status, body };
      } catch (error) {
        return {
          status: 0,
          body: {
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    url,
    authHeaders,
  )) as PortalFetchResult;
}

function portalAuthHeaders(...responses: Array<HTTPResponse | undefined>): Record<string, string> {
  for (const response of responses) {
    if (!response) continue;
    const headers = response.request().headers();
    const privyToken = headers['x-privy-token'];
    if (privyToken) return { 'x-privy-token': privyToken };
    const authorization = headers['authorization'];
    if (authorization) return { authorization };
  }
  return {};
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read the AGW address Privy binds to this first-party Portal session. */
export function portalSessionWalletAddress(headers: Record<string, string>): string | undefined {
  const raw = headers['x-privy-token'] ?? headers['authorization']?.replace(/^Bearer\s+/i, '');
  const payload = raw?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = jsonRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    const metadata = jsonRecord(claims?.['custom_metadata']);
    const address = String(metadata?.['walletAddress'] ?? '').trim();
    return /^0x[a-fA-F0-9]{40}$/.test(address) ? address.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function parseExperience(body: unknown): PortalExperience | undefined {
  const result = PortalExperienceSchema.safeParse(body);
  return result.success ? result.data : undefined;
}

function portalResponseError(status: number, body: unknown): Error {
  const detail =
    body && typeof body === 'object' && !Array.isArray(body)
      ? String(
          (body as Record<string, unknown>)['message'] ??
            (body as Record<string, unknown>)['error'] ??
            '',
        ).trim()
      : '';
  if (status === 401 || /unauthorized/i.test(detail)) {
    return new Error(
      'Portal не авторизован в этом AdsPower-профиле. Откройте Rewards и войдите в Abstract один раз.',
    );
  }
  if (status === 429) {
    return new Error('Portal временно ограничил проверку XP. Повторите через несколько минут.');
  }
  if (status === 0) {
    return new Error(
      detail || 'Браузер не смог получить XP из Portal. Проверьте сеть AdsPower-профиля.',
    );
  }
  return new Error(detail || `Portal вернул HTTP ${status}`);
}

async function navigateRewards(page: Page, rewardsUrl: string): Promise<void> {
  let currentOrigin = '';
  let currentHref = '';
  try {
    currentHref = page.url();
    currentOrigin = new URL(currentHref).origin;
  } catch {
    // A newly created page starts at about:blank.
  }
  if (currentOrigin === PORTAL_ORIGIN && currentHref === rewardsUrl) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
    return;
  }
  await page.goto(rewardsUrl, {
    waitUntil: 'domcontentloaded',
    timeout: RESPONSE_TIMEOUT_MS,
  });
}

/** Read XP through Portal's own authenticated browser client instead of forging a SIWE login. */
export async function readPortalXpWithAdsPower(
  input: ReadPortalXpInput,
): Promise<PortalXpBrowserResult> {
  const lease = await input.browsers.openPage({
    config: input.adsPower,
    profileId: input.profileId,
    url: input.rewardsUrl,
    reuseOrigin: true,
    navigate: false,
    activate: false,
    startIfNeeded: input.startProfile !== false,
    restoreTabs: false,
    background: true,
  });
  const { page } = lease;
  try {
    const experienceResponsePromise = page
      .waitForResponse(isPortalExperienceHttpResponse, { timeout: RESPONSE_TIMEOUT_MS })
      .catch(() => undefined);
    const profileResponsePromise = page
      .waitForResponse(isPortalProfileResponse, { timeout: RESPONSE_TIMEOUT_MS })
      .catch(() => undefined);

    try {
      await navigateRewards(page, input.rewardsUrl);
    } catch {
      throw new Error(
        'Не удалось открыть Portal Rewards в AdsPower. Проверьте профиль и подключение к сети.',
      );
    }

    const captureTimeout = () =>
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), RESPONSE_CAPTURE_GRACE_MS),
      );
    const [experienceResponse, profileResponse] = await Promise.all([
      Promise.race([experienceResponsePromise, captureTimeout()]),
      Promise.race([profileResponsePromise, captureTimeout()]),
    ]);
    const backendOrigin = experienceResponse
      ? new URL(experienceResponse.url()).origin
      : profileResponse
        ? new URL(profileResponse.url()).origin
        : PORTAL_BACKEND_ORIGIN;
    const authHeaders = portalAuthHeaders(experienceResponse, profileResponse);
    const sessionAddress = portalSessionWalletAddress(authHeaders);
    if (sessionAddress && sessionAddress !== input.expectedAddress.toLowerCase()) {
      throw new Error('В AdsPower-профиле открыт другой Abstract-аккаунт');
    }
    const interceptedBody = experienceResponse ? await responseJson(experienceResponse) : undefined;
    let experience =
      experienceResponse?.status() === 200 ? parseExperience(interceptedBody) : undefined;

    if (!experience) {
      // Cached Portal calls answer with 304 and no readable body. Replay the exact
      // official endpoint with the short-lived Privy header captured from the page.
      const direct = await fetchPortalJson(page, `${backendOrigin}${EXPERIENCE_PATH}`, authHeaders);
      if (direct.status < 200 || direct.status >= 300) {
        throw portalResponseError(direct.status, direct.body);
      }
      experience = parseExperience(direct.body);
    }
    if (!experience) {
      throw new Error(
        'Portal вернул пустой или изменённый ответ XP. Обновите хаб или повторите проверку позже.',
      );
    }

    const capturedProfileBody = profileResponse?.ok()
      ? await responseJson(profileResponse)
      : undefined;
    const directProfile = PortalProfileSchema.safeParse(capturedProfileBody).success
      ? undefined
      : await fetchPortalJson(page, `${backendOrigin}${PROFILE_PATH}`, authHeaders);
    if (directProfile && (directProfile.status < 200 || directProfile.status >= 300)) {
      if (sessionAddress !== input.expectedAddress.toLowerCase()) {
        throw portalResponseError(directProfile.status, directProfile.body);
      }
    }
    const profileBody =
      directProfile && directProfile.status >= 200 && directProfile.status < 300
        ? directProfile.body
        : capturedProfileBody;
    const profile = PortalProfileSchema.safeParse(profileBody);
    if (profile.success) {
      if (profile.data.user.walletAddress.toLowerCase() !== input.expectedAddress.toLowerCase()) {
        throw new Error('В AdsPower-профиле открыт другой Abstract-аккаунт');
      }
      const experienceUserId = experience.items[0]?.userId;
      if (
        experienceUserId !== undefined &&
        profile.data.user.id !== undefined &&
        String(profile.data.user.id) !== String(experienceUserId)
      ) {
        throw new Error('Portal вернул XP другого Abstract-аккаунта');
      }
      const name = profile.data.user.name?.trim();
      return {
        experience,
        ...(name ? { profileName: name } : {}),
        ...(profile.data.user.totalExperiencePoints !== undefined
          ? { lifetimeXp: profile.data.user.totalExperiencePoints }
          : {}),
      };
    }
    if (sessionAddress === input.expectedAddress.toLowerCase()) {
      return { experience };
    }
    throw new Error(
      'Portal вернул XP, но не подтвердил адрес аккаунта. Откройте Rewards в привязанном AdsPower-профиле один раз.',
    );
  } finally {
    await lease.release();
  }
}
