import type { Browser, Page } from 'puppeteer-core';

const PORTAL_ORIGIN = 'https://portal.abs.xyz';
const CONTROL_SELECTOR = 'button, [role="button"], a';

export type AbstractPortalStep = 'connect' | 'transact';

export interface AbstractPortalProgress {
  step: AbstractPortalStep;
  state: 'approved' | 'pending';
}

interface VisibleControl {
  index: number;
  text: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function portalStep(value: string): AbstractPortalStep | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== PORTAL_ORIGIN) return undefined;
    if (url.pathname.startsWith('/cross-app/connect')) return 'connect';
    if (url.pathname.startsWith('/cross-app/transact')) return 'transact';
  } catch {
    // Ignore tabs that are still being created.
  }
  return undefined;
}

async function bodyText(page: Page): Promise<string> {
  return (await page.evaluate('document.body?.innerText?.slice(0, 12000) ?? ""')) as string;
}

async function visibleControls(page: Page, selector: string): Promise<VisibleControl[]> {
  const source = `(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    return nodes.flatMap((node, index) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const disabled = Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true';
      const visible = rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' &&
        style.display !== 'none' && Number(style.opacity || '1') > 0.05;
      const text = String(node.innerText || node.textContent || node.getAttribute('aria-label') || '')
        .replace(/\\s+/g, ' ')
        .trim();
      return visible && !disabled && text ? [{ index, text }] : [];
    });
  })()`;
  return (await page.evaluate(source)) as VisibleControl[];
}

async function clickControl(
  page: Page,
  selector: string,
  matches: (text: string) => boolean,
  fromEnd: boolean,
): Promise<string | undefined> {
  const controls = await visibleControls(page, selector);
  const ordered = fromEnd ? [...controls].reverse() : controls;
  const target = ordered.find((control) => matches(control.text));
  if (!target) return undefined;

  const handles = await page.$$(selector);
  const handle = handles[target.index];
  if (!handle) return undefined;
  try {
    await handle.click({ delay: 35 });
    return target.text;
  } finally {
    await Promise.all(
      handles.map(async (candidate) => await candidate.dispose().catch(() => undefined)),
    );
  }
}

/** Click an exact, visible first-party control with a real CDP pointer event. */
export async function clickVisibleControl(
  page: Page,
  labels: readonly string[],
  selector = CONTROL_SELECTOR,
): Promise<string | undefined> {
  const wanted = new Set(labels.map(normalizedText));
  return await clickControl(page, selector, (text) => wanted.has(normalizedText(text)), false);
}

/** Click the last exact control, which is normally the active portal/modal control. */
export async function clickLastVisibleControl(
  page: Page,
  labels: readonly string[],
  selector = CONTROL_SELECTOR,
): Promise<string | undefined> {
  const wanted = new Set(labels.map(normalizedText));
  return await clickControl(page, selector, (text) => wanted.has(normalizedText(text)), true);
}

/** Click a visible dynamic control such as `Batch Open (3)`. */
export async function clickVisibleControlMatching(
  page: Page,
  pattern: RegExp,
  selector = CONTROL_SELECTOR,
): Promise<string | undefined> {
  const matcher = new RegExp(pattern.source, pattern.flags.replaceAll('g', ''));
  return await clickControl(page, selector, (text) => matcher.test(text.trim()), false);
}

function requesterMatches(pageUrl: string, expectedOrigin: string): boolean {
  try {
    const url = new URL(pageUrl);
    const requester = url.searchParams.get('requester_origin');
    return !requester || new URL(requester).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function pageMentionsAnotherAccount(text: string, expectedAddress: string): boolean {
  const normalized = text.toLowerCase();
  const expected = expectedAddress.toLowerCase();
  if (normalized.includes(expected)) return false;
  const prefix = expected.slice(0, 6);
  const suffix = expected.slice(-4);
  if (normalized.includes(prefix) && normalized.includes(suffix)) return false;
  return /0x[a-f0-9]{4,}(?:\.{2,3}|…)[a-f0-9]{4}/i.test(text);
}

/**
 * Approve one currently open Abstract cross-app step.
 * The caller owns the outer retry loop because each app can require several steps.
 */
export async function approveOpenAbstractPortal(input: {
  browser: Browser;
  expectedOrigin: string;
  expectedAddress: string;
}): Promise<AbstractPortalProgress | undefined> {
  const expectedOrigin = new URL(input.expectedOrigin).origin;
  const pages = await input.browser.pages();
  for (const page of pages) {
    const step = portalStep(page.url());
    if (!step) continue;
    if (!requesterMatches(page.url(), expectedOrigin)) {
      throw new Error('Abstract открыл подтверждение для другого приложения');
    }

    await page.bringToFront();
    const text = await bodyText(page);
    if (!text.trim()) return { step, state: 'pending' };
    if (pageMentionsAnotherAccount(text, input.expectedAddress)) {
      throw new Error('В AdsPower-профиле выбран другой Abstract-аккаунт');
    }
    const expectedHost = new URL(expectedOrigin).hostname.toLowerCase();
    if (
      step === 'transact' &&
      /https?:\/\//i.test(text) &&
      !text.toLowerCase().includes(expectedHost)
    ) {
      throw new Error('Abstract запросил подпись для другого приложения');
    }
    if (/\b(rejected|declined|отклонено)\b/i.test(text)) {
      throw new Error('Abstract отклонил подтверждение приложения');
    }

    const approved = await clickVisibleControl(page, ['Approve', 'Confirm', 'Sign', 'Continue']);
    if (approved) {
      await delay(500);
      return { step, state: 'approved' };
    }
    if (/approving|signing|подтверждаем|подписываем/i.test(text)) {
      return { step, state: 'approved' };
    }
    return { step, state: 'pending' };
  }
  return undefined;
}
