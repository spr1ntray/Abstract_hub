import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { request } from 'undici';
import { z } from 'zod';

const DEFAULT_PACK_URL =
  'https://raw.githubusercontent.com/spr1ntray/Abstract_hub/main/hub-pack.json';
const DEFAULT_RELEASE_URL = 'https://api.github.com/repos/spr1ntray/Abstract_hub/releases/latest';
const MAX_REMOTE_BYTES = 256 * 1024;

const SafeItemIdSchema = z.number().int().positive().max(10_000);

export const HubPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    packVersion: z.string().regex(/^\d{4}\.\d{2}\.\d{2}\.\d+$/),
    minimumCoreVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    publishedAt: z.iso.datetime(),
    modules: z
      .object({
        abstractDiscover: z
          .object({
            apiBase: z.literal('https://backend.portal.abs.xyz'),
            portalUrl: z.literal('https://portal.abs.xyz/discover'),
            voteContract: z.literal('0x3B50dE27506f0a8C1f4122A1e6F470009a76ce2A'),
            appsLimit: z.number().int().min(1).max(100),
          })
          .strict(),
        abstractBadges: z
          .object({
            apiBase: z.literal('https://backend.portal.abs.xyz'),
            rewardsUrl: z.literal('https://portal.abs.xyz/rewards'),
            badgeContract: z.literal('0xAC5f79757A785579b9C593018efD6AB27cF8821F'),
            privyApiBase: z.literal('https://privy.abs.xyz'),
            privyAppId: z.literal('cm04asygd041fmry9zmcyn5o5'),
            privyClientId: z.literal('client-WY5amHUxxFHMHHMmPJvBQgGPJQ1WuMFjP57qUmHcbu4g2'),
            privyClient: z.string().regex(/^react-auth:\d+\.\d+\.\d+$/),
            flash: z
              .object({
                id: z.number().int().positive().max(100_000),
                name: z.string().min(1).max(128),
                requirement: z.string().min(1).max(512),
                startsAt: z.iso.datetime(),
                endsAt: z.iso.datetime(),
                action: z.literal('gigaverse_racing_consumable'),
              })
              .strict(),
          })
          .strict(),
        gigaverse: z
          .object({
            homeUrl: z.literal('https://gigaverse.io'),
            marketplaceUrl: z.literal('https://gigaverse.io/marketplace'),
            racingUrl: z.literal('https://gigaverse.io/racing'),
            racing: z
              .object({
                livePhase: z.literal(2),
                genericButterflyItemId: SafeItemIdSchema,
                genericDungItemId: SafeItemIdSchema,
                butterflyItemIds: z.array(SafeItemIdSchema).min(1).max(32),
                dungItemIds: z.array(SafeItemIdSchema).min(1).max(32),
              })
              .strict(),
          })
          .strict(),
        cambria: z
          .object({
            lobbyUrl: z.literal('https://lobby.cambria.gg'),
            apiBase: z.literal('https://lobby-api.cambria.gg'),
            privyApiBase: z.literal('https://privy.cambria.gg'),
            privyAppId: z.literal('clrdyxkq5018ml90fcw61h764'),
            privyClient: z.string().regex(/^react-auth:\d+\.\d+\.\d+$/),
          })
          .strict(),
        tollan: z
          .object({
            hubUrl: z.literal('https://hub.tollan.io/'),
            routes: z
              .object({
                missions: z.literal('/missions/daily'),
                inventory: z.literal('/inventory/items'),
                store: z.literal('/store'),
                practice: z.literal('/game/practice'),
              })
              .strict(),
            auth: z
              .object({
                nonceActionId: z.string().regex(/^[a-f0-9]{40}$/),
                loginActionId: z.string().regex(/^[a-f0-9]{40}$/),
                initializeActionId: z.string().regex(/^[a-f0-9]{40}$/),
                storeModuleId: z.number().int().positive().max(1_000_000),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type HubPack = z.infer<typeof HubPackSchema>;

export interface HubPackStatus {
  coreVersion: string;
  packVersion: string;
  packSource: 'bundled' | 'installed';
  publishedAt: string;
  canRollback: boolean;
  remotePackUrl: string;
  releaseUrl: string;
  pendingPackVersion?: string;
  latestCoreVersion?: string;
  coreUpdateAvailable?: boolean;
  warning?: string;
}

export interface HubPackManagerOptions {
  appRoot: string;
  dataDir: string;
  remotePackUrl?: string;
  releaseApiUrl?: string;
  fetchText?: (url: string) => Promise<string>;
}

function numericVersionParts(value: string): number[] {
  const match = value.replace(/^v/, '').match(/\d+/g);
  return match?.map(Number) ?? [0];
}

export function compareVersions(left: string, right: string): number {
  const a = numericVersionParts(left);
  const b = numericVersionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function parsePack(raw: string, label: string): HubPack {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label}: некорректный JSON`, { cause: error });
  }
  const parsed = HubPackSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label}: пакет не прошёл проверку схемы`);
  }
  return parsed.data;
}

async function fetchText(url: string): Promise<string> {
  const response = await request(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': 'Abstract-Hub-Updater',
    },
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    await response.body.dump();
    throw new Error(`HTTP ${response.statusCode}`);
  }
  const length = Number(response.headers['content-length'] ?? 0);
  if (Number.isFinite(length) && length > MAX_REMOTE_BYTES) {
    await response.body.dump();
    throw new Error('удалённый пакет слишком большой');
  }
  const text = await response.body.text();
  if (Buffer.byteLength(text) > MAX_REMOTE_BYTES) {
    throw new Error('удалённый пакет слишком большой');
  }
  return text;
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporaryPath, text, { mode: 0o600, flag: 'wx' });
  renameSync(temporaryPath, path);
}

export class HubPackManager {
  private readonly bundledPath: string;
  private readonly installedPath: string;
  private readonly previousPath: string;
  private readonly packagePath: string;
  private readonly remotePackUrl: string;
  private readonly releaseApiUrl: string;
  private readonly fetchText: (url: string) => Promise<string>;
  private pendingPack: HubPack | undefined;
  private latestCoreVersion: string | undefined;
  private warning: string | undefined;

  constructor(options: HubPackManagerOptions) {
    const sourcePackPath = resolve(options.appRoot, 'hub-pack.json');
    const builtPackPath = resolve(options.appRoot, 'dist', 'hub-pack.json');
    // Source runs should always see the checked-in pack even when a stale dist/
    // directory exists. Packaged apps contain only the copied dist asset.
    this.bundledPath = existsSync(sourcePackPath) ? sourcePackPath : builtPackPath;
    this.installedPath = resolve(options.dataDir, 'hub-updates', 'hub-pack.json');
    this.previousPath = resolve(options.dataDir, 'hub-updates', 'hub-pack.previous.json');
    this.packagePath = resolve(options.appRoot, 'package.json');
    this.remotePackUrl =
      options.remotePackUrl ?? process.env['ABSTRACT_HUB_PACK_URL'] ?? DEFAULT_PACK_URL;
    this.releaseApiUrl =
      options.releaseApiUrl ?? process.env['ABSTRACT_HUB_RELEASE_API_URL'] ?? DEFAULT_RELEASE_URL;
    this.fetchText = options.fetchText ?? fetchText;
  }

  coreVersion(): string {
    try {
      const parsed = JSON.parse(readFileSync(this.packagePath, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      // Packaged tests can inject a minimal appRoot without package.json.
    }
    return '0.0.0';
  }

  load(): { pack: HubPack; source: 'bundled' | 'installed' } {
    const bundled = parsePack(readFileSync(this.bundledPath, 'utf8'), 'Встроенный пакет');
    if (!existsSync(this.installedPath)) return { pack: bundled, source: 'bundled' };
    try {
      const installed = parsePack(readFileSync(this.installedPath, 'utf8'), 'Установленный пакет');
      if (
        compareVersions(installed.minimumCoreVersion, this.coreVersion()) <= 0 &&
        compareVersions(installed.packVersion, bundled.packVersion) >= 0
      ) {
        return { pack: installed, source: 'installed' };
      }
    } catch (error) {
      this.warning = error instanceof Error ? error.message : String(error);
    }
    return { pack: bundled, source: 'bundled' };
  }

  status(): HubPackStatus {
    const { pack, source } = this.load();
    const coreVersion = this.coreVersion();
    return {
      coreVersion,
      packVersion: pack.packVersion,
      packSource: source,
      publishedAt: pack.publishedAt,
      canRollback: existsSync(this.previousPath),
      remotePackUrl: this.remotePackUrl,
      releaseUrl: 'https://github.com/spr1ntray/Abstract_hub/releases/latest',
      ...(this.pendingPack ? { pendingPackVersion: this.pendingPack.packVersion } : {}),
      ...(this.latestCoreVersion ? { latestCoreVersion: this.latestCoreVersion } : {}),
      ...(this.latestCoreVersion
        ? { coreUpdateAvailable: compareVersions(this.latestCoreVersion, coreVersion) > 0 }
        : {}),
      ...(this.warning ? { warning: this.warning } : {}),
    };
  }

  async check(): Promise<HubPackStatus> {
    this.warning = undefined;
    const current = this.load().pack;
    const [packResult, releaseResult] = await Promise.allSettled([
      this.fetchText(this.remotePackUrl),
      this.fetchText(this.releaseApiUrl),
    ]);

    if (packResult.status === 'fulfilled') {
      const candidate = parsePack(packResult.value, 'Удалённый пакет');
      if (compareVersions(candidate.minimumCoreVersion, this.coreVersion()) > 0) {
        this.pendingPack = undefined;
        this.warning = `Пакет ${candidate.packVersion} требует Abstract Hub ${candidate.minimumCoreVersion}`;
      } else if (compareVersions(candidate.packVersion, current.packVersion) > 0) {
        this.pendingPack = candidate;
      } else {
        this.pendingPack = undefined;
      }
    } else {
      const detail =
        packResult.reason instanceof Error ? packResult.reason.message : String(packResult.reason);
      this.pendingPack = undefined;
      // A repository may intentionally ship only the bundled pack until the
      // first hot update is published. In that state the bundled pack is the
      // current version, not a failed update.
      if (detail !== 'HTTP 404') this.warning = `Data-pack пока недоступен: ${detail}`;
    }

    if (releaseResult.status === 'fulfilled') {
      try {
        const release = JSON.parse(releaseResult.value) as { tag_name?: unknown };
        if (typeof release.tag_name === 'string') {
          this.latestCoreVersion = release.tag_name.replace(/^v/, '');
        }
      } catch {
        this.warning ??= 'Не удалось прочитать версию последнего релиза';
      }
    }
    return this.status();
  }

  installPending(): HubPackStatus {
    if (!this.pendingPack) throw new Error('Нового data-pack для установки нет');
    const current = this.load().pack;
    atomicWrite(this.previousPath, `${JSON.stringify(current, null, 2)}\n`);
    atomicWrite(this.installedPath, `${JSON.stringify(this.pendingPack, null, 2)}\n`);
    this.pendingPack = undefined;
    return this.status();
  }

  rollback(): HubPackStatus {
    if (!existsSync(this.previousPath)) throw new Error('Предыдущего data-pack нет');
    if (existsSync(this.installedPath)) {
      const swapPath = `${this.installedPath}.swap`;
      copyFileSync(this.installedPath, swapPath);
      copyFileSync(this.previousPath, this.installedPath);
      renameSync(swapPath, this.previousPath);
    } else {
      copyFileSync(this.previousPath, this.installedPath);
    }
    this.pendingPack = undefined;
    return this.status();
  }
}
