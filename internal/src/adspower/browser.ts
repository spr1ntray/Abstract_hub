import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { DeveloperDiagnosticsBridge } from '../diagnostics/types.js';
import { muteAdsPowerPageAudio } from './audio.js';
import { sharedAdsPowerClient } from './client.js';
import type { AdsPowerConfig } from './types.js';

export interface AdsPowerPageLease {
  profileId: string;
  browser: Browser;
  page: Page;
  profileStartedByHub: boolean;
  pageCreatedByHub: boolean;
  /** Select this tab inside SunBrowser without leaving its window above the user's work. */
  activate(): Promise<void>;
  /** Close the worker tab and stop a profile that this lease started. Safe to call repeatedly. */
  release(): Promise<void>;
}

export interface OpenAdsPowerPageInput {
  config: AdsPowerConfig;
  profileId: string;
  url: string;
  /** Reuse an existing first-party tab on this origin before opening a new tab. */
  reuseOrigin?: boolean;
  /** Navigate the selected tab to `url`. Disable when the caller only needs the session. */
  navigate?: boolean;
  /** Bring the tab to the foreground. Background maintenance keeps this disabled. */
  activate?: boolean;
  /** Start a closed AdsPower profile. Background maintenance only uses active profiles. */
  startIfNeeded?: boolean;
  /** Restore tabs from the previous profile session when the Hub has to start it. */
  restoreTabs?: boolean;
  /** Show a worker profile without taking over the user's current foreground window. */
  background?: boolean;
  /** Silence this worker tab, including Unity WebAudio, before navigation starts. */
  muteAudio?: boolean;
}

interface BrowserConnection {
  browser: Browser;
  endpoint: string;
}

interface AvailableScreenBounds {
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
}

const execFileAsync = promisify(execFile);
const MAC_BUNDLE_ID = /^[a-zA-Z0-9.-]{2,200}$/;

async function macForegroundBundleId(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/osascript',
      [
        '-e',
        'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
      ],
      { timeout: 2_500 },
    );
    const bundleId = stdout.trim();
    return MAC_BUNDLE_ID.test(bundleId) ? bundleId : undefined;
  } catch {
    return undefined;
  }
}

async function restoreMacForeground(bundleId: string | undefined): Promise<void> {
  if (!bundleId || process.platform !== 'darwin') return;
  await execFileAsync(
    '/usr/bin/osascript',
    ['-e', `tell application id "${bundleId}" to activate`],
    { timeout: 2_500 },
  ).catch(() => undefined);
}

export function centeredAdsPowerWindowBounds(
  screen: AvailableScreenBounds,
  current: { width?: number; height?: number },
): { left: number; top: number; width: number; height: number; windowState: 'normal' } {
  const availableWidth = Math.max(900, screen.availWidth || 1280);
  const availableHeight = Math.max(640, screen.availHeight || 820);
  const width = Math.min(availableWidth, Math.max(900, Math.min(current.width ?? 1280, 1280)));
  const height = Math.min(availableHeight, Math.max(640, Math.min(current.height ?? 820, 820)));
  return {
    left: Math.round(screen.availLeft + (availableWidth - width) / 2),
    top: Math.round(screen.availTop + (availableHeight - height) / 2),
    width,
    height,
    windowState: 'normal',
  };
}

export class AdsPowerBrowserInactiveError extends Error {
  constructor(readonly profileId: string) {
    super(`AdsPower-профиль ${profileId} сейчас закрыт`);
    this.name = 'AdsPowerBrowserInactiveError';
  }
}

function diagnosticUrl(value: string): { origin?: string; path: string } {
  try {
    const url = new URL(value);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return { path: value.slice(0, 500) };
  }
}

export class AdsPowerBrowserController {
  private readonly connections = new Map<string, BrowserConnection>();

  constructor(private readonly diagnostics?: DeveloperDiagnosticsBridge) {}

  record(source: string, event: string, data: unknown = {}): void {
    this.diagnostics?.record(source, event, data);
  }

  private connectionKey(config: AdsPowerConfig, profileId: string): string {
    return `${config.apiUrl}|${profileId}`;
  }

  private attach(config: AdsPowerConfig, profileId: string, endpoint: string): Promise<Browser> {
    const client = sharedAdsPowerClient(config);
    const key = this.connectionKey(client.config, profileId);
    const cached = this.connections.get(key);
    if (cached?.browser.connected && cached.endpoint === endpoint) {
      return Promise.resolve(cached.browser);
    }
    if (cached?.browser.connected) cached.browser.disconnect();

    return puppeteer
      .connect({
        browserWSEndpoint: endpoint,
        defaultViewport: null,
        protocolTimeout: 120_000,
      })
      .then((browser) => {
        const connection = { browser, endpoint };
        this.connections.set(key, connection);
        browser.once('disconnected', () => {
          if (this.connections.get(key) === connection) this.connections.delete(key);
          this.diagnostics?.record('adspower', 'browser_disconnected', { profileId });
        });
        this.diagnostics?.record('adspower', 'browser_connected', { profileId });
        return browser;
      });
  }

  async connect(
    config: AdsPowerConfig,
    profileId: string,
    options: { startIfNeeded?: boolean; restoreTabs?: boolean; background?: boolean } = {},
  ): Promise<Browser> {
    return (
      await this.connectWithOwnership(config, profileId, {
        ...options,
      })
    ).browser;
  }

  private async connectWithOwnership(
    config: AdsPowerConfig,
    profileId: string,
    options: { startIfNeeded?: boolean; restoreTabs?: boolean; background?: boolean } = {},
  ): Promise<{ browser: Browser; profileStartedByHub: boolean }> {
    const client = sharedAdsPowerClient(config);
    const current = await client.browserStatus(profileId);
    if (current.status === 'Active' && current.puppeteerWs) {
      return {
        browser: await this.attach(client.config, profileId, current.puppeteerWs),
        profileStartedByHub: false,
      };
    }
    if (options.startIfNeeded === false) throw new AdsPowerBrowserInactiveError(profileId);
    const foregroundBundleId = options.background ? await macForegroundBundleId() : undefined;
    try {
      const endpoint = await client.startBrowser(profileId, {
        ...(options.restoreTabs !== undefined ? { restoreTabs: options.restoreTabs } : {}),
        ...(options.background !== undefined ? { background: options.background } : {}),
      });
      if (!endpoint.puppeteerWs) {
        throw new Error('AdsPower не вернул CDP-интерфейс профиля');
      }
      const browser = await this.attach(client.config, profileId, endpoint.puppeteerWs);
      if (options.background) {
        const firstPage = (await browser.pages())[0];
        if (firstPage) await this.showWorkerWindowInBackground(firstPage, profileId);
      }
      return {
        browser,
        profileStartedByHub: true,
      };
    } finally {
      await restoreMacForeground(foregroundBundleId);
      if (foregroundBundleId) {
        this.diagnostics?.record('adspower', 'foreground_application_restored', {
          profileId,
          bundleId: foregroundBundleId,
        });
      }
    }
  }

  private async showWorkerWindowInBackground(page: Page, profileId: string): Promise<void> {
    const session = await page.createCDPSession();
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget');
      const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
      const screen = (await page.evaluate(`({
        availLeft: screen.availLeft,
        availTop: screen.availTop,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight
      })`)) as AvailableScreenBounds;
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: centeredAdsPowerWindowBounds(screen, bounds),
      });
      this.diagnostics?.record('adspower', 'worker_window_shown_in_background', { profileId });
    } catch (error) {
      this.diagnostics?.record('adspower', 'worker_window_position_failed', {
        profileId,
        error,
      });
    } finally {
      await session.detach().catch(() => undefined);
    }
  }

  private async stopProfile(config: AdsPowerConfig, profileId: string): Promise<void> {
    const client = sharedAdsPowerClient(config);
    const key = this.connectionKey(client.config, profileId);
    const connection = this.connections.get(key);
    if (connection) {
      this.connections.delete(key);
      if (connection.browser.connected) connection.browser.disconnect();
    }
    await client.stopBrowser(profileId);
    this.diagnostics?.record('adspower', 'profile_stopped', { profileId });
  }

  private async activateWorkerTab(
    page: Page,
    profileId: string,
    background: boolean,
  ): Promise<void> {
    const foregroundBundleId = background ? await macForegroundBundleId() : undefined;
    try {
      await page.bringToFront();
      const pageState = (await page
        .evaluate(
          `({
          visibility: document.visibilityState,
          hasFocus: document.hasFocus()
        })`,
        )
        .catch(() => ({ visibility: 'unknown', hasFocus: false }))) as {
        visibility: string;
        hasFocus: boolean;
      };
      this.diagnostics?.record('adspower', 'worker_tab_activated', {
        profileId,
        ...pageState,
      });
    } finally {
      await restoreMacForeground(foregroundBundleId);
      if (foregroundBundleId) {
        this.diagnostics?.record('adspower', 'foreground_application_restored', {
          profileId,
          bundleId: foregroundBundleId,
          after: 'tab-activation',
        });
      }
    }
  }

  async openPage(input: OpenAdsPowerPageInput): Promise<AdsPowerPageLease> {
    const target = new URL(input.url);
    const connection = await this.connectWithOwnership(input.config, input.profileId, {
      ...(input.startIfNeeded !== undefined ? { startIfNeeded: input.startIfNeeded } : {}),
      ...(input.restoreTabs !== undefined ? { restoreTabs: input.restoreTabs } : {}),
      ...(input.background !== undefined ? { background: input.background } : {}),
    });
    const foregroundBundleId = input.background ? await macForegroundBundleId() : undefined;
    const { browser, profileStartedByHub } = connection;
    let page: Page | undefined;
    let pageCreatedByHub = false;
    try {
      const pages = await browser.pages();
      page =
        input.reuseOrigin === false
          ? undefined
          : pages.find((candidate) => {
              try {
                return new URL(candidate.url()).origin === target.origin;
              } catch {
                return false;
              }
            });
      if (!page) {
        page = await browser.newPage();
        pageCreatedByHub = true;
      }
      if (input.muteAudio) await muteAdsPowerPageAudio(page);
      if (input.navigate !== false && page.url() !== target.href) {
        await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      }
      if (input.activate !== false) await page.bringToFront();
      this.diagnostics?.record('adspower', 'page_ready', {
        profileId: input.profileId,
        url: diagnosticUrl(page.url()),
        pageCreatedByHub,
        profileStartedByHub,
        muted: input.muteAudio === true,
      });
    } catch (error) {
      if (pageCreatedByHub && page && !page.isClosed()) {
        await page.close({ runBeforeUnload: false }).catch(() => undefined);
      }
      if (profileStartedByHub) {
        await this.stopProfile(input.config, input.profileId).catch(() => undefined);
      }
      throw error;
    } finally {
      await restoreMacForeground(foregroundBundleId);
      if (foregroundBundleId) {
        this.diagnostics?.record('adspower', 'foreground_application_restored', {
          profileId: input.profileId,
          bundleId: foregroundBundleId,
          after: 'page-open',
        });
      }
    }

    let released = false;
    const workerPage = page;
    return {
      profileId: input.profileId,
      browser,
      page: workerPage,
      profileStartedByHub,
      pageCreatedByHub,
      activate: async () => {
        if (workerPage.isClosed()) throw new Error('Рабочая вкладка AdsPower уже закрыта');
        await this.activateWorkerTab(workerPage, input.profileId, input.background === true);
      },
      release: async () => {
        if (released) return;
        released = true;
        try {
          if (pageCreatedByHub && !workerPage.isClosed()) {
            await workerPage.close({ runBeforeUnload: false });
            this.diagnostics?.record('adspower', 'worker_page_closed', {
              profileId: input.profileId,
            });
          }
        } finally {
          if (profileStartedByHub) await this.stopProfile(input.config, input.profileId);
        }
      },
    };
  }

  dispose(): void {
    for (const { browser } of this.connections.values()) {
      if (browser.connected) browser.disconnect();
    }
    this.connections.clear();
  }
}
