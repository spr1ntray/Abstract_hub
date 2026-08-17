import { createHash } from 'node:crypto';
import type { AdsPowerBrowserEndpoint, AdsPowerConfig, AdsPowerProfile } from './types.js';

const DEFAULT_API_URL = 'http://127.0.0.1:50325';
const DEFAULT_REQUEST_INTERVAL_MS = 1_050;
const DEFAULT_TIMEOUT_MS = 20_000;
const PROFILE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

interface AdsPowerEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

interface AdsPowerWsData {
  ws?: {
    puppeteer?: string;
    selenium?: string;
  };
  status?: string;
  debug_port?: string | number;
  webdriver?: string;
}

interface AdsPowerProfileListData {
  list?: Array<{
    user_id?: string;
    serial_number?: string | number;
    name?: string;
    group_id?: string | number;
    group_name?: string;
    last_open_time?: string | number;
  }>;
  page?: number;
  page_size?: number;
}

const BACKGROUND_BROWSER_LAUNCH_ARGS = [
  '--start-minimized',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
] as const;

export class AdsPowerApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AdsPowerApiError';
  }
}

export function normalizeAdsPowerApiUrl(value?: string): string {
  const raw = value?.trim() || DEFAULT_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AdsPowerApiError('Некорректный адрес AdsPower Local API');
  }
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', 'local.adspower.net']);
  if (parsed.protocol !== 'http:' || !allowedHosts.has(parsed.hostname) || parsed.username) {
    throw new AdsPowerApiError('AdsPower Local API должен быть локальным HTTP-адресом');
  }
  if (parsed.password || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new AdsPowerApiError('Укажите только базовый адрес AdsPower Local API без пути');
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function normalizeAdsPowerProfileId(value: string): string {
  const normalized = value.trim();
  if (!PROFILE_ID.test(normalized)) {
    throw new AdsPowerApiError('Некорректный внутренний ID профиля AdsPower');
  }
  return normalized;
}

export function normalizeAdsPowerConfig(config: AdsPowerConfig): AdsPowerConfig {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new AdsPowerApiError('Укажите API key AdsPower');
  return { apiUrl: normalizeAdsPowerApiUrl(config.apiUrl), apiKey };
}

export class AdsPowerClient {
  readonly config: AdsPowerConfig;
  private requestQueue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(
    config: AdsPowerConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS,
  ) {
    this.config = normalizeAdsPowerConfig(config);
  }

  private async scheduled<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.requestQueue;
    let release: () => void = () => undefined;
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.lastRequestAt + this.requestIntervalMs - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.lastRequestAt = Date.now();
      return await operation();
    } finally {
      release();
    }
  }

  private async request<T>(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<T> {
    return await this.scheduled(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(`${this.config.apiUrl}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: controller.signal,
        });
        const text = await response.text();
        let envelope: AdsPowerEnvelope<T>;
        try {
          envelope = JSON.parse(text) as AdsPowerEnvelope<T>;
        } catch {
          throw new AdsPowerApiError(
            `AdsPower вернул некорректный ответ (HTTP ${response.status})`,
            undefined,
            response.status,
          );
        }
        if (!response.ok || envelope.code !== 0) {
          throw new AdsPowerApiError(
            envelope.msg?.trim() || `AdsPower Local API: HTTP ${response.status}`,
            envelope.code,
            response.status,
          );
        }
        return envelope.data as T;
      } catch (error) {
        if (error instanceof AdsPowerApiError) throw error;
        if (error instanceof Error && error.name === 'AbortError') {
          throw new AdsPowerApiError('AdsPower Local API не ответил за 20 секунд');
        }
        throw new AdsPowerApiError(
          `Не удалось подключиться к AdsPower Local API: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async status(): Promise<void> {
    await this.request<Record<string, never>>('/status');
  }

  async listProfiles(): Promise<AdsPowerProfile[]> {
    const data = await this.request<AdsPowerProfileListData>(
      '/api/v1/user/list?page=1&page_size=100',
    );
    return (data?.list ?? []).flatMap((entry) => {
      const id = entry.user_id?.trim();
      if (!id || !PROFILE_ID.test(id)) return [];
      const lastOpenTime = Number(entry.last_open_time);
      return [
        {
          id,
          serialNumber: String(entry.serial_number ?? ''),
          name: entry.name?.trim() || `Profile ${entry.serial_number ?? id}`,
          groupId: String(entry.group_id ?? ''),
          groupName: entry.group_name?.trim() || '',
          ...(Number.isFinite(lastOpenTime) && lastOpenTime > 0 ? { lastOpenTime } : {}),
        },
      ];
    });
  }

  async browserStatus(profileId: string): Promise<AdsPowerBrowserEndpoint> {
    const id = normalizeAdsPowerProfileId(profileId);
    const data = await this.request<AdsPowerWsData>(
      `/api/v1/browser/active?user_id=${encodeURIComponent(id)}`,
    );
    return this.browserEndpoint(id, data);
  }

  async startBrowser(
    profileId: string,
    options: { restoreTabs?: boolean; background?: boolean } = {},
  ): Promise<AdsPowerBrowserEndpoint> {
    const id = normalizeAdsPowerProfileId(profileId);
    const current = await this.browserStatus(id);
    if (current.status === 'Active' && current.puppeteerWs) return current;
    const data = await this.request<AdsPowerWsData>('/api/v2/browser-profile/start', {
      method: 'POST',
      body: {
        profile_id: id,
        headless: '0',
        last_opened_tabs: options.restoreTabs === false ? '0' : '1',
        proxy_detection: '0',
        cdp_mask: '1',
        ...(options.background ? { launch_args: [...BACKGROUND_BROWSER_LAUNCH_ARGS] } : {}),
      },
    });
    const endpoint = this.browserEndpoint(id, { ...data, status: 'Active' });
    if (!endpoint.puppeteerWs) {
      throw new AdsPowerApiError('AdsPower открыл профиль, но не вернул CDP-интерфейс');
    }
    return endpoint;
  }

  async stopBrowser(profileId: string): Promise<void> {
    const id = normalizeAdsPowerProfileId(profileId);
    await this.request<Record<string, never>>('/api/v2/browser-profile/stop', {
      method: 'POST',
      body: { profile_id: id },
    });
  }

  private browserEndpoint(profileId: string, data?: AdsPowerWsData): AdsPowerBrowserEndpoint {
    const status = data?.status === 'Active' || data?.ws?.puppeteer ? 'Active' : 'Inactive';
    return {
      profileId,
      status,
      ...(data?.ws?.puppeteer ? { puppeteerWs: data.ws.puppeteer } : {}),
      ...(data?.ws?.selenium ? { seleniumAddress: data.ws.selenium } : {}),
      ...(data?.debug_port !== undefined ? { debugPort: String(data.debug_port) } : {}),
      ...(data?.webdriver ? { webdriverPath: data.webdriver } : {}),
    };
  }
}

const sharedClients = new Map<string, AdsPowerClient>();

export function sharedAdsPowerClient(config: AdsPowerConfig): AdsPowerClient {
  const normalized = normalizeAdsPowerConfig(config);
  const keyHash = createHash('sha256').update(normalized.apiKey).digest('hex');
  const cacheKey = `${normalized.apiUrl}|${keyHash}`;
  const current = sharedClients.get(cacheKey);
  if (current) return current;
  const client = new AdsPowerClient(normalized);
  sharedClients.set(cacheKey, client);
  return client;
}
