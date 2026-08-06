/**
 * Abstract Hub UI — localhost Express server.
 *
 * Starts on port 3737, serves the static HTML/JS/CSS interface, and exposes
 * REST + SSE endpoints that the browser uses to drive play.ts as a child
 * process without the user ever touching a terminal.
 *
 * Port choice: 3737 is arbitrary but unlikely to conflict with common dev
 * servers (3000/3001/5173/8080).
 */

import express, { type Request, type Response } from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import open from 'open';
import { parseEther, type Address } from 'viem';
import {
  decryptToMemory,
  hasEncrypted,
  saveEncryptedBundle,
  type SecretsBundle,
} from '../config/encrypted-files.js';
import {
  loadTimingConfig,
  saveTimingConfig,
  validateTimingConfig,
  type TimingConfig,
} from '../timing-config.js';
import { migrateLegacyJwtAccountsText, parseAccountsFromText } from '../config/load-from-files.js';
import {
  buildCatalog,
  buildGearConditionCatalog,
  enrichCatalogWithMetadata,
  extractAccountDisplayInfo,
  extractBalanceList,
  extractGearList,
  mergeCatalogs,
  tallyItems,
} from '../inventory.js';
import { GigaClient } from '../api/client.js';
import { HttpError, SessionExpiredError } from '../api/errors.js';
import { resolveAccountSession } from '../api/account-session.js';
import {
  hydrateAccountGameSession,
  parseBrowserGameSession,
  storedGameSessionForAccount,
  upsertStoredGameSession,
  type StoredGameSession,
} from '../api/browser-session.js';
import {
  connectDelegatedAgw,
  inspectDelegatedAgw,
  makeDelegatedAgwLoginSigner,
  revokeDelegatedAgw,
  type AgwCliRunner,
  type AgwCliRuntimeOptions,
  type DelegatedAgwAvailability,
} from '../wallet/agw-delegated.js';
import { resolveMarketplaceSigner } from '../wallet/marketplace-signer.js';
import { createLogger } from '../logger.js';
import { parseSkillCatalog, parseSkillProgress, currentStatLevel } from '../skills/parse.js';
import {
  pickNextUpgrade,
  applyUpgradeLocally,
  STAT_NAMES_RU,
  DEFAULT_ALLOWED_SKILLS,
  DEFAULT_ALLOWED_STATS,
} from '../skills/strategy.js';
import { runSkillUpgradeLoop } from '../skills/upgrade-loop.js';
import type { StatId } from '../skills/types.js';
import { extractNoobTokenId } from '../api/noob-id.js';
import { classifyLogLine } from './log-classifier.js';
import { keychainClear, keychainLoad, keychainSave } from '../security/keychain.js';
import {
  AbstractCallbackError,
  bridgeAbstractApprovalUrl,
  buildAbstractCallbackTarget,
} from './abstract-callback.js';
import {
  computeListPrice,
  isProtectedMarketItem,
  protectedMarketItemName,
} from '../marketplace/pricing.js';
import {
  ManualListingValidationError,
  prepareManualListings,
  type ManualListingPricing,
  type ManualListingSelection,
} from '../marketplace/manual-listing.js';
import { listOne } from '../marketplace/lister.js';
import { buyCheapestItem, findCheapestItemListing } from '../marketplace/buyer.js';
import { ITEM_MARKET_ADDRESS } from '../marketplace/abi.js';
import type { Account } from '../vault/schema.js';
import { makeProxyAgent } from '../wallet/proxy-agent.js';
import {
  buildDiscoverVoteCall,
  DiscoverClient,
  makeDiscoverTransport,
  pickRandomDiscoverApp,
} from '../abstract/discover.js';
import { HubPackManager, type HubPack } from '../hub/pack.js';
import { BadgeActionStore } from '../badges/state.js';
import {
  assertRacingItemAccepted,
  buildRacingLobbySyncRequest,
  extractLiveRaces,
  findLiveRacingTarget,
  makePortalBadgeTransport,
  PortalBadgeClient,
  RacingActionNotAppliedError,
  resolvePendingRacingAction,
  summarizeRacingInventory,
  verifyFlashCampaign,
  watchRacingItemApplication,
  type PortalFlashBadge,
} from '../badges/gigling-racing.js';
import {
  makePortalClaimTransport,
  mintPortalBadge,
  PortalBadgeClaimClient,
  PortalBadgeClaimError,
  type PortalAuthSession,
} from '../badges/portal-claim.js';
import {
  CAMBRIA_TURNSTILE_SITE_KEY,
  CambriaApiError,
  CambriaClient,
  CambriaInviteRequiredError,
  CambriaVerificationRequiredError,
  makeCambriaTransport,
} from '../cambria/client.js';
import { resolveCapsolverApiKey, solveTurnstile } from '../api/captcha.js';
import type {
  CambriaBrowserContext,
  CambriaBrowserSessionBridge,
} from '../cambria/browser-session.js';
import {
  loginTollan,
  requestTollanNonce,
  storedTollanSessionForAddress,
  upsertStoredTollanSession,
  type StoredTollanSession,
} from '../tollan/auth.js';
import type {
  TollanBrowserRunInput,
  TollanBrowserSessionBridge,
} from '../tollan/browser-session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3737;
const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_SKILLS_MAX_UPGRADES = 10;
const MAX_SKILLS_MAX_UPGRADES = 50;
const SKILLS_RUN_TIME_LIMIT_MS = 90_000;
const ABSTRACT_AUTH_TIMEOUT_MS = 8 * 60_000;
const ABSTRACT_CALLBACK_FORWARD_TIMEOUT_MS = 10_000;
const BROWSER_GAME_AUTH_TIMEOUT_MS = 10 * 60_000;
const BROWSER_GAME_SESSION_MIN_TTL_MS = 30 * 60_000;
const DISCOVER_MAINTENANCE_INTERVAL_MS = 15 * 60_000;
const DISCOVER_MAINTENANCE_STALE_MS = 5 * 60_000;
const DEFAULT_RACING_BADGE_MAX_SPEND_WEI = parseEther('0.00005');
const MAX_RACING_BADGE_MAX_SPEND_WEI = parseEther('0.01');
/** Portal often needs several minutes after Gigaverse verifies the racing action. */
const PORTAL_BADGE_INDEXING_DELAY_MS = 120_000;
const PORTAL_BADGE_SNAPSHOT_CACHE_MS = 10_000;
const PORTAL_BADGE_CLAIM_GAP_MS = 60_000;
const RACING_BADGE_TERMINAL_SNAPSHOT_MS = 15_000;
/** Space multi-account Cambria calls — Privy + lobby-api share tight IP limits. */
const CAMBRIA_ACCOUNT_GAP_MS = 45_000;
const CAMBRIA_RATE_LIMIT_FLOOR_MS = 3 * 60_000;
const PORTAL_RATE_LIMIT_FLOOR_MS = 5 * 60_000;

/** Process-wide cooldowns so recovery timers cannot re-hammer a hot IP/account. */
const cambriaRateLimitedUntil = new Map<string, number>();
const portalRateLimitedUntil = new Map<string, number>();

function noteCambriaRateLimit(address: string | undefined, retryAfterMs?: number): void {
  if (!address) return;
  const wait = Math.max(CAMBRIA_RATE_LIMIT_FLOOR_MS, retryAfterMs ?? CAMBRIA_RATE_LIMIT_FLOOR_MS);
  const key = address.toLowerCase();
  const until = Date.now() + wait;
  const previous = cambriaRateLimitedUntil.get(key) ?? 0;
  if (until > previous) cambriaRateLimitedUntil.set(key, until);
}

function cambriaCooldownRemaining(address: string | undefined): number {
  if (!address) return 0;
  return Math.max(0, (cambriaRateLimitedUntil.get(address.toLowerCase()) ?? 0) - Date.now());
}

function notePortalRateLimit(address: string | undefined, retryAfterMs?: number): void {
  if (!address) return;
  const wait = Math.max(PORTAL_RATE_LIMIT_FLOOR_MS, retryAfterMs ?? PORTAL_RATE_LIMIT_FLOOR_MS);
  const key = address.toLowerCase();
  const until = Date.now() + wait;
  const previous = portalRateLimitedUntil.get(key) ?? 0;
  if (until > previous) portalRateLimitedUntil.set(key, until);
}

function portalCooldownRemaining(address: string | undefined): number {
  if (!address) return 0;
  return Math.max(0, (portalRateLimitedUntil.get(address.toLowerCase()) ?? 0) - Date.now());
}

export interface UiServerOptions {
  /** Use 0 to let the OS choose a free port (desktop mode). */
  port?: number;
  host?: string;
  dataDir?: string;
  appRoot?: string;
  desktop?: boolean;
  openBrowser?: boolean;
  /** Desktop dev can use system Node; packaged builds use Electron as Node. */
  childCommand?: string;
  electronRunAsNode?: boolean;
  /** Dependency injection for callback-flow tests. */
  agwCliRunner?: AgwCliRunner;
  /** Persistent session populated by Cambria's external Chromium flow. */
  cambriaBrowser?: CambriaBrowserSessionBridge;
  /** Official Tollan WebGL runner hosted by Electron. */
  tollanBrowser?: TollanBrowserSessionBridge;
  /** Dependency injection for the combined browser auth flow. */
  tollanRequestNonce?: typeof requestTollanNonce;
  tollanLogin?: typeof loginTollan;
}

export interface UiServerHandle {
  server: Server;
  url: string;
  stop: () => Promise<void>;
}

interface UiRuntime {
  dataDir: string;
  appRoot: string;
  desktop: boolean;
  childCommand?: string;
  electronRunAsNode: boolean;
  agwCliRunner?: AgwCliRunner;
  cambriaBrowser?: CambriaBrowserSessionBridge;
  tollanBrowser?: TollanBrowserSessionBridge;
  tollanRequestNonce: typeof requestTollanNonce;
  tollanLogin: typeof loginTollan;
}

function resolveRuntime(options: UiServerOptions = {}): UiRuntime {
  const childCommand = options.childCommand ?? process.env['GIGABOT_CHILD_COMMAND'];
  return {
    dataDir: resolve(options.dataDir ?? process.env['GIGABOT_DATA_DIR'] ?? '.'),
    appRoot: resolve(options.appRoot ?? process.env['GIGABOT_APP_ROOT'] ?? '.'),
    desktop: options.desktop ?? process.env['GIGABOT_DESKTOP'] === '1',
    ...(childCommand ? { childCommand } : {}),
    electronRunAsNode:
      options.electronRunAsNode ?? process.env['GIGABOT_ELECTRON_RUN_AS_NODE'] === '1',
    ...(options.agwCliRunner ? { agwCliRunner: options.agwCliRunner } : {}),
    ...(options.cambriaBrowser ? { cambriaBrowser: options.cambriaBrowser } : {}),
    ...(options.tollanBrowser ? { tollanBrowser: options.tollanBrowser } : {}),
    tollanRequestNonce: options.tollanRequestNonce ?? requestTollanNonce,
    tollanLogin: options.tollanLogin ?? loginTollan,
  };
}

let runtime = resolveRuntime();
const pendingGameSessions = new Map<string, StoredGameSession>();
const pendingTollanSessions = new Map<string, StoredTollanSession>();
const knownAccountDisplayNames = new Map<string, string>();
let activeHubPackManager: HubPackManager | undefined;
const activeRacingBadgeActions = new Set<string>();
interface RacingBadgeJob {
  controller: AbortController;
  promise: Promise<void>;
  running: boolean;
  snapshot: Record<string, unknown>;
  updatedAt: number;
}
const activeRacingBadgeJobs = new Map<string, RacingBadgeJob>();
interface PortalBadgeSnapshot {
  claimed: boolean;
  current?: PortalFlashBadge;
}
interface PortalBadgeSnapshotCacheEntry {
  expiresAt: number;
  promise: Promise<PortalBadgeSnapshot>;
}
const portalBadgeSnapshotCache = new Map<string, PortalBadgeSnapshotCacheEntry>();
const portalAuthSessions = new Map<string, PortalAuthSession>();
let portalBadgeClaimQueue: Promise<void> = Promise.resolve();
let portalBadgeClaimLastStartedAt = 0;
let unlockedMasterPassword: string | undefined;
let vaultSessionToken: string | undefined;
const VAULT_SESSION_COOKIE = 'abstract_hub_vault';
const VAULT_SESSION_MARKER = '__abstract_hub_vault_session__';
let discoverMaintenanceTimer: ReturnType<typeof setInterval> | undefined;
let discoverMaintenanceKick: ReturnType<typeof setTimeout> | undefined;

function rememberAccountDisplayName(
  account: Pick<Account, 'name' | 'agwAddress'>,
  displayName: string,
): void {
  const normalized = displayName.trim();
  const address = account.agwAddress?.toLowerCase();
  if (
    !address ||
    !normalized ||
    normalized === account.name ||
    /^0x[a-f0-9]{40}$/i.test(normalized)
  ) {
    return;
  }
  knownAccountDisplayNames.set(address, normalized);
}

function rememberBundleAccountDisplayNames(
  bundle: SecretsBundle,
  loaded: ReturnType<typeof parseAccountsFromText>,
): void {
  for (const { account } of loaded) {
    const address = account.agwAddress?.toLowerCase();
    if (!address) continue;
    const gameSession = bundle.gameSessions?.[address];
    const tollanSession = bundle.tollanSessions?.[address];
    const display = extractAccountDisplayInfo(
      account.name,
      address,
      gameSession?.gameAccount,
      gameSession?.user,
    );
    const tollanName = tollanSession?.state.account.accountName?.trim();
    rememberAccountDisplayName(
      account,
      display.displayName !== account.name && !display.displayName.startsWith('0x')
        ? display.displayName
        : tollanName || display.displayName,
    );
  }
}

function accountDisplayName(account: Account): string {
  const address = account.agwAddress?.toLowerCase();
  return (address ? knownAccountDisplayNames.get(address) : undefined) ?? account.name;
}

function uiAccountIdentity(
  account: Account,
  address = account.agwAddress ?? '',
): { name: string; alias: string; displayName: string; address: string } {
  const displayName = accountDisplayName(account);
  return { name: displayName, alias: account.name, displayName, address };
}

type BrowserGameAuthState = 'awaiting_browser' | 'completed' | 'failed';

interface BrowserGameAuthOperation {
  id: string;
  callbackSecret: string;
  accountAlias: string;
  expectedAddress: string;
  loginUrl: string;
  state: BrowserGameAuthState;
  needsGame: boolean;
  needsTollan: boolean;
  startedAt: number;
  expiresAt?: number;
  error?: string;
  tollanNonce?: string;
  tollanSignerAddress?: string;
  tollanSessionCookies?: string[];
  tollanConnected?: boolean;
  tollanWarning?: string;
  timeout?: ReturnType<typeof setTimeout>;
}

interface BrowserGameAuthOperationSnapshot {
  id: string;
  accountAlias: string;
  expectedAddress: string;
  loginUrl: string;
  state: BrowserGameAuthState;
  needsGame: boolean;
  needsTollan: boolean;
  startedAt: number;
  expiresAt?: number;
  error?: string;
  tollanConnected?: boolean;
  tollanWarning?: string;
}

interface BrowserGameSessionNeed {
  accountAlias: string;
  expectedAddress: string;
  needsGame: boolean;
  needsTollan: boolean;
}

const browserGameAuthOperations = new Map<string, BrowserGameAuthOperation>();
let activeBrowserGameAuthOperationId: string | undefined;

function dataPath(fileName: string): string {
  return resolve(runtime.dataDir, fileName);
}

function agwCliRuntime(): AgwCliRuntimeOptions {
  return {
    appRoot: runtime.appRoot,
    homeRoot: runtime.dataDir,
    ...(runtime.childCommand ? { command: runtime.childCommand } : {}),
    electronRunAsNode: runtime.electronRunAsNode,
  };
}

function hubPackManager(): HubPackManager {
  activeHubPackManager ??= new HubPackManager({
    appRoot: runtime.appRoot,
    dataDir: runtime.dataDir,
  });
  return activeHubPackManager;
}

function tollanAuthConfig() {
  const tollan = hubPackManager().load().pack.modules.tollan;
  return {
    hubUrl: tollan.hubUrl,
    nonceActionId: tollan.auth.nonceActionId,
    loginActionId: tollan.auth.loginActionId,
  };
}

function badgeActionStore(): BadgeActionStore {
  return new BadgeActionStore(dataPath('badge-actions.json'));
}

function secretsConfig(): { encPath: string; accountsPath: string; proxiesPath: string } {
  return {
    encPath: dataPath('secrets.enc'),
    accountsPath: dataPath('accounts.txt'),
    proxiesPath: dataPath('proxies.txt'),
  };
}

function rememberVaultPassword(password: string): void {
  unlockedMasterPassword = password;
  vaultSessionToken ??= randomBytes(32).toString('hex');
  void keychainSave(password);
  if (discoverMaintenanceSnapshot.state === 'locked') {
    discoverMaintenanceSnapshot = {
      state: 'checking',
      checkedAt: discoverMaintenanceSnapshot.checkedAt,
      accounts: discoverMaintenanceSnapshot.accounts,
    };
  }
  if (discoverMaintenanceKick) clearTimeout(discoverMaintenanceKick);
  discoverMaintenanceKick = setTimeout(() => {
    discoverMaintenanceKick = undefined;
    void runDiscoverMaintenance();
  }, 100);
  discoverMaintenanceKick.unref();
}

async function decryptVaultToMemory(
  password: string,
  cfg: Parameters<typeof decryptToMemory>[1],
): Promise<SecretsBundle> {
  const bundle = await decryptToMemory(password, cfg);
  rememberVaultPassword(password);
  return bundle;
}

// ── Auth rate-limiter ─────────────────────────────────────────────────────────
// Defence against brute-force attempts on master-password endpoints. Even though
// scrypt N=2¹⁸ is slow, any process able to hit localhost (other apps, malicious
// browser pages via DNS rebinding, etc) could mount a long-running attack.
// Tracks failures per-process and locks for an increasing duration.

let authFails = 0;
let authLockUntil = 0;

class MasterPasswordError extends Error {
  constructor() {
    super('Неверный мастер-пароль');
    this.name = 'MasterPasswordError';
  }
}

function checkAuthLock(res: Response): boolean {
  const now = Date.now();
  if (now < authLockUntil) {
    const waitMs = authLockUntil - now;
    res.status(429).json({
      error: `Слишком много неудачных попыток. Подождите ${Math.ceil(waitMs / 1000)}с`,
    });
    return false;
  }
  return true;
}

function recordAuthOutcome(ok: boolean): void {
  if (ok) {
    authFails = 0;
    authLockUntil = 0;
    return;
  }
  authFails++;
  // Backoff curve: 1, 2, 4, 8, 16 fails → 0, 0, 5s, 30s, 60s lock
  if (authFails >= 5) authLockUntil = Date.now() + 60_000;
  else if (authFails >= 4) authLockUntil = Date.now() + 30_000;
  else if (authFails >= 3) authLockUntil = Date.now() + 5_000;
}

// ── SSE client registry ───────────────────────────────────────────────────────

/** All currently connected browser SSE clients. */
const sseClients = new Set<Response>();

/** Push one log line to every connected SSE client. */
function pushSse(line: string): void {
  const payload = `data: ${JSON.stringify({ line, level: classifyLogLine(line) })}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// ── Child-process state ───────────────────────────────────────────────────────

/** The currently running play.ts child, or undefined if idle. */
let activeChild: ChildProcess | undefined;
let playStarting = false;
let activeServer: Server | undefined;
let activeServerUrl: string | undefined;

function clearChild(): void {
  activeChild = undefined;
  // Notify all SSE clients that the process has ended
  pushSse('__EXIT__');
}

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '5mb' }));

function requestCookies(req: Request): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return values;
}

function hasVaultSession(req: Request): boolean {
  const candidate = requestCookies(req).get(VAULT_SESSION_COOKIE);
  return Boolean(candidate && vaultSessionToken && candidate === vaultSessionToken);
}

function issueVaultSession(res: Response): void {
  if (!vaultSessionToken) return;
  res.append(
    'Set-Cookie',
    `${VAULT_SESSION_COOKIE}=${vaultSessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
  );
}

// A validated master password unlocks one localhost renderer session. Protected
// endpoints keep their existing password contract, but the actual password no
// longer travels between tabs after the first successful request.
app.use((req: Request, res: Response, next) => {
  const body = req.body as Record<string, unknown> | undefined;
  if (
    body &&
    hasVaultSession(req) &&
    unlockedMasterPassword &&
    (!body['password'] || body['password'] === VAULT_SESSION_MARKER)
  ) {
    body['password'] = unlockedMasterPassword;
  }

  const originalJson = res.json.bind(res);
  res.json = ((payload: unknown) => {
    const suppliedPassword = (req.body as Record<string, unknown> | undefined)?.['password'];
    if (
      res.statusCode < 400 &&
      unlockedMasterPassword &&
      suppliedPassword === unlockedMasterPassword
    ) {
      issueVaultSession(res);
    }
    return originalJson(payload);
  }) as Response['json'];
  next();
});

// Serve the static UI files from the public/ subdirectory next to this file.
const publicDir = resolve(__dirname, 'public');
app.use(express.static(publicDir));

// ── /api/status ───────────────────────────────────────────────────────────────

/**
 * GET /api/status
 * Returns whether a child process is running and whether secrets.enc exists.
 */
app.get('/api/status', (req: Request, res: Response) => {
  const hub = hubPackManager().status();
  res.json({
    running: !!activeChild || playStarting,
    hasSecrets: existsSync(dataPath('secrets.enc')),
    vaultUnlocked: Boolean(unlockedMasterPassword),
    vaultSession: hasVaultSession(req),
    desktop: runtime.desktop,
    platform: process.platform,
    productName: 'Abstract Hub',
    coreVersion: hub.coreVersion,
    packVersion: hub.packVersion,
  });
});

app.post('/api/vault/session/restore', (req: Request, res: Response) => {
  if (!unlockedMasterPassword || !hasEncrypted({ encPath: dataPath('secrets.enc') })) {
    res.status(423).json({ error: 'Хранилище ещё заблокировано' });
    return;
  }
  vaultSessionToken ??= randomBytes(32).toString('hex');
  issueVaultSession(res);
  res.json({ ok: true });
});

// ── Abstract Hub / data-pack updates ─────────────────────────────────────────

app.get('/api/hub', (_req: Request, res: Response) => {
  const manager = hubPackManager();
  const { pack } = manager.load();
  res.json({
    update: manager.status(),
    modules: {
      discover: {
        portalUrl: pack.modules.abstractDiscover.portalUrl,
      },
      badges: {
        rewardsUrl: pack.modules.abstractBadges.rewardsUrl,
        flash: pack.modules.abstractBadges.flash,
      },
      gigaverse: {
        homeUrl: pack.modules.gigaverse.homeUrl,
        marketplaceUrl: pack.modules.gigaverse.marketplaceUrl,
        racingUrl: pack.modules.gigaverse.racingUrl,
      },
      cambria: {
        lobbyUrl: pack.modules.cambria.lobbyUrl,
      },
      tollan: {
        hubUrl: pack.modules.tollan.hubUrl,
        missionsUrl: new URL(pack.modules.tollan.routes.missions, pack.modules.tollan.hubUrl).href,
        inventoryUrl: new URL(pack.modules.tollan.routes.inventory, pack.modules.tollan.hubUrl)
          .href,
        storeUrl: new URL(pack.modules.tollan.routes.store, pack.modules.tollan.hubUrl).href,
        practiceUrl: new URL(pack.modules.tollan.routes.practice, pack.modules.tollan.hubUrl).href,
        automationAvailable: Boolean(runtime.tollanBrowser),
      },
    },
  });
});

app.post('/api/hub/updates/check', async (_req: Request, res: Response) => {
  try {
    res.json({ update: await hubPackManager().check() });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Не удалось проверить обновления',
    });
  }
});

app.post('/api/hub/updates/install', (_req: Request, res: Response) => {
  try {
    res.json({ update: hubPackManager().installPending() });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Не удалось установить data-pack',
    });
  }
});

app.post('/api/hub/updates/rollback', (_req: Request, res: Response) => {
  try {
    res.json({ update: hubPackManager().rollback() });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Не удалось откатить data-pack',
    });
  }
});

// ── /api/events ───────────────────────────────────────────────────────────────

/**
 * GET /api/events
 * Server-Sent Events stream. The browser connects once and receives log lines
 * from the running play.ts child process in real time.
 */
app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Flush headers immediately so the browser connection is established
  res.flushHeaders();

  sseClients.add(res);

  // Heartbeat every 15s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// ── /api/setup ────────────────────────────────────────────────────────────────

interface SetupBody {
  password: string;
  accounts: string;
  proxies: string;
  /** Optional CapSolver key for Cloudflare Turnstile (Cambria). */
  capsolverApiKey?: string;
}

/**
 * POST /api/setup
 * Body: { password, accounts, proxies }
 *
 * Validates and encrypts the account bundle without creating plaintext files.
 */
app.post('/api/setup', async (req: Request, res: Response) => {
  const body = req.body as SetupBody;

  if (!body.password || body.password.length < 8) {
    res.status(400).json({ error: 'Пароль должен быть не менее 8 символов' });
    return;
  }
  if (!body.accounts?.trim()) {
    res.status(400).json({ error: 'Список аккаунтов не может быть пустым' });
    return;
  }
  if (!body.proxies?.trim()) {
    res.status(400).json({ error: 'Список прокси не может быть пустым' });
    return;
  }

  const migration = migrateLegacyJwtAccountsText(body.accounts);
  let parsedAccounts: ReturnType<typeof parseAccountsFromText>;
  try {
    parsedAccounts = parseAccountsFromText({
      accountsText: migration.accountsText,
      proxiesText: body.proxies,
      accountsSourceLabel: 'аккаунты',
      proxiesSourceLabel: 'прокси',
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const cfg = secretsConfig();

  let currentBundle: SecretsBundle | undefined;
  // If secrets.enc already exists, validate the password matches before overwriting.
  if (hasEncrypted(cfg)) {
    if (!checkAuthLock(res)) return;
    try {
      currentBundle = await decryptVaultToMemory(body.password, cfg);
      recordAuthOutcome(true);
    } catch {
      recordAuthOutcome(false);
      res.status(403).json({ error: 'Неверный пароль — не совпадает с существующим secrets.enc' });
      return;
    }
  }

  try {
    const allowedAddresses = new Set(
      parsedAccounts
        .map(({ account }) => account.agwAddress?.toLowerCase())
        .filter((address): address is string => Boolean(address)),
    );
    let gameSessions = currentBundle?.gameSessions;
    for (const session of pendingGameSessions.values()) {
      if (allowedAddresses.has(session.address)) {
        gameSessions = upsertStoredGameSession(gameSessions, session);
      }
    }
    if (gameSessions) {
      gameSessions = Object.fromEntries(
        Object.entries(gameSessions).filter(([address]) => allowedAddresses.has(address)),
      );
    }
    let tollanSessions = currentBundle?.tollanSessions;
    for (const session of pendingTollanSessions.values()) {
      if (allowedAddresses.has(session.agwAddress)) {
        tollanSessions = upsertStoredTollanSession(tollanSessions, session);
      }
    }
    if (tollanSessions) {
      tollanSessions = Object.fromEntries(
        Object.entries(tollanSessions).filter(([address]) => allowedAddresses.has(address)),
      );
    }
    const capsolverApiKey = (() => {
      if (typeof body.capsolverApiKey !== 'string')
        return currentBundle?.capsolverApiKey?.trim() ?? '';
      const raw = body.capsolverApiKey.trim();
      if (!raw) return '';
      // Mask from /api/unlock means "keep existing key".
      if (/^•+$/.test(raw) || raw.includes('•'))
        return currentBundle?.capsolverApiKey?.trim() ?? '';
      return raw;
    })();
    await saveEncryptedBundle(
      {
        accounts: migration.accountsText,
        proxies: body.proxies,
        ...(capsolverApiKey ? { capsolverApiKey } : {}),
        ...(gameSessions && Object.keys(gameSessions).length > 0 ? { gameSessions } : {}),
        ...(tollanSessions && Object.keys(tollanSessions).length > 0 ? { tollanSessions } : {}),
      },
      body.password,
      cfg,
    );
    rememberVaultPassword(body.password);
    res.json({ ok: true, migratedAccounts: migration.migrated });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── /api/unlock ───────────────────────────────────────────────────────────────

interface UnlockBody {
  password: string;
}

/**
 * POST /api/unlock
 * Body: { password }
 * Returns the decrypted secrets bundle (accounts + proxies text) for the Edit tab.
 */
app.post('/api/unlock', async (req: Request, res: Response) => {
  const body = req.body as UnlockBody;

  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }

  const cfg = { encPath: dataPath('secrets.enc') };

  if (!hasEncrypted(cfg)) {
    res.status(404).json({ error: 'secrets.enc не найден' });
    return;
  }

  if (!checkAuthLock(res)) return;
  try {
    const bundle: SecretsBundle = await decryptVaultToMemory(body.password, cfg);
    recordAuthOutcome(true);
    const migration = migrateLegacyJwtAccountsText(bundle.accounts);
    const gameSessions: Record<string, number> = {};
    const tollanSessions: Record<string, { accountName: string; capturedAt: number }> = {};
    try {
      const loaded = parseAccountsFromText({
        accountsText: migration.accountsText,
        proxiesText: bundle.proxies,
      });
      for (const { account } of loaded) {
        const stored = storedGameSessionForAccount(bundle.gameSessions, account);
        if (stored) gameSessions[stored.address] = stored.expiresAt;
        const tollan = storedTollanSessionForAddress(bundle.tollanSessions, account.agwAddress);
        if (tollan) {
          tollanSessions[tollan.agwAddress] = {
            accountName: tollan.state.account.accountName,
            capturedAt: tollan.capturedAt,
          };
        }
      }
    } catch {
      // The editor still needs to open so malformed account text can be repaired.
    }
    res.json({
      accounts: migration.accountsText,
      proxies: bundle.proxies,
      migratedAccounts: migration.migrated,
      gameSessions,
      tollanSessions,
      capsolverConfigured: Boolean(bundle.capsolverApiKey?.trim()),
      // Never echo the raw key back into the renderer; empty means "leave unchanged" on save.
      capsolverApiKey: bundle.capsolverApiKey?.trim() ? '••••••••' : '',
    });
  } catch {
    recordAuthOutcome(false);
    res.status(403).json({ error: 'Неверный пароль' });
  }
});

// ── /api/play ─────────────────────────────────────────────────────────────────

interface PlayBody {
  password: string;
  dungeon?: 'dungeon5000' | 'underhaul';
  list?: boolean;
  /** parallel (default) runs all accounts concurrently; sequential one-by-one. */
  mode?: 'parallel' | 'sequential';
}

async function loadBrowserGameSessionState(password: string): Promise<{
  bundle: SecretsBundle;
  accounts: ReturnType<typeof parseAccountsFromText>;
  needs: BrowserGameSessionNeed[];
}> {
  const cfg = { encPath: dataPath('secrets.enc') };
  if (!hasEncrypted(cfg)) throw new Error('secrets.enc не найден');

  let bundle: SecretsBundle;
  try {
    bundle = await decryptVaultToMemory(password, cfg);
    recordAuthOutcome(true);
  } catch {
    recordAuthOutcome(false);
    throw new MasterPasswordError();
  }
  const accounts = parseAccountsFromText({
    accountsText: bundle.accounts,
    proxiesText: bundle.proxies,
    accountsSourceLabel: 'accounts (encrypted)',
    proxiesSourceLabel: 'proxies (encrypted)',
  });
  const needs: BrowserGameSessionNeed[] = [];
  const now = Date.now();
  for (const { account } of accounts) {
    if (account.privateKey || !account.agwAddress) continue;
    const address = account.agwAddress.toLowerCase();
    const pendingGame = pendingGameSessions.get(address);
    const currentGame =
      pendingGame && pendingGame.expiresAt > now
        ? pendingGame
        : storedGameSessionForAccount(bundle.gameSessions, account, now);
    const currentTollan =
      pendingTollanSessions.get(address) ??
      storedTollanSessionForAddress(bundle.tollanSessions, account.agwAddress);
    const needsGame = !currentGame || currentGame.expiresAt < now + BROWSER_GAME_SESSION_MIN_TTL_MS;
    const needsTollan = !currentTollan;
    if (!needsGame && !needsTollan) continue;
    needs.push({ accountAlias: account.name, expectedAddress: address, needsGame, needsTollan });
  }
  return { bundle, accounts, needs };
}

/**
 * POST /api/play
 * Body: { password, dungeon?, list? }
 *
 * Spawns `tsx internal/src/play.ts` as a child process, writes the password to
 * its stdin (GIGABOT_STDIN_PASSWORD=1 mode), and pipes stdout/stderr to all
 * connected SSE clients so the browser sees live log output.
 */
app.post('/api/play', async (req: Request, res: Response) => {
  if (activeChild || playStarting) {
    res.status(409).json({ error: 'Уже запущено — сначала остановите' });
    return;
  }

  const body = req.body as PlayBody;

  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }

  playStarting = true;
  try {
    if (!checkAuthLock(res)) {
      playStarting = false;
      return;
    }
    const cfg = { encPath: dataPath('secrets.enc') };
    if (!hasEncrypted(cfg)) throw new Error('secrets.enc не найден');
    await decryptVaultToMemory(body.password, cfg);
    recordAuthOutcome(true);
  } catch (error) {
    if (error instanceof Error && error.message !== 'secrets.enc не найден') {
      recordAuthOutcome(false);
    }
    playStarting = false;
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const argv: string[] = [];
  if (body.dungeon === 'underhaul') {
    argv.push('--dungeon', 'underhaul');
  }
  if (body.list) {
    argv.push('--list');
  }
  if (body.mode === 'sequential' || body.mode === 'parallel') {
    argv.push('--mode', body.mode);
  }

  // Spawn with GIGABOT_STDIN_PASSWORD=1 so play.ts reads the password from
  // stdin on the first line instead of opening an inquirer prompt.
  const playEntry = runtime.desktop
    ? resolve(runtime.appRoot, 'dist/src/play.js')
    : resolve(runtime.appRoot, 'internal/src/play.ts');
  const command = runtime.desktop ? (runtime.childCommand ?? process.execPath) : 'tsx';

  activeChild = spawn(command, [playEntry, ...argv], {
    cwd: runtime.dataDir,
    env: {
      ...process.env,
      GIGABOT_STDIN_PASSWORD: '1',
      GIGABOT_DATA_DIR: runtime.dataDir,
      GIGABOT_HOME: process.env['GIGABOT_HOME'] ?? runtime.dataDir,
      GIGABOT_APP_ROOT: runtime.appRoot,
      GIGABOT_BUILD_PLAN:
        process.env['GIGABOT_BUILD_PLAN'] ??
        resolve(runtime.appRoot, runtime.desktop ? 'dist/build.yaml' : 'internal/build.yaml'),
      ...(runtime.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      // Disable chalk colours in SSE output — the browser will strip ANSI anyway
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Write the password to stdin immediately, followed by a newline
  if (activeChild.stdin) {
    activeChild.stdin.write(body.password + '\n');
    activeChild.stdin.end();
  }

  // Pipe stdout and stderr lines to SSE clients
  function pipeStream(stream: NodeJS.ReadableStream | null): void {
    if (!stream) return;
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      // Keep the last incomplete fragment in the buffer
      pending = lines.pop() ?? '';
      for (const line of lines) {
        // eslint-disable-next-line no-control-regex
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
        if (clean.trim()) pushSse(clean);
      }
    });
    stream.on('end', () => {
      if (pending.trim()) {
        // eslint-disable-next-line no-control-regex
        pushSse(pending.replace(/\x1b\[[0-9;]*m/g, ''));
      }
    });
  }

  pipeStream(activeChild.stdout);
  pipeStream(activeChild.stderr);

  activeChild.on('exit', (code, signal) => {
    pushSse(`--- процесс завершён (code=${code ?? 'null'}, signal=${signal ?? 'none'}) ---`);
    clearChild();
  });

  activeChild.on('error', (err) => {
    pushSse(`[ошибка запуска]: ${err.message}`);
    clearChild();
  });

  playStarting = false;
  res.json({ ok: true });
});

// ── /api/timing ───────────────────────────────────────────────────────────────

/**
 * GET /api/timing
 * Returns the current timing config (from file or defaults).
 */
app.get('/api/timing', (_req: Request, res: Response) => {
  res.json(loadTimingConfig());
});

/**
 * POST /api/timing
 * Body: TimingConfig — four categories each with minMs and maxMs.
 * Validates that all values are positive numbers and minMs <= maxMs.
 */
app.post('/api/timing', (req: Request, res: Response) => {
  const body = req.body as Partial<TimingConfig>;

  // Validate shape — must have all four categories with numeric min/max.
  const required: Array<keyof TimingConfig> = ['action', 'lootThinking', 'postAction', 'interRun'];
  for (const key of required) {
    const range = body[key];
    if (!range || typeof range !== 'object') {
      res.status(400).json({ error: `Missing field: ${key}` });
      return;
    }
    if (typeof range.minMs !== 'number' || typeof range.maxMs !== 'number') {
      res.status(400).json({ error: `${key}.minMs and ${key}.maxMs must be numbers` });
      return;
    }
  }

  const cfg = body as TimingConfig;
  const validationError = validateTimingConfig(cfg);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  try {
    saveTimingConfig(cfg);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── /api/inventory ────────────────────────────────────────────────────────────

interface InventoryRequestBody {
  password: string;
}

interface InventoryItem {
  itemId: number;
  /** Human-readable name from /api/indexer/gameitems, or `item#NNN` fallback. */
  name: string;
  /** Image URL from catalog (CDN), if available. */
  image?: string;
  count: number;
  /** How many of `count` are currently equipped (0..count). */
  equippedCount: number;
  rarity: string;
  equipped: boolean;
  /** True when the catalog had no name — useful for UI dimming. */
  unknown: boolean;
  /** Quantity that is not equipped and can potentially be listed. */
  sellableCount: number;
  /** Current market floor and default listing price (exact floor). */
  floorWei?: string;
  listPriceWei?: string;
  protected: boolean;
  canList: boolean;
  listBlockedReason?: string;
  condition?: ReturnType<typeof tallyItems>[number]['condition'];
}

interface AccountInventory {
  name: string;
  alias: string;
  displayName: string;
  username?: string;
  noobId?: string;
  agwAddress: string;
  energy: { value: number; max: number } | null;
  canSell: boolean;
  floorFetchedAt?: number;
  abstractSigner?: {
    state: DelegatedAgwAvailability['state'] | 'error';
    message: string;
    policyPreset?: string;
    connectedAddress?: string;
  };
  items: InventoryItem[];
  error?: string;
}

/**
 * POST /api/inventory
 * Body: { password }
 *
 * Loads secrets, authenticates each account, fetches energy + gear instances,
 * and returns a normalized per-account inventory suitable for the UI table.
 *
 * Runs accounts in parallel (Promise.allSettled) so one failure doesn't block others.
 */
app.post('/api/inventory', async (req: Request, res: Response) => {
  const body = req.body as InventoryRequestBody;
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }

  const cfg = { encPath: dataPath('secrets.enc') };
  if (!hasEncrypted(cfg)) {
    res.status(404).json({ error: 'secrets.enc не найден' });
    return;
  }

  if (!checkAuthLock(res)) return;
  let bundle: SecretsBundle;
  try {
    bundle = await decryptVaultToMemory(body.password, cfg);
    recordAuthOutcome(true);
  } catch {
    recordAuthOutcome(false);
    res.status(403).json({ error: 'Неверный пароль' });
    return;
  }

  let loaded: ReturnType<typeof parseAccountsFromText>;
  try {
    loaded = parseAccountsFromText({
      accountsText: bundle.accounts,
      proxiesText: bundle.proxies,
      accountsSourceLabel: 'accounts (encrypted)',
      proxiesSourceLabel: 'proxies (encrypted)',
    });
    rememberBundleAccountDisplayNames(bundle, loaded);
    loaded = loaded.map((entry) => ({
      ...entry,
      account: hydrateAccountGameSession(entry.account, bundle.gameSessions),
    }));
  } catch (e) {
    res.status(400).json({ error: String(e) });
    return;
  }

  const log = createLogger();

  const results = await Promise.allSettled(
    loaded.map(async ({ account }): Promise<AccountInventory> => {
      const client = new GigaClient(account, log);
      const delegatedSignerPromise =
        account.agwAddress && !account.privateKey
          ? inspectDelegatedAgw(account, agwCliRuntime())
          : Promise.resolve(undefined);
      let session: Awaited<ReturnType<typeof resolveAccountSession>>;
      try {
        session = await resolveAccountSession({ account, log, agwCli: agwCliRuntime() });
      } catch (error) {
        let abstractSigner: AccountInventory['abstractSigner'];
        try {
          const availability = await delegatedSignerPromise;
          if (availability) {
            abstractSigner = {
              state: availability.state,
              message: availability.message,
              ...(availability.session.policyPreset
                ? { policyPreset: availability.session.policyPreset }
                : {}),
              ...(availability.session.accountAddress
                ? { connectedAddress: availability.session.accountAddress }
                : {}),
            };
          }
        } catch (signerError) {
          abstractSigner = {
            state: 'error',
            message: signerError instanceof Error ? signerError.message : String(signerError),
          };
        }
        return {
          ...uiAccountIdentity(account),
          agwAddress: account.agwAddress ?? '',
          energy: null,
          canSell: false,
          ...(abstractSigner ? { abstractSigner } : {}),
          items: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const agwAddress = session.agwAddress;
      const gameAccount = session.loginResult.gameAccount;
      client.setJwt(session.loginResult.jwt);

      // Fetch energy + gear + item balances + catalogs (for names+images) in parallel.
      const [
        energyResult,
        gearRaw,
        balancesRaw,
        gameCatalogRaw,
        gearCatalogRaw,
        profileRaw,
        floorsRaw,
        delegatedSignerRaw,
      ] = await Promise.allSettled([
        client.getEnergy(agwAddress),
        client.getGearInstances(agwAddress),
        client.getItemBalances(),
        client.getGameItemsCatalog(),
        client.getGearItemsCatalog(),
        client.get<unknown>(`/api/account/${agwAddress}`, { authed: true }),
        client.getFloors(),
        delegatedSignerPromise,
      ]);

      const energy =
        energyResult.status === 'fulfilled'
          ? { value: energyResult.value.energyValue, max: energyResult.value.maxEnergy }
          : null;

      let catalog = mergeCatalogs(
        gameCatalogRaw.status === 'fulfilled'
          ? buildCatalog(gameCatalogRaw.value)
          : new Map<number, { name: string; image?: string }>(),
        gearCatalogRaw.status === 'fulfilled'
          ? buildCatalog(gearCatalogRaw.value)
          : new Map<number, { name: string; image?: string }>(),
      );

      // Single source of truth: reuse the shared CLI normalizer. Map its
      // InventoryRow shape to the UI's InventoryItem.
      const gearList = [
        ...(gearRaw.status === 'fulfilled' ? extractGearList(gearRaw.value) : []),
        ...(balancesRaw.status === 'fulfilled' ? extractBalanceList(balancesRaw.value) : []),
      ];
      catalog = await enrichCatalogWithMetadata(client, gearList, catalog);
      const floors = floorsRaw.status === 'fulfilled' ? floorsRaw.value : new Map<number, bigint>();
      const floorFetchedAt = floorsRaw.status === 'fulfilled' ? Date.now() : undefined;
      const delegatedAvailability =
        delegatedSignerRaw.status === 'fulfilled' ? delegatedSignerRaw.value : undefined;
      const abstractSigner =
        account.agwAddress && !account.privateKey
          ? delegatedSignerRaw.status === 'rejected'
            ? {
                state: 'error' as const,
                message:
                  delegatedSignerRaw.reason instanceof Error
                    ? delegatedSignerRaw.reason.message
                    : String(delegatedSignerRaw.reason),
              }
            : delegatedAvailability
              ? {
                  state: delegatedAvailability.state,
                  message: delegatedAvailability.message,
                  ...(delegatedAvailability.session.policyPreset
                    ? { policyPreset: delegatedAvailability.session.policyPreset }
                    : {}),
                  ...(delegatedAvailability.session.accountAddress
                    ? { connectedAddress: delegatedAvailability.session.accountAddress }
                    : {}),
                }
              : undefined
          : undefined;
      const canSell = Boolean(account.privateKey) || delegatedAvailability?.state === 'ready';
      const signerBlockedReason = abstractSigner?.message ?? 'Подключите Abstract для продаж';
      const conditionCatalog =
        gearCatalogRaw.status === 'fulfilled'
          ? buildGearConditionCatalog(gearCatalogRaw.value)
          : new Map();
      const items: InventoryItem[] = tallyItems(gearList, catalog, conditionCatalog).map((r) => {
        const itemId = r.gameItemId;
        const sellableCount = Math.max(0, r.qty - r.equippedQty);
        const protectedItem = isProtectedMarketItem(itemId);
        const floor = floors.get(itemId);
        const listPrice = floor && floor > 0n ? computeListPrice(floor, 0n) : undefined;
        const listBlockedReason = protectedItem
          ? `${protectedMarketItemName(itemId)} сохраняется для крафта перчаток`
          : !canSell
            ? signerBlockedReason
            : sellableCount === 0
              ? 'Все экземпляры экипированы'
              : undefined;
        return {
          itemId,
          name: r.item,
          ...(r.image ? { image: r.image } : {}),
          count: r.qty,
          equippedCount: r.equippedQty,
          rarity: r.rarity,
          equipped: r.equipped,
          unknown: r.unknown,
          ...(r.condition ? { condition: r.condition } : {}),
          sellableCount,
          ...(floor && floor > 0n ? { floorWei: floor.toString() } : {}),
          ...(listPrice ? { listPriceWei: listPrice.toString() } : {}),
          protected: protectedItem,
          canList: listBlockedReason === undefined,
          ...(listBlockedReason ? { listBlockedReason } : {}),
        };
      });
      const profile = profileRaw.status === 'fulfilled' ? profileRaw.value : undefined;
      const display = extractAccountDisplayInfo(account.name, agwAddress, gameAccount, profile);
      rememberAccountDisplayName(account, display.displayName);

      return {
        name: display.displayName,
        alias: display.alias,
        displayName: display.displayName,
        ...(display.username ? { username: display.username } : {}),
        ...(display.noobId ? { noobId: display.noobId } : {}),
        agwAddress,
        energy,
        canSell,
        ...(floorFetchedAt ? { floorFetchedAt } : {}),
        ...(abstractSigner ? { abstractSigner } : {}),
        items,
      };
    }),
  );

  const accounts: AccountInventory[] = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const acc = loaded[i]!;
    return {
      name: acc.account.name,
      alias: acc.account.name,
      displayName: acc.account.name,
      agwAddress: acc.account.agwAddress ?? '',
      energy: null,
      canSell: false,
      items: [],
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });

  res.json({ accounts, marketplaceContract: ITEM_MARKET_ADDRESS });
});

// extractGearListFromRaw + normalizeGearInstances were removed —
// `tallyItems` from ../inventory.js is now the single source of truth.

interface AbstractAuthRequestBody {
  password: string;
  accountAlias: string;
}

type AbstractAuthAction = 'connect' | 'revoke';
type AbstractAuthState = 'starting' | 'awaiting_approval' | 'finalizing' | 'completed' | 'failed';

interface AbstractAuthOperation {
  id: string;
  accountAlias: string;
  action: AbstractAuthAction;
  state: AbstractAuthState;
  startedAt: number;
  approvalUrl?: string;
  availability?: DelegatedAgwAvailability;
  error?: string;
  callbackReceivedAt?: number;
  callbackSecret: string;
  callbackTarget?: string;
  callbackForwarded: boolean;
  abortController: AbortController;
}

interface AbstractAuthOperationSnapshot {
  id: string;
  accountAlias: string;
  action: AbstractAuthAction;
  state: AbstractAuthState;
  startedAt: number;
  approvalUrl?: string;
  availability?: DelegatedAgwAvailability;
  error?: string;
  callbackReceivedAt?: number;
}

const abstractAuthOperations = new Map<string, AbstractAuthOperation>();
let activeAbstractAuthOperationId: string | undefined;

async function loadAbstractAccount(
  body: Partial<AbstractAuthRequestBody>,
  res: Response,
): Promise<Account | null> {
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return null;
  }
  if (!body.accountAlias || !/^[a-zA-Z0-9_-]+$/.test(body.accountAlias)) {
    res.status(400).json({ error: 'Некорректный аккаунт' });
    return null;
  }
  const loaded = await loadBundleAndAccounts(body.password, res);
  if (!loaded) return null;
  const account = loaded.find(
    ({ account: candidate }) => candidate.name === body.accountAlias,
  )?.account;
  if (!account) {
    res.status(404).json({ error: 'Аккаунт не найден' });
    return null;
  }
  if (!account.agwAddress || account.privateKey) {
    res.status(400).json({ error: 'Этот аккаунт не использует вход через Abstract' });
    return null;
  }
  return account;
}

function abstractAvailabilityError(availability: DelegatedAgwAvailability): string {
  if (availability.state === 'wrong_account') {
    return `${availability.message}: ${availability.session.accountAddress ?? 'адрес неизвестен'}`;
  }
  if (availability.state === 'needs_permission') {
    const missingPermissions = [
      ...(availability.session.enabledTools.includes('sign_message') ? [] : ['Sign message']),
      ...(availability.session.enabledTools.includes('send_transaction')
        ? []
        : ['Send transaction']),
    ];
    const missing = missingPermissions.length
      ? ` Не хватает: ${missingPermissions.join(', ')}.`
      : '';
    return `${availability.message}.${missing} Переподключите Abstract и подтвердите единичный доступ.`;
  }
  return availability.message;
}

function abstractAuthSnapshot(operation: AbstractAuthOperation): AbstractAuthOperationSnapshot {
  return {
    id: operation.id,
    accountAlias: operation.accountAlias,
    action: operation.action,
    state: operation.state,
    startedAt: operation.startedAt,
    ...(operation.approvalUrl ? { approvalUrl: operation.approvalUrl } : {}),
    ...(operation.availability ? { availability: operation.availability } : {}),
    ...(operation.error ? { error: operation.error } : {}),
    ...(operation.callbackReceivedAt ? { callbackReceivedAt: operation.callbackReceivedAt } : {}),
  };
}

function abstractApprovalOrigins(): Set<string> {
  const origins = new Set(['https://cli.abs.xyz']);
  const configured = process.env['AGW_APP_URL'];
  if (configured) {
    try {
      origins.add(new URL(configured).origin);
    } catch {
      // The CLI will return its own actionable error for an invalid override.
    }
  }
  return origins;
}

function activeAbstractAuthOperation(): AbstractAuthOperation | undefined {
  return activeAbstractAuthOperationId
    ? abstractAuthOperations.get(activeAbstractAuthOperationId)
    : undefined;
}

function rejectConcurrentAbstractAuth(res: Response): boolean {
  const active = activeAbstractAuthOperation();
  if (!active || ['completed', 'failed'].includes(active.state)) return false;
  res.status(409).json({
    error: `Сначала завершите подключение Abstract для ${active.accountAlias}`,
    operation: abstractAuthSnapshot(active),
  });
  return true;
}

function beginAbstractAuthOperation(
  account: Account,
  action: AbstractAuthAction,
): AbstractAuthOperation {
  if (!activeServerUrl) {
    throw new Error('UI-сервер ещё не готов принимать подтверждение Abstract');
  }
  const id = randomBytes(24).toString('hex');
  const abortController = new AbortController();
  const operation: AbstractAuthOperation = {
    id,
    accountAlias: account.name,
    action,
    state: 'starting',
    startedAt: Date.now(),
    callbackSecret: randomBytes(24).toString('hex'),
    callbackForwarded: false,
    abortController,
  };
  abstractAuthOperations.set(id, operation);
  activeAbstractAuthOperationId = id;

  const options: AgwCliRuntimeOptions = {
    ...agwCliRuntime(),
    authTimeoutMs: ABSTRACT_AUTH_TIMEOUT_MS,
    signal: abortController.signal,
    suppressBrowserOpen: true,
    onApprovalUrl: (approvalUrl) => {
      const bridge = bridgeAbstractApprovalUrl({
        approvalUrl,
        appBaseUrl: activeServerUrl!,
        operationId: operation.id,
        callbackSecret: operation.callbackSecret,
        allowedApprovalOrigins: abstractApprovalOrigins(),
      });
      operation.approvalUrl = bridge.approvalUrl;
      operation.callbackTarget = bridge.callbackTarget;
      operation.state = 'awaiting_approval';
    },
  };
  const pending =
    action === 'connect'
      ? connectDelegatedAgw(account, options, runtime.agwCliRunner)
      : revokeDelegatedAgw(account, options, runtime.agwCliRunner);

  void pending
    .then((availability) => {
      operation.availability = availability;
      if (action === 'connect' && availability.state !== 'ready') {
        operation.state = 'failed';
        operation.error = abstractAvailabilityError(availability);
        return;
      }
      operation.state = 'completed';
    })
    .catch((error: unknown) => {
      operation.state = 'failed';
      operation.error ??= error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      if (activeAbstractAuthOperationId === id) activeAbstractAuthOperationId = undefined;
      const cleanup = setTimeout(() => abstractAuthOperations.delete(id), 20 * 60_000);
      cleanup.unref();
    });

  return operation;
}

async function startAbstractAuthRoute(
  action: AbstractAuthAction,
  req: Request,
  res: Response,
): Promise<void> {
  const account = await loadAbstractAccount(req.body as Partial<AbstractAuthRequestBody>, res);
  if (!account) return;
  if (rejectConcurrentAbstractAuth(res)) return;

  const operation = beginAbstractAuthOperation(account, action);
  res.status(202).json({ operation: abstractAuthSnapshot(operation) });
}

app.post('/api/abstract/connect', async (req: Request, res: Response) => {
  await startAbstractAuthRoute('connect', req, res);
});

interface AbstractOnboardRequestBody {
  sessionId: string;
  expectedAddress?: string;
}

app.post('/api/abstract/check', async (req: Request, res: Response) => {
  const body = req.body as Partial<AbstractOnboardRequestBody>;
  const expectedAddress = body.expectedAddress?.toLowerCase();
  if (!expectedAddress || !/^0x[a-f0-9]{40}$/.test(expectedAddress)) {
    res.status(400).json({ error: 'Некорректный адрес Abstract' });
    return;
  }
  const sessionId = body.sessionId?.toLowerCase();
  if (sessionId && !/^[a-f0-9]{32,64}$/.test(sessionId)) {
    res.status(400).json({ error: 'Некорректный идентификатор подключения Abstract' });
    return;
  }
  const account: Account = {
    name: `check-${expectedAddress.slice(2, 14)}`,
    agwAddress: expectedAddress,
    ...(sessionId ? { sessionId } : {}),
    proxy: { type: 'http', host: '127.0.0.1', port: 1 },
  };
  try {
    const availability = await inspectDelegatedAgw(account, agwCliRuntime());
    res.json({ availability });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Не удалось проверить подключение Abstract',
    });
  }
});

app.post('/api/abstract/onboard', (req: Request, res: Response) => {
  const body = req.body as Partial<AbstractOnboardRequestBody>;
  const sessionId = body.sessionId?.toLowerCase();
  if (!sessionId || !/^[a-f0-9]{32,64}$/.test(sessionId)) {
    res.status(400).json({ error: 'Некорректный идентификатор подключения Abstract' });
    return;
  }
  const expectedAddress = body.expectedAddress?.toLowerCase();
  if (expectedAddress && !/^0x[a-f0-9]{40}$/.test(expectedAddress)) {
    res.status(400).json({ error: 'Некорректный адрес Abstract' });
    return;
  }

  if (rejectConcurrentAbstractAuth(res)) return;

  const account: Account = {
    name: `setup-${sessionId.slice(0, 12)}`,
    sessionId,
    ...(expectedAddress ? { agwAddress: expectedAddress } : {}),
    // The onboarding operation never uses the game proxy. Account keeps the
    // required shape until it is paired with the row's real proxy on save.
    proxy: { type: 'http', host: '127.0.0.1', port: 1 },
  };
  const operation = beginAbstractAuthOperation(account, 'connect');
  res.status(202).json({ operation: abstractAuthSnapshot(operation) });
});

interface BrowserGameAuthStartRequestBody {
  accountAlias?: string;
  expectedAddress: string;
  needsGame?: boolean;
  needsTollan?: boolean;
}

function browserGameAuthSnapshot(
  operation: BrowserGameAuthOperation,
): BrowserGameAuthOperationSnapshot {
  return {
    id: operation.id,
    accountAlias: operation.accountAlias,
    expectedAddress: operation.expectedAddress,
    loginUrl: operation.loginUrl,
    state: operation.state,
    needsGame: operation.needsGame,
    needsTollan: operation.needsTollan,
    startedAt: operation.startedAt,
    ...(operation.expiresAt ? { expiresAt: operation.expiresAt } : {}),
    ...(operation.error ? { error: operation.error } : {}),
    ...(operation.tollanConnected !== undefined
      ? { tollanConnected: operation.tollanConnected }
      : {}),
    ...(operation.tollanWarning ? { tollanWarning: operation.tollanWarning } : {}),
  };
}

function finishBrowserGameAuthOperation(
  operation: BrowserGameAuthOperation,
  state: Extract<BrowserGameAuthState, 'completed' | 'failed'>,
  error?: string,
): void {
  operation.state = state;
  if (error) operation.error = error;
  if (operation.timeout) clearTimeout(operation.timeout);
  delete operation.timeout;
  if (activeBrowserGameAuthOperationId === operation.id) {
    activeBrowserGameAuthOperationId = undefined;
  }
  const cleanup = setTimeout(() => browserGameAuthOperations.delete(operation.id), 20 * 60_000);
  cleanup.unref();
}

function beginBrowserGameAuthOperation(
  accountAlias: string,
  expectedAddress: string,
  needsGame = true,
  needsTollan = true,
): BrowserGameAuthOperation {
  if (!activeServerUrl) throw new Error('UI-сервер ещё не готов принимать вход Gigaverse');

  const id = randomBytes(24).toString('hex');
  const callbackSecret = randomBytes(24).toString('hex');
  const loginUrl = `${activeServerUrl}/game-auth/${id}/${callbackSecret}`;

  const operation: BrowserGameAuthOperation = {
    id,
    callbackSecret,
    accountAlias,
    expectedAddress,
    loginUrl,
    state: 'awaiting_browser',
    needsGame,
    needsTollan,
    startedAt: Date.now(),
  };
  operation.timeout = setTimeout(() => {
    if (operation.state !== 'awaiting_browser') return;
    finishBrowserGameAuthOperation(
      operation,
      'failed',
      'Ожидание входа Gigaverse истекло. Создайте новую ссылку.',
    );
  }, BROWSER_GAME_AUTH_TIMEOUT_MS);
  operation.timeout.unref();
  browserGameAuthOperations.set(id, operation);
  activeBrowserGameAuthOperationId = id;
  return operation;
}

app.post('/api/game-auth/start', (req: Request, res: Response) => {
  const body = req.body as Partial<BrowserGameAuthStartRequestBody>;
  const expectedAddress = body.expectedAddress?.toLowerCase();
  if (!expectedAddress || !/^0x[a-f0-9]{40}$/.test(expectedAddress)) {
    res.status(400).json({ error: 'Некорректный адрес Abstract' });
    return;
  }
  const active = activeBrowserGameAuthOperationId
    ? browserGameAuthOperations.get(activeBrowserGameAuthOperationId)
    : undefined;
  if (active && active.state === 'awaiting_browser') {
    res.status(409).json({
      error: `Сначала завершите вход Gigaverse для ${active.accountAlias}`,
      operation: browserGameAuthSnapshot(active),
    });
    return;
  }

  const accountAlias =
    typeof body.accountAlias === 'string' && body.accountAlias.trim()
      ? body.accountAlias.trim().slice(0, 80)
      : `${expectedAddress.slice(0, 10)}...${expectedAddress.slice(-4)}`;
  const needsGame = body.needsGame !== false;
  const needsTollan = body.needsTollan !== false;
  if (!needsGame && !needsTollan) {
    res.status(400).json({ error: 'Для аккаунта уже сохранены обе игровые сессии' });
    return;
  }
  const operation = beginBrowserGameAuthOperation(
    accountAlias,
    expectedAddress,
    needsGame,
    needsTollan,
  );
  res.status(202).json({ operation: browserGameAuthSnapshot(operation) });
});

app.get('/api/game-auth/operations/:operationId', (req: Request, res: Response) => {
  const operationId = String(req.params['operationId'] ?? '');
  if (!/^[a-f0-9]{48}$/.test(operationId)) {
    res.status(400).json({ error: 'Некорректный ID входа Gigaverse' });
    return;
  }
  const operation = browserGameAuthOperations.get(operationId);
  if (!operation) {
    res.status(404).json({ error: 'Вход Gigaverse не найден или уже завершён давно' });
    return;
  }
  res.json({ operation: browserGameAuthSnapshot(operation) });
});

app.post('/api/game-auth/operations/:operationId/cancel', (req: Request, res: Response) => {
  const operationId = String(req.params['operationId'] ?? '');
  if (!/^[a-f0-9]{48}$/.test(operationId)) {
    res.status(400).json({ error: 'Некорректный ID входа Gigaverse' });
    return;
  }
  const operation = browserGameAuthOperations.get(operationId);
  if (!operation) {
    res.status(404).json({ error: 'Вход Gigaverse не найден' });
    return;
  }
  if (operation.state === 'awaiting_browser') {
    finishBrowserGameAuthOperation(operation, 'failed', 'Вход Gigaverse отменён');
  }
  res.json({ operation: browserGameAuthSnapshot(operation) });
});

app.post('/api/game-auth/needed', async (req: Request, res: Response) => {
  const body = req.body as Partial<UnlockBody>;
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }
  if (!checkAuthLock(res)) return;
  try {
    const state = await loadBrowserGameSessionState(body.password);
    res.json({ accounts: state.needs });
  } catch (error) {
    res.status(error instanceof MasterPasswordError ? 403 : 400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/game-auth/commit', async (req: Request, res: Response) => {
  const body = req.body as Partial<UnlockBody>;
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }
  if (!checkAuthLock(res)) return;
  try {
    const state = await loadBrowserGameSessionState(body.password);
    const allowedAddresses = new Set(
      state.accounts
        .map(({ account }) => account.agwAddress?.toLowerCase())
        .filter((address): address is string => Boolean(address)),
    );
    let gameSessions = state.bundle.gameSessions;
    let tollanSessions = state.bundle.tollanSessions;
    let committed = 0;
    let tollanCommitted = 0;
    for (const session of pendingGameSessions.values()) {
      if (!allowedAddresses.has(session.address)) continue;
      gameSessions = upsertStoredGameSession(gameSessions, session);
      committed++;
    }
    for (const session of pendingTollanSessions.values()) {
      if (!allowedAddresses.has(session.agwAddress)) continue;
      tollanSessions = upsertStoredTollanSession(tollanSessions, session);
      tollanCommitted++;
    }
    await saveEncryptedBundle(
      {
        ...state.bundle,
        ...(gameSessions ? { gameSessions } : {}),
        ...(tollanSessions ? { tollanSessions } : {}),
      },
      body.password,
      { encPath: dataPath('secrets.enc') },
    );
    res.json({ ok: true, committed, tollanCommitted });
  } catch (error) {
    res.status(error instanceof MasterPasswordError ? 403 : 400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/abstract/revoke', async (req: Request, res: Response) => {
  await startAbstractAuthRoute('revoke', req, res);
});

app.get('/api/abstract/operations/:operationId', (req: Request, res: Response) => {
  const rawOperationId = req.params['operationId'];
  const operationId = Array.isArray(rawOperationId)
    ? (rawOperationId[0] ?? '')
    : (rawOperationId ?? '');
  if (!/^[a-f0-9]{48}$/.test(operationId)) {
    res.status(400).json({ error: 'Некорректный ID операции Abstract' });
    return;
  }
  const operation = abstractAuthOperations.get(operationId);
  if (!operation) {
    res.status(404).json({ error: 'Операция Abstract не найдена или уже завершена давно' });
    return;
  }
  res.json({ operation: abstractAuthSnapshot(operation) });
});

app.post('/api/abstract/operations/:operationId/cancel', (req: Request, res: Response) => {
  const rawOperationId = req.params['operationId'];
  const operationId = Array.isArray(rawOperationId)
    ? (rawOperationId[0] ?? '')
    : (rawOperationId ?? '');
  if (!/^[a-f0-9]{48}$/.test(operationId)) {
    res.status(400).json({ error: 'Некорректный ID операции Abstract' });
    return;
  }
  const operation = abstractAuthOperations.get(operationId);
  if (!operation) {
    res.status(404).json({ error: 'Операция Abstract не найдена' });
    return;
  }
  if (!['completed', 'failed'].includes(operation.state)) {
    operation.state = 'failed';
    operation.error = 'Подключение отменено';
    operation.abortController.abort();
  }
  res.json({ operation: abstractAuthSnapshot(operation) });
});

function setAbstractCallbackCors(req: Request, res: Response): boolean {
  const origin = req.get('origin');
  if (origin && !abstractApprovalOrigins().has(origin)) return false;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
  return true;
}

function abstractCallbackOperation(req: Request, res: Response): AbstractAuthOperation | null {
  const operationId = String(req.params['operationId'] ?? '');
  const callbackSecret = String(req.params['callbackSecret'] ?? '');
  if (!/^[a-f0-9]{48}$/.test(operationId) || !/^[a-f0-9]{48}$/.test(callbackSecret)) {
    res.status(404).send('Подключение Abstract не найдено.');
    return null;
  }
  const operation = abstractAuthOperations.get(operationId);
  if (!operation || operation.callbackSecret !== callbackSecret) {
    res.status(404).send('Подключение Abstract не найдено или уже устарело.');
    return null;
  }
  return operation;
}

app.options(
  '/api/abstract/callback/:operationId/:callbackSecret',
  (req: Request, res: Response) => {
    if (!setAbstractCallbackCors(req, res)) {
      res.status(403).send('Origin не разрешён.');
      return;
    }
    if (!abstractCallbackOperation(req, res)) return;
    res.status(204).end();
  },
);

app.get(
  '/api/abstract/callback/:operationId/:callbackSecret',
  async (req: Request, res: Response) => {
    if (!setAbstractCallbackCors(req, res)) {
      res.status(403).send('Origin не разрешён.');
      return;
    }
    const operation = abstractCallbackOperation(req, res);
    if (!operation) return;
    if (operation.callbackForwarded) {
      res.status(200).send('Abstract уже подключён. Можно вернуться в приложение.');
      return;
    }
    if (!operation.callbackTarget || operation.state === 'failed') {
      res.status(410).send('Подключение Abstract уже завершено или отменено.');
      return;
    }

    try {
      const requestUrl = new URL(req.originalUrl, activeServerUrl ?? 'http://127.0.0.1');
      const callbackTarget = buildAbstractCallbackTarget(
        operation.callbackTarget,
        requestUrl.toString(),
      );
      operation.state = 'finalizing';
      operation.callbackReceivedAt = Date.now();

      const callbackResponse = await fetch(callbackTarget, {
        redirect: 'error',
        signal: AbortSignal.timeout(ABSTRACT_CALLBACK_FORWARD_TIMEOUT_MS),
      });
      if (!callbackResponse.ok) {
        throw new Error(`Локальный обработчик Abstract ответил HTTP ${callbackResponse.status}`);
      }
      operation.callbackForwarded = true;
      res.status(200).send('Abstract подтверждён. Можно закрыть эту вкладку.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      operation.state = 'failed';
      operation.error = `Не удалось принять подтверждение Abstract: ${message}`;
      operation.abortController.abort();
      res
        .status(error instanceof AbstractCallbackError ? 400 : 502)
        .send('Приложение не приняло подтверждение. Вернитесь в Abstract Hub и повторите вход.');
    }
  },
);

function setBrowserGameCallbackCors(req: Request, res: Response): boolean {
  const origin = req.get('origin');
  const allowedOrigin = !origin || origin === activeServerUrl;
  if (!allowedOrigin) return false;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
  return true;
}

function browserGameCallbackOperation(
  req: Request,
  res: Response,
): BrowserGameAuthOperation | null {
  const operationId = String(req.params['operationId'] ?? '');
  const callbackSecret = String(req.params['callbackSecret'] ?? '');
  if (!/^[a-f0-9]{48}$/.test(operationId) || !/^[a-f0-9]{48}$/.test(callbackSecret)) {
    res.status(404).json({ error: 'Вход Gigaverse не найден' });
    return null;
  }
  const operation = browserGameAuthOperations.get(operationId);
  if (!operation || operation.callbackSecret !== callbackSecret) {
    res.status(404).json({ error: 'Вход Gigaverse не найден или ссылка уже устарела' });
    return null;
  }
  return operation;
}

app.get('/game-auth/:operationId/:callbackSecret', (req: Request, res: Response) => {
  if (!browserGameCallbackOperation(req, res)) return;
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self' https://gigaverse.io https://auth.privy.io https://*.privy.io https://api.mainnet.abs.xyz",
      'frame-src https://portal.abs.xyz https://*.privy.io',
    ].join('; '),
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.sendFile(resolve(publicDir, 'game-auth.html'));
});

app.post(
  '/api/game-auth/tollan/nonce/:operationId/:callbackSecret',
  async (req: Request, res: Response) => {
    if (!setBrowserGameCallbackCors(req, res)) {
      res.status(403).json({ error: 'Origin не разрешён' });
      return;
    }
    const operation = browserGameCallbackOperation(req, res);
    if (!operation) return;
    if (operation.state !== 'awaiting_browser') {
      res.status(410).json({ error: 'Подключение аккаунта уже завершено' });
      return;
    }
    if (!operation.needsTollan) {
      res.status(409).json({ error: 'Tollan уже подключён для этого аккаунта' });
      return;
    }
    const signerAddress = String(
      (req.body as { signerAddress?: unknown }).signerAddress ?? '',
    ).toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(signerAddress)) {
      res.status(400).json({ error: 'Abstract не передал основной адрес аккаунта' });
      return;
    }
    try {
      const nonce = await runtime.tollanRequestNonce(
        tollanAuthConfig(),
        signerAddress,
        operation.expectedAddress,
      );
      if (!nonce.allowed) {
        res.status(409).json({
          error:
            'Tollan не разрешил автоматический вход для этого Abstract-аккаунта. Переподключите аккаунт и повторите.',
        });
        return;
      }
      operation.tollanNonce = nonce.nonce;
      operation.tollanSignerAddress = signerAddress;
      if (nonce.sessionCookies) operation.tollanSessionCookies = nonce.sessionCookies;
      else delete operation.tollanSessionCookies;
      delete operation.error;
      res.json({ nonce: nonce.nonce, allowed: nonce.allowed });
    } catch (error) {
      operation.error = error instanceof Error ? error.message : 'Tollan не подготовил вход';
      res.status(502).json({
        error: operation.error,
      });
    }
  },
);

app.options(
  '/api/game-auth/callback/:operationId/:callbackSecret',
  (req: Request, res: Response) => {
    if (!setBrowserGameCallbackCors(req, res)) {
      res.status(403).json({ error: 'Origin не разрешён' });
      return;
    }
    if (!browserGameCallbackOperation(req, res)) return;
    res.status(204).end();
  },
);

app.post(
  '/api/game-auth/callback/:operationId/:callbackSecret',
  async (req: Request, res: Response) => {
    if (!setBrowserGameCallbackCors(req, res)) {
      res.status(403).json({ error: 'Origin не разрешён' });
      return;
    }
    const operation = browserGameCallbackOperation(req, res);
    if (!operation) return;
    if (operation.state === 'completed') {
      res.json({
        ok: true,
        address: operation.expectedAddress,
        expiresAt: operation.expiresAt,
        tollanConnected: operation.tollanConnected === true,
        ...(operation.tollanWarning ? { tollanWarning: operation.tollanWarning } : {}),
      });
      return;
    }
    if (operation.state === 'failed') {
      res.status(410).json({ error: operation.error ?? 'Вход Gigaverse уже завершён' });
      return;
    }

    try {
      const body = req.body as {
        authResponse?: unknown;
        tollanAuth?: {
          signerAddress?: unknown;
          nonce?: unknown;
          signature?: unknown;
        };
      };
      let gameSession: StoredGameSession | undefined;
      if (operation.needsGame) {
        gameSession = parseBrowserGameSession(body.authResponse, operation.expectedAddress);
        if (gameSession.expiresAt < Date.now() + BROWSER_GAME_SESSION_MIN_TTL_MS) {
          throw new Error('Сессия Gigaverse скоро истечёт. Выйдите из игры и войдите заново.');
        }
        // Persist the valid game login immediately. A temporary Tollan outage must
        // never force the user to sign into Gigaverse again.
        pendingGameSessions.set(gameSession.address, gameSession);
        operation.expiresAt = gameSession.expiresAt;
        const display = extractAccountDisplayInfo(
          operation.accountAlias,
          gameSession.address,
          gameSession.gameAccount,
          gameSession.user,
        );
        rememberAccountDisplayName(
          { name: operation.accountAlias, agwAddress: gameSession.address },
          display.displayName,
        );
      }

      operation.tollanConnected = !operation.needsTollan;
      if (operation.needsTollan) {
        try {
          const tollanAuth = body.tollanAuth;
          if (!tollanAuth) {
            throw new Error('Подтвердите единичный вход в Tollan');
          }
          const signerAddress = String(tollanAuth.signerAddress ?? '').toLowerCase();
          const nonce = String(tollanAuth.nonce ?? '');
          const signature = String(tollanAuth.signature ?? '');
          if (
            signerAddress !== operation.tollanSignerAddress ||
            nonce !== operation.tollanNonce ||
            !/^0x[a-f0-9]+$/i.test(signature)
          ) {
            throw new Error('Одноразовое подтверждение Tollan устарело. Подготовьте вход ещё раз.');
          }
          const tollanSession = await runtime.tollanLogin(tollanAuthConfig(), {
            signerAddress,
            agwAddress: operation.expectedAddress,
            signature,
            ...(operation.tollanSessionCookies
              ? { sessionCookies: operation.tollanSessionCookies }
              : {}),
          });
          pendingTollanSessions.set(tollanSession.agwAddress, tollanSession);
          operation.tollanConnected = true;
          delete operation.tollanWarning;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Tollan не завершил вход';
          operation.tollanConnected = false;
          operation.tollanWarning = message;
          // Combined login remains useful even when Tollan itself is unavailable.
          // A Tollan-only retry stays open on the same page and does not touch Gigaverse.
          if (!gameSession) throw error;
        }
      }

      delete operation.error;
      finishBrowserGameAuthOperation(operation, 'completed');
      res.json({
        ok: true,
        address: operation.expectedAddress,
        expiresAt: operation.expiresAt,
        tollanConnected: operation.tollanConnected === true,
        ...(operation.tollanWarning ? { tollanWarning: operation.tollanWarning } : {}),
      });
    } catch (error) {
      operation.error = error instanceof Error ? error.message : 'Приложение не приняло вход';
      res.status(502).json({ error: operation.error });
    }
  },
);

interface InventoryListRequestBody {
  password: string;
  accountAlias: string;
  requestId: string;
  pricing: {
    mode: 'floor' | 'discount' | 'custom';
    discountBps?: number;
  };
  items: ManualListingSelection[];
}

interface InventoryListItemResult {
  itemId: number;
  name: string;
  amount: number;
  priceWei: string;
  floorWei?: string;
  floorCheckedAt?: number;
  status: 'submitted' | 'failed';
  txHash?: string;
  error?: string;
}

interface InventoryListResponse {
  accountAlias: string;
  pricingMode: ManualListingPricing['mode'];
  submitted: number;
  failed: number;
  items: InventoryListItemResult[];
}

const manualListingRequests = new Map<
  string,
  { fingerprint: string; promise: Promise<InventoryListResponse> }
>();

app.post('/api/inventory/list', async (req: Request, res: Response) => {
  const body = req.body as Partial<InventoryListRequestBody>;
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }
  if (!body.accountAlias || !/^[a-zA-Z0-9_-]+$/.test(body.accountAlias)) {
    res.status(400).json({ error: 'Некорректный аккаунт' });
    return;
  }
  if (!body.requestId || !/^[a-f0-9-]{16,64}$/i.test(body.requestId)) {
    res.status(400).json({ error: 'Некорректный requestId' });
    return;
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    res.status(400).json({ error: 'Не выбраны предметы для продажи' });
    return;
  }

  const rawPricing = body.pricing ?? { mode: 'floor' as const };
  let pricing: ManualListingPricing;
  if (rawPricing.mode === 'floor') {
    pricing = { mode: 'floor' };
  } else if (rawPricing.mode === 'discount') {
    if (
      !Number.isSafeInteger(rawPricing.discountBps) ||
      rawPricing.discountBps === undefined ||
      rawPricing.discountBps < 0 ||
      rawPricing.discountBps >= 10_000
    ) {
      res.status(400).json({ error: 'Некорректная скидка от floor' });
      return;
    }
    pricing = { mode: 'discount', discountBps: BigInt(rawPricing.discountBps) };
  } else if (rawPricing.mode === 'custom') {
    pricing = { mode: 'custom' };
  } else {
    res.status(400).json({ error: 'Некорректный режим цены' });
    return;
  }

  const selections: ManualListingSelection[] = [];
  for (const item of body.items) {
    if (
      !item ||
      !Number.isSafeInteger(item.itemId) ||
      !Number.isSafeInteger(item.amount) ||
      item.itemId <= 0 ||
      item.amount <= 0
    ) {
      res.status(400).json({ error: 'Некорректный предмет или количество' });
      return;
    }
    if (isProtectedMarketItem(item.itemId)) {
      res.status(400).json({
        error: `${protectedMarketItemName(item.itemId)} защищен от продажи и сохраняется для крафта перчаток`,
      });
      return;
    }
    if (
      pricing.mode === 'custom' &&
      (typeof item.priceWei !== 'string' ||
        !/^\d{1,78}$/.test(item.priceWei) ||
        item.priceWei === '0')
    ) {
      res.status(400).json({ error: 'Для собственной цены укажите положительное значение' });
      return;
    }
    selections.push({
      itemId: item.itemId,
      amount: item.amount,
      ...(pricing.mode === 'custom' ? { priceWei: item.priceWei } : {}),
    });
  }

  const loaded = await loadBundleAndAccounts(body.password, res);
  if (!loaded) return;
  const selectedAccount = loaded.find(({ account }) => account.name === body.accountAlias)?.account;
  if (!selectedAccount) {
    res.status(404).json({ error: 'Аккаунт не найден' });
    return;
  }
  const key = `${selectedAccount.name}:${body.requestId}`;
  const fingerprint = JSON.stringify({ selections, pricing: rawPricing });
  const existing = manualListingRequests.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      res.status(409).json({ error: 'requestId уже использован для другого набора предметов' });
      return;
    }
    try {
      res.json(await existing.promise);
    } catch (error) {
      res.status(error instanceof ManualListingValidationError ? 400 : 500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const operation = listSelectedInventoryItems(
    selectedAccount,
    selections,
    pricing,
    createLogger(),
  );
  manualListingRequests.set(key, { fingerprint, promise: operation });
  const expiry = setTimeout(() => manualListingRequests.delete(key), 10 * 60_000);
  expiry.unref();

  try {
    res.json(await operation);
  } catch (error) {
    manualListingRequests.delete(key);
    res.status(error instanceof ManualListingValidationError ? 400 : 500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

async function listSelectedInventoryItems(
  account: Account,
  selections: ManualListingSelection[],
  pricing: ManualListingPricing,
  log: ReturnType<typeof createLogger>,
): Promise<InventoryListResponse> {
  const signerResolution = await resolveMarketplaceSigner(account, agwCliRuntime());
  const { signer, agwAddress } = signerResolution;

  const client = new GigaClient(account, log);
  const session = await resolveAccountSession({
    account,
    log,
    agwCli: agwCliRuntime(),
    ...(signerResolution.mode === 'eoa'
      ? { makeEoaSigner: async () => signerResolution.signer }
      : {}),
  });
  client.setJwt(session.loginResult.jwt);

  const [gearRaw, balancesRaw, gameCatalogRaw, gearCatalogRaw] = await Promise.all([
    client.getGearInstances(agwAddress),
    client.getItemBalances(),
    client.getGameItemsCatalog(),
    client.getGearItemsCatalog(),
  ]);
  const gear = [...extractGearList(gearRaw), ...extractBalanceList(balancesRaw)];
  const catalog = mergeCatalogs(buildCatalog(gameCatalogRaw), buildCatalog(gearCatalogRaw));
  const inventory = tallyItems(gear, catalog);
  const validationFloors =
    pricing.mode === 'custom' ? new Map<number, bigint>() : await client.getFloors();
  const prepared = prepareManualListings(inventory, validationFloors, selections, pricing);

  const items: InventoryListItemResult[] = [];
  for (let index = 0; index < prepared.length; index++) {
    const initiallyPrepared = prepared[index]!;
    const selection = selections[index]!;
    let listing = initiallyPrepared;
    let floorCheckedAt: number | undefined;
    try {
      if (pricing.mode !== 'custom') {
        const latestFloors = await client.getFloors();
        floorCheckedAt = Date.now();
        listing = prepareManualListings(inventory, latestFloors, [selection], pricing)[0]!;
      }
      const { txHash } = await listOne({
        giga: client,
        agw: signer,
        itemId: listing.itemId,
        amount: listing.amount,
        priceWei: listing.priceWei,
        log,
      });
      items.push({
        itemId: listing.itemId,
        name: listing.itemName,
        amount: listing.amount,
        priceWei: listing.priceWei.toString(),
        ...(listing.floorWei !== null ? { floorWei: listing.floorWei.toString() } : {}),
        ...(floorCheckedAt !== undefined ? { floorCheckedAt } : {}),
        status: 'submitted',
        txHash,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ itemId: listing.itemId, err: error }, 'manual listing failed');
      items.push({
        itemId: initiallyPrepared.itemId,
        name: initiallyPrepared.itemName,
        amount: initiallyPrepared.amount,
        priceWei: listing.priceWei.toString(),
        ...(listing.floorWei !== null ? { floorWei: listing.floorWei.toString() } : {}),
        ...(floorCheckedAt !== undefined ? { floorCheckedAt } : {}),
        status: 'failed',
        error: message,
      });
    }
  }

  return {
    accountAlias: account.name,
    pricingMode: pricing.mode,
    submitted: items.filter((item) => item.status === 'submitted').length,
    failed: items.filter((item) => item.status === 'failed').length,
    items,
  };
}

// ── /api/skills ───────────────────────────────────────────────────────────────

interface SkillsPreviewBody {
  password: string;
}

interface SkillsRunBody {
  password: string;
  maxUpgrades?: number;
}

interface SkillStatView {
  statId: StatId;
  name: string;
  level: number;
  maxLevel: number;
  nextCost: number;
  allowed: boolean;
}

interface SkillAccountView {
  name: string;
  alias: string;
  displayName: string;
  username?: string;
  agwAddress: string;
  noobId: number;
  skills: { skillId: number; name: string; stats: SkillStatView[] }[];
  nextUpgrade: { skillName: string; statName: string; fromLevel: number; cost: number } | null;
  error?: string;
}

export interface SkillAccountIdentity {
  alias: string;
  displayName: string;
  username?: string;
  noobId: number;
}

export function extractSkillAccountIdentity(
  alias: string,
  agwAddress: string,
  gameAccount: unknown,
  profile: unknown,
): SkillAccountIdentity {
  const display = extractAccountDisplayInfo(alias, agwAddress, gameAccount, profile);
  const noobId = extractNoobTokenId(gameAccount) ?? extractNoobTokenId(profile) ?? 0;
  return {
    alias: display.alias,
    displayName: display.displayName,
    ...(display.username ? { username: display.username } : {}),
    noobId,
  };
}

async function resolveSkillAccountIdentity(
  client: GigaClient,
  account: Account,
  agwAddress: string,
  gameAccount: unknown,
  log: ReturnType<typeof createLogger>,
): Promise<SkillAccountIdentity> {
  let profile: unknown;
  try {
    profile = await client.get<unknown>(`/api/account/${agwAddress}`, { authed: true });
  } catch (error) {
    log.warn({ account: account.name, err: error }, 'could not load skill account profile');
  }
  return extractSkillAccountIdentity(account.name, agwAddress, gameAccount, profile);
}

async function previewSkillsForAccount(
  account: Account,
  log: ReturnType<typeof createLogger>,
  allowed: Set<StatId>,
): Promise<SkillAccountView> {
  const client = new GigaClient(account, log);
  const session = await resolveAccountSession({ account, log, agwCli: agwCliRuntime() });
  const agwAddress = session.agwAddress;
  const gameAccount = session.loginResult.gameAccount;
  client.setJwt(session.loginResult.jwt);
  const identity = await resolveSkillAccountIdentity(client, account, agwAddress, gameAccount, log);
  const noobId = identity.noobId;
  if (!noobId) {
    return {
      name: identity.displayName,
      alias: identity.alias,
      displayName: identity.displayName,
      ...(identity.username ? { username: identity.username } : {}),
      agwAddress,
      noobId: 0,
      skills: [],
      nextUpgrade: null,
      error: 'noob не сминтен',
    };
  }
  const [catalogRaw, progressRaw] = await Promise.all([
    client.getSkillsCatalog(),
    client.getSkillsProgress(noobId),
  ]);
  const catalog = parseSkillCatalog(catalogRaw);
  const progress = parseSkillProgress(progressRaw);

  const allowedSkills = new Set(DEFAULT_ALLOWED_SKILLS);
  const skills = Array.from(catalog.entries())
    .filter(([id]) => allowedSkills.has(id) && progress.has(id))
    .map(([id, entry]) => {
      const prog = progress.get(id)!;
      return {
        skillId: id,
        name: entry.name,
        stats: entry.stats.map((stat) => {
          const level = currentStatLevel(prog, stat.id);
          return {
            statId: stat.id,
            name: STAT_NAMES_RU[stat.id],
            level,
            maxLevel: stat.levelsPerPoint.length,
            nextCost: level >= stat.levelsPerPoint.length ? -1 : (stat.levelsPerPoint[level] ?? -1),
            allowed: allowed.has(stat.id),
          } as SkillStatView;
        }),
      };
    });

  const next = pickNextUpgrade(catalog, progress, {
    allowedSkills: DEFAULT_ALLOWED_SKILLS,
    allowedStats: DEFAULT_ALLOWED_STATS,
  });
  const nextUpgrade = next
    ? {
        skillName: catalog.get(next.skillId)?.name ?? `skill#${next.skillId}`,
        statName: STAT_NAMES_RU[next.statId],
        fromLevel: next.fromLevel,
        cost: next.cost,
      }
    : null;

  return {
    name: identity.displayName,
    alias: identity.alias,
    displayName: identity.displayName,
    ...(identity.username ? { username: identity.username } : {}),
    agwAddress,
    noobId,
    skills,
    nextUpgrade,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Last successfully decrypted vault for the current request cycle (CapSolver key, sessions). */
let lastLoadedSecretsBundle: SecretsBundle | undefined;

async function loadBundleAndAccounts(
  password: string,
  res: Response,
): Promise<ReturnType<typeof parseAccountsFromText> | null> {
  const cfg = { encPath: dataPath('secrets.enc') };
  if (!hasEncrypted(cfg)) {
    res.status(404).json({ error: 'secrets.enc не найден' });
    return null;
  }
  if (!checkAuthLock(res)) return null;
  let bundle: SecretsBundle;
  try {
    bundle = await decryptVaultToMemory(password, cfg);
    recordAuthOutcome(true);
    lastLoadedSecretsBundle = bundle;
  } catch {
    recordAuthOutcome(false);
    res.status(403).json({ error: 'Неверный пароль' });
    return null;
  }
  try {
    const loaded = parseAccountsFromText({
      accountsText: bundle.accounts,
      proxiesText: bundle.proxies,
      accountsSourceLabel: 'accounts (encrypted)',
      proxiesSourceLabel: 'proxies (encrypted)',
    });
    rememberBundleAccountDisplayNames(bundle, loaded);
    return loaded.map((entry) => ({
      ...entry,
      account: hydrateAccountGameSession(entry.account, bundle.gameSessions),
    }));
  } catch (e) {
    res.status(400).json({ error: String(e) });
    return null;
  }
}

// ── Abstract Discover streak ─────────────────────────────────────────────────

interface DiscoverRequestBody {
  password: string;
  accountAlias?: string;
}

const activeDiscoverVotes = new Set<string>();

interface DiscoverMaintenanceSnapshot {
  state: 'locked' | 'checking' | 'ready' | 'partial_error';
  checkedAt: string | null;
  accounts: Record<string, unknown>[];
  error?: string;
}

let discoverMaintenanceSnapshot: DiscoverMaintenanceSnapshot = {
  state: 'locked',
  checkedAt: null,
  accounts: [],
};
let discoverMaintenancePromise: Promise<DiscoverMaintenanceSnapshot> | undefined;

function discoverAccountError(account: Account, error: unknown): Record<string, unknown> {
  return {
    ...uiAccountIdentity(account),
    error: error instanceof Error ? error.message : String(error),
  };
}

async function inspectDiscoverAccount(account: Account): Promise<Record<string, unknown>> {
  if (!account.agwAddress) {
    throw new Error('Для аккаунта не определён адрес Abstract');
  }
  const { pack } = hubPackManager().load();
  const dispatcher = makeProxyAgent(account.proxy);
  try {
    const client = new DiscoverClient(
      pack.modules.abstractDiscover,
      makeDiscoverTransport(dispatcher),
    );
    const snapshot = await client.getSnapshot(account.agwAddress);
    return {
      ...uiAccountIdentity(account, account.agwAddress),
      currentStreakDays: snapshot.streak.currentStreakDays,
      longestStreakDays: snapshot.streak.longestStreakDays,
      lastVoteAt: snapshot.streak.lastVoteAt,
      votedToday: snapshot.streak.votedToday,
      nextVoteBy: snapshot.streak.nextVoteBy,
      eligibleApps: snapshot.apps.filter((app) => !snapshot.votedAppIds.includes(app.id)).length,
      epoch: snapshot.epoch,
    };
  } finally {
    await dispatcher.close();
  }
}

async function voteDiscoverAccount(account: Account): Promise<Record<string, unknown>> {
  if (!account.agwAddress) {
    throw new Error('Для аккаунта не определён адрес Abstract');
  }
  const address = account.agwAddress.toLowerCase();
  if (activeDiscoverVotes.has(address)) {
    throw new Error('Голосование для этого аккаунта уже выполняется');
  }
  activeDiscoverVotes.add(address);
  const { pack } = hubPackManager().load();
  const dispatcher = makeProxyAgent(account.proxy);
  try {
    const client = new DiscoverClient(
      pack.modules.abstractDiscover,
      makeDiscoverTransport(dispatcher),
    );
    const snapshot = await client.getSnapshot(address);
    if (snapshot.streak.votedToday) {
      return {
        ...uiAccountIdentity(account, address),
        status: 'already_voted',
        currentStreakDays: snapshot.streak.currentStreakDays,
        nextVoteBy: snapshot.streak.nextVoteBy,
      };
    }

    const appChoice = pickRandomDiscoverApp(snapshot.apps, snapshot.votedAppIds);
    if (!appChoice) {
      throw new Error('Abstract не вернул ни одного доступного приложения для нового голоса');
    }
    const call = buildDiscoverVoteCall(pack.modules.abstractDiscover, appChoice.id);
    const signer = await resolveMarketplaceSigner(account, agwCliRuntime(), runtime.agwCliRunner);
    if (signer.agwAddress.toLowerCase() !== address) {
      throw new Error('Подключённый Abstract аккаунт не совпадает с выбранной строкой');
    }

    let txHash: string;
    try {
      txHash = await signer.signer.sendTransaction(call);
    } catch (error) {
      const latest = await client.getStreak(address).catch(() => undefined);
      if (latest?.votedToday) {
        return {
          ...uiAccountIdentity(account, address),
          status: 'already_voted',
          currentStreakDays: latest.currentStreakDays,
          nextVoteBy: latest.nextVoteBy,
        };
      }
      throw error;
    }

    let latest = snapshot.streak;
    for (let attempt = 0; attempt < 5 && !latest.votedToday; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
      latest = await client.getStreak(address);
    }
    return {
      ...uiAccountIdentity(account, address),
      status: latest.votedToday ? 'confirmed' : 'submitted',
      txHash,
      app: {
        id: appChoice.id,
        name: appChoice.name,
        icon: appChoice.icon ?? null,
        link: appChoice.link ?? null,
      },
      currentStreakDays: latest.currentStreakDays,
      nextVoteBy: latest.nextVoteBy,
    };
  } finally {
    activeDiscoverVotes.delete(address);
    await dispatcher.close();
  }
}

async function maintainDiscoverAccount(account: Account): Promise<Record<string, unknown>> {
  const before = await inspectDiscoverAccount(account);
  if (before['votedToday'] === true) {
    return { ...before, status: 'already_voted' };
  }
  const vote = await voteDiscoverAccount(account);
  const after = await inspectDiscoverAccount(account).catch(() => undefined);
  return { ...before, ...after, ...vote };
}

async function runDiscoverMaintenance(): Promise<DiscoverMaintenanceSnapshot> {
  if (discoverMaintenancePromise) return discoverMaintenancePromise;
  if (!unlockedMasterPassword || !hasEncrypted({ encPath: dataPath('secrets.enc') })) {
    discoverMaintenanceSnapshot = {
      state: 'locked',
      checkedAt: discoverMaintenanceSnapshot.checkedAt,
      accounts: discoverMaintenanceSnapshot.accounts,
    };
    return discoverMaintenanceSnapshot;
  }
  discoverMaintenanceSnapshot = {
    state: 'checking',
    checkedAt: discoverMaintenanceSnapshot.checkedAt,
    accounts: discoverMaintenanceSnapshot.accounts,
  };
  discoverMaintenancePromise = (async () => {
    try {
      const bundle = await decryptToMemory(unlockedMasterPassword!, {
        encPath: dataPath('secrets.enc'),
      });
      const loaded = parseAccountsFromText({
        accountsText: bundle.accounts,
        proxiesText: bundle.proxies,
        accountsSourceLabel: 'accounts (encrypted)',
        proxiesSourceLabel: 'proxies (encrypted)',
      });
      rememberBundleAccountDisplayNames(bundle, loaded);
      const accounts: Record<string, unknown>[] = [];
      for (const { account } of loaded) {
        try {
          accounts.push(await maintainDiscoverAccount(account));
        } catch (error) {
          accounts.push(discoverAccountError(account, error));
        }
      }
      const hasErrors = accounts.some((account) => typeof account['error'] === 'string');
      discoverMaintenanceSnapshot = {
        state: hasErrors ? 'partial_error' : 'ready',
        checkedAt: new Date().toISOString(),
        accounts,
      };
    } catch (error) {
      discoverMaintenanceSnapshot = {
        state: 'locked',
        checkedAt: discoverMaintenanceSnapshot.checkedAt,
        accounts: discoverMaintenanceSnapshot.accounts,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return discoverMaintenanceSnapshot;
  })().finally(() => {
    discoverMaintenancePromise = undefined;
  });
  return discoverMaintenancePromise;
}

app.get('/api/discover/maintenance', (_req: Request, res: Response) => {
  const checkedAt = discoverMaintenanceSnapshot.checkedAt
    ? Date.parse(discoverMaintenanceSnapshot.checkedAt)
    : 0;
  if (
    unlockedMasterPassword &&
    discoverMaintenanceSnapshot.state !== 'checking' &&
    Date.now() - checkedAt >= DISCOVER_MAINTENANCE_STALE_MS
  ) {
    void runDiscoverMaintenance();
  }
  res.json(discoverMaintenanceSnapshot);
});

app.post('/api/discover/status', async (req: Request, res: Response) => {
  const body = req.body as Partial<DiscoverRequestBody>;
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }
  const loaded = await loadBundleAndAccounts(body.password, res);
  if (!loaded) return;
  const results = await Promise.allSettled(
    loaded.map(({ account }) => inspectDiscoverAccount(account)),
  );
  res.json({
    checkedAt: new Date().toISOString(),
    accounts: results.map((result, index) =>
      result.status === 'fulfilled'
        ? result.value
        : discoverAccountError(loaded[index]!.account, result.reason),
    ),
  });
});

app.post('/api/discover/vote', async (req: Request, res: Response) => {
  const body = req.body as Partial<DiscoverRequestBody>;
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }
  if (body.accountAlias && !/^[a-zA-Z0-9_-]+$/.test(body.accountAlias)) {
    res.status(400).json({ error: 'Некорректный аккаунт' });
    return;
  }
  const loaded = await loadBundleAndAccounts(body.password, res);
  if (!loaded) return;
  const selected = body.accountAlias
    ? loaded.filter(({ account }) => account.name === body.accountAlias)
    : loaded;
  if (selected.length === 0) {
    res.status(404).json({ error: 'Аккаунт не найден' });
    return;
  }

  // Transactions are deliberately serialized. This keeps confirmations
  // readable and avoids hammering the same RPC/proxy pool across accounts.
  const accounts: Record<string, unknown>[] = [];
  for (const { account } of selected) {
    try {
      accounts.push(await voteDiscoverAccount(account));
    } catch (error) {
      accounts.push(discoverAccountError(account, error));
    }
  }
  res.json({ accounts });
});

// ── Cambria Genesis loot ───────────────────────────────────────────────────

interface CambriaRequestBody {
  password: string;
  inviteCode?: string;
  accountAlias?: string;
}

const cambriaAccountQueues = new Map<string, Promise<void>>();

async function runSerializedCambriaAccount<T>(
  account: Account,
  operation: () => Promise<T>,
): Promise<T> {
  const key = account.agwAddress?.toLowerCase() ?? account.name;
  const previous = cambriaAccountQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  cambriaAccountQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (cambriaAccountQueues.get(key) === tail) cambriaAccountQueues.delete(key);
  }
}

function resolveAccountCapsolverKey(account: Account, bundle?: SecretsBundle): string | undefined {
  return resolveCapsolverApiKey({
    accountKey: account.capsolver?.apiKey,
    bundleKey: bundle?.capsolverApiKey,
    envKey: process.env['CAPSOLVER_API_KEY'] ?? process.env['GIGABOT_CAPSOLVER_API_KEY'],
  });
}

function makeCambriaTurnstileSolver(
  account: Account,
  bundle?: SecretsBundle,
): (() => Promise<string>) | undefined {
  const apiKey = resolveAccountCapsolverKey(account, bundle);
  if (!apiKey) return undefined;
  const preferredTask = account.capsolver?.preferredTask;
  return async () =>
    await solveTurnstile({
      apiKey,
      websiteURL: 'https://lobby.cambria.gg',
      websiteKey: CAMBRIA_TURNSTILE_SITE_KEY,
      ...(preferredTask ? { taskType: preferredTask } : {}),
      pageAction: 'user-auth-guard',
    });
}

async function openCambriaClient(
  account: Account,
  bundle?: SecretsBundle,
): Promise<{
  client: CambriaClient;
  close: () => Promise<void>;
}> {
  if (!account.agwAddress || account.privateKey) {
    throw new Error('Cambria в хабе работает только через Abstract-аккаунт');
  }
  const address = account.agwAddress.toLowerCase();
  const cooldown = cambriaCooldownRemaining(address);
  if (cooldown > 0) {
    throw new CambriaApiError(
      'Cambria ещё держит паузу после rate limit — ждём, чтобы не усугублять 429',
      429,
      undefined,
      cooldown,
    );
  }
  const dispatcher = makeProxyAgent(account.proxy);
  try {
    const { pack } = hubPackManager().load();
    const config = pack.modules.cambria;
    const context: CambriaBrowserContext = {
      sessionKey: address,
      address,
      lobbyUrl: config.lobbyUrl,
      apiBase: config.apiBase,
      privyApiBase: config.privyApiBase,
      privyAppId: config.privyAppId,
      privyClient: config.privyClient,
      proxy: account.proxy,
    };
    const directTransport = makeCambriaTransport(dispatcher);
    const client = new CambriaClient(
      config,
      directTransport,
      runtime.cambriaBrowser
        ? (request) => runtime.cambriaBrowser!.request({ ...context, request })
        : undefined,
    );
    const solveTurnstileToken = makeCambriaTurnstileSolver(account, bundle);

    // Prefer an existing Chromium cookie jar. Re-SIWE on every status poll is what
    // produces Privy/lobby 429s when recovery timers fire.
    if (runtime.cambriaBrowser && (await runtime.cambriaBrowser.isReady(context))) {
      client.useBrowserSession(context.address);
      return { client, close: () => dispatcher.close() };
    }

    if (runtime.cambriaBrowser) {
      // Cambria identifies Abstract through Privy's cross-app login. A direct
      // SIWE signed by the AGW is a different account type and is rejected as
      // Unauthorized. Complete Cambria's official flow once and then reuse the
      // external Chromium profile once and then reuse the imported cookie jar.
      await runtime.cambriaBrowser.verify({
        ...context,
        accountLabel: accountDisplayName(account),
      });
      client.useBrowserSession(context.address);
    } else {
      const signer = runtime.agwCliRunner
        ? await makeDelegatedAgwLoginSigner(account, agwCliRuntime(), runtime.agwCliRunner)
        : await makeDelegatedAgwLoginSigner(account, agwCliRuntime());
      await client.authenticate(signer);
      await client.establishServerSession(
        solveTurnstileToken ? { solveTurnstile: solveTurnstileToken } : undefined,
      );
    }
    return { client, close: () => dispatcher.close() };
  } catch (error) {
    if (error instanceof CambriaApiError && error.status === 429) {
      noteCambriaRateLimit(address, error.retryAfterMs);
    }
    await dispatcher.close();
    throw error;
  }
}

function cambriaAccountError(account: Account, error: unknown): Record<string, unknown> {
  if (error instanceof CambriaInviteRequiredError) {
    return {
      ...uiAccountIdentity(account),
      status: 'needs_invite',
      error: error.message,
    };
  }
  if (error instanceof CambriaVerificationRequiredError) {
    return {
      ...uiAccountIdentity(account),
      status: 'needs_verification',
      error: error.message,
    };
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'CAMBRIA_LOGIN_REQUIRED'
  ) {
    return {
      ...uiAccountIdentity(account),
      status: 'needs_verification',
      error: error instanceof Error ? error.message : 'Нужно завершить вход Cambria через Abstract',
    };
  }
  const code = error instanceof CambriaApiError ? error.code : undefined;
  if (error instanceof CambriaApiError && error.status === 429) {
    noteCambriaRateLimit(account.agwAddress, error.retryAfterMs);
    const retryAfterMs = Math.max(
      CAMBRIA_RATE_LIMIT_FLOOR_MS,
      error.retryAfterMs ?? 0,
      cambriaCooldownRemaining(account.agwAddress),
    );
    return {
      ...uiAccountIdentity(account),
      status: 'rate_limited',
      error: error.message,
      ...(code ? { code } : {}),
      retryAfterMs,
    };
  }
  return {
    ...uiAccountIdentity(account),
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
    ...(code ? { code } : {}),
  };
}

async function inspectCambriaAccount(
  account: Account,
  inviteCode?: string,
  bundle?: SecretsBundle,
): Promise<Record<string, unknown>> {
  return await runSerializedCambriaAccount(account, async () => {
    const session = await openCambriaClient(account, bundle);
    try {
      const dashboard = await session.client.dashboard(inviteCode);
      return {
        ...uiAccountIdentity(account),
        status: dashboard.loot.claim
          ? 'claimed'
          : dashboard.loot.eligible
            ? 'ready'
            : 'not_eligible',
        loot: dashboard.loot,
        points: dashboard.points,
        quests: dashboard.quests,
      };
    } finally {
      await session.close();
    }
  });
}

async function claimCambriaAccount(
  account: Account,
  inviteCode?: string,
  bundle?: SecretsBundle,
): Promise<Record<string, unknown>> {
  return await runSerializedCambriaAccount(account, async () => {
    const session = await openCambriaClient(account, bundle);
    try {
      const result = await session.client.claimLoot(inviteCode);
      return {
        ...uiAccountIdentity(account),
        status: result.status,
        loot: result.loot,
        ...(result.claim ? { claim: result.claim } : {}),
      };
    } finally {
      await session.close();
    }
  });
}

function validateCambriaRequest(body: Partial<CambriaRequestBody>, res: Response): boolean {
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return false;
  }
  if (body.accountAlias && !/^[a-zA-Z0-9_-]+$/.test(body.accountAlias)) {
    res.status(400).json({ error: 'Некорректный аккаунт' });
    return false;
  }
  if (body.inviteCode && !/^[a-zA-Z0-9]{4,32}$/.test(body.inviteCode.trim())) {
    res.status(400).json({ error: 'Некорректный инвайт-код Cambria' });
    return false;
  }
  return true;
}

app.post('/api/cambria/status', async (req: Request, res: Response) => {
  const body = req.body as Partial<CambriaRequestBody>;
  if (!validateCambriaRequest(body, res)) return;
  const loaded = await loadBundleAndAccounts(body.password!, res);
  if (!loaded) return;
  const bundle = lastLoadedSecretsBundle;
  const selected = body.accountAlias
    ? loaded.filter(({ account }) => account.name === body.accountAlias)
    : loaded;
  if (selected.length === 0) {
    res.status(404).json({ error: 'Аккаунт не найден' });
    return;
  }
  const accounts: Record<string, unknown>[] = [];
  for (const [index, { account }] of selected.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, CAMBRIA_ACCOUNT_GAP_MS));
    try {
      accounts.push(await inspectCambriaAccount(account, body.inviteCode, bundle));
    } catch (error) {
      accounts.push(cambriaAccountError(account, error));
    }
  }
  res.json({
    checkedAt: new Date().toISOString(),
    accounts,
    capsolver: resolveCapsolverApiKey({
      bundleKey: bundle?.capsolverApiKey,
      envKey: process.env['CAPSOLVER_API_KEY'] ?? process.env['GIGABOT_CAPSOLVER_API_KEY'],
    })
      ? 'configured'
      : 'missing',
  });
});

app.post('/api/cambria/claim', async (req: Request, res: Response) => {
  const body = req.body as Partial<CambriaRequestBody>;
  if (!validateCambriaRequest(body, res)) return;
  const loaded = await loadBundleAndAccounts(body.password!, res);
  if (!loaded) return;
  const bundle = lastLoadedSecretsBundle;
  const selected = body.accountAlias
    ? loaded.filter(({ account }) => account.name === body.accountAlias)
    : loaded;
  if (selected.length === 0) {
    res.status(404).json({ error: 'Аккаунт не найден' });
    return;
  }
  const accounts: Record<string, unknown>[] = [];
  for (const [index, { account }] of selected.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, CAMBRIA_ACCOUNT_GAP_MS));
    try {
      accounts.push(await claimCambriaAccount(account, body.inviteCode, bundle));
    } catch (error) {
      accounts.push(cambriaAccountError(account, error));
    }
  }
  res.json({ checkedAt: new Date().toISOString(), accounts });
});

// ── Tollan Practice automation ──────────────────────────────────────────────

interface TollanRequestBody {
  password: string;
  accountAlias?: string;
}

async function loadTollanBundle(
  password: string,
  res: Response,
): Promise<{
  bundle: SecretsBundle;
  accounts: ReturnType<typeof parseAccountsFromText>;
} | null> {
  const cfg = { encPath: dataPath('secrets.enc') };
  if (!hasEncrypted(cfg)) {
    res.status(404).json({ error: 'secrets.enc не найден' });
    return null;
  }
  if (!checkAuthLock(res)) return null;
  try {
    const bundle = await decryptVaultToMemory(password, cfg);
    recordAuthOutcome(true);
    rememberVaultPassword(password);
    const accounts = parseAccountsFromText({
      accountsText: bundle.accounts,
      proxiesText: bundle.proxies,
      accountsSourceLabel: 'accounts (encrypted)',
      proxiesSourceLabel: 'proxies (encrypted)',
    });
    rememberBundleAccountDisplayNames(bundle, accounts);
    return {
      bundle,
      accounts,
    };
  } catch (error) {
    recordAuthOutcome(false);
    res.status(403).json({
      error: error instanceof Error ? error.message : 'Неверный пароль',
    });
    return null;
  }
}

function validateTollanRequest(body: Partial<TollanRequestBody>, res: Response): boolean {
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return false;
  }
  if (body.accountAlias && !/^[a-zA-Z0-9_-]+$/.test(body.accountAlias)) {
    res.status(400).json({ error: 'Некорректный аккаунт' });
    return false;
  }
  return true;
}

function tollanSessionForAccount(
  bundle: SecretsBundle,
  account: Account,
): StoredTollanSession | undefined {
  const address = account.agwAddress?.toLowerCase();
  if (!address) return undefined;
  return (
    pendingTollanSessions.get(address) ??
    storedTollanSessionForAddress(bundle.tollanSessions, address)
  );
}

function tollanInput(account: Account, session: StoredTollanSession): TollanBrowserRunInput {
  const tollan = hubPackManager().load().pack.modules.tollan;
  return {
    sessionKey: account.sessionId ?? account.name,
    accountAlias: account.name,
    address: session.agwAddress,
    proxy: account.proxy,
    hubUrl: tollan.hubUrl,
    practicePath: tollan.routes.practice,
    authStoreModuleId: tollan.auth.storeModuleId,
    session,
  };
}

async function tollanAccountViews(
  loaded: NonNullable<Awaited<ReturnType<typeof loadTollanBundle>>>,
): Promise<Record<string, unknown>[]> {
  const runtimeSnapshots = runtime.tollanBrowser ? await runtime.tollanBrowser.status() : [];
  const byAddress = new Map(runtimeSnapshots.map((entry) => [entry.address.toLowerCase(), entry]));
  return loaded.accounts.map(({ account }) => {
    const address = account.agwAddress?.toLowerCase() ?? '';
    const session = tollanSessionForAccount(loaded.bundle, account);
    const active = byAddress.get(address);
    if (active) {
      return {
        ...active,
        ...uiAccountIdentity(account, address),
        accountAlias: account.name,
        connected: Boolean(session),
      };
    }
    return {
      ...uiAccountIdentity(account, address),
      accountAlias: account.name,
      connected: Boolean(session),
      state: session ? 'idle' : 'needs_auth',
      message: session
        ? 'Готов к бесплатному Practice'
        : 'Переподключите аккаунт один раз для Tollan',
      wave: 0,
      updatedAt: session?.capturedAt ?? Date.now(),
    };
  });
}

app.post('/api/tollan/status', async (req: Request, res: Response) => {
  const body = req.body as Partial<TollanRequestBody>;
  if (!validateTollanRequest(body, res)) return;
  const loaded = await loadTollanBundle(body.password!, res);
  if (!loaded) return;
  const accounts = await tollanAccountViews(loaded);
  res.json({
    available: Boolean(runtime.tollanBrowser),
    checkedAt: new Date().toISOString(),
    accounts: body.accountAlias
      ? accounts.filter((account) => account['alias'] === body.accountAlias)
      : accounts,
  });
});

app.post('/api/tollan/run', async (req: Request, res: Response) => {
  const body = req.body as Partial<TollanRequestBody>;
  if (!validateTollanRequest(body, res)) return;
  if (!runtime.tollanBrowser) {
    res.status(409).json({ error: 'Tollan доступен только в desktop-приложении' });
    return;
  }
  const loaded = await loadTollanBundle(body.password!, res);
  if (!loaded) return;
  const selected = body.accountAlias
    ? loaded.accounts.filter(({ account }) => account.name === body.accountAlias)
    : loaded.accounts;
  if (selected.length === 0) {
    res.status(404).json({ error: 'Аккаунт не найден' });
    return;
  }

  for (const { account } of selected) {
    const session = tollanSessionForAccount(loaded.bundle, account);
    if (!session) continue;
    await runtime.tollanBrowser.start(tollanInput(account, session));
  }
  res.status(202).json({ accounts: await tollanAccountViews(loaded) });
});

app.post('/api/tollan/stop', async (req: Request, res: Response) => {
  const body = req.body as Partial<TollanRequestBody>;
  if (!validateTollanRequest(body, res)) return;
  if (!runtime.tollanBrowser) {
    res.json({ accounts: [] });
    return;
  }
  const loaded = await loadTollanBundle(body.password!, res);
  if (!loaded) return;
  const account = body.accountAlias
    ? loaded.accounts.find((entry) => entry.account.name === body.accountAlias)?.account
    : undefined;
  if (body.accountAlias && !account) {
    res.status(404).json({ error: 'Аккаунт не найден' });
    return;
  }
  await runtime.tollanBrowser.stop(account ? (account.sessionId ?? account.name) : undefined);
  res.json({ accounts: await tollanAccountViews(loaded) });
});

// ── Abstract flash badges / Gigaverse Racing ────────────────────────────────

interface RacingBadgeRequestBody {
  password: string;
  accountAlias?: string;
  maxSpendEth?: string;
}

function parseRacingBadgeMaxSpend(value: string | undefined): bigint {
  if (!value?.trim()) return DEFAULT_RACING_BADGE_MAX_SPEND_WEI;
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(normalized)) {
    throw new Error('Лимит покупки должен быть числом ETH с точностью до 18 знаков');
  }
  const parsed = parseEther(normalized);
  if (parsed <= 0n) throw new Error('Лимит покупки должен быть больше нуля');
  if (parsed > MAX_RACING_BADGE_MAX_SPEND_WEI) {
    throw new Error('Максимальный лимит одной покупки для бейджа — 0.01 ETH');
  }
  return parsed;
}

async function loadPortalBadgeSnapshot(
  account: Account,
  address: string,
): Promise<PortalBadgeSnapshot> {
  const { pack } = hubPackManager().load();
  const cacheKey = `${pack.modules.abstractBadges.flash.id}:${address.toLowerCase()}`;
  const cached = portalBadgeSnapshotCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return await cached.promise;

  const load = async (): Promise<PortalBadgeSnapshot> => {
    const read = async (dispatcher?: ReturnType<typeof makeProxyAgent>) => {
      const client = new PortalBadgeClient(
        pack.modules.abstractBadges.apiBase,
        makePortalBadgeTransport(dispatcher),
      );
      const claimed = await client.isBadgeClaimed(address, pack.modules.abstractBadges.flash.id);
      // Ownership remains queryable after a flash campaign closes or rotates.
      // Do not let the current-campaign endpoint hide an already minted badge.
      if (claimed) return { claimed };
      const current = await client.getCurrentFlashBadge();
      verifyFlashCampaign(pack.modules.abstractBadges.flash, current);
      return { current, claimed };
    };

    try {
      // Portal profiles are public and are the source of truth for a completed
      // claim. Read them directly first so a stale account proxy cannot hide a
      // badge that Portal has already indexed.
      return await read();
    } catch (directError) {
      const dispatcher = makeProxyAgent(account.proxy);
      try {
        return await read(dispatcher);
      } catch (proxyError) {
        const detail = proxyError instanceof Error ? proxyError.message : String(proxyError);
        throw new AggregateError(
          [directError, proxyError],
          `Не удалось проверить бейдж в Abstract Portal: ${detail}`,
          { cause: proxyError },
        );
      } finally {
        await dispatcher.close();
      }
    }
  };

  const promise = load();
  portalBadgeSnapshotCache.set(cacheKey, {
    expiresAt: Date.now() + PORTAL_BADGE_SNAPSHOT_CACHE_MS,
    promise,
  });
  try {
    return await promise;
  } catch (error) {
    if (portalBadgeSnapshotCache.get(cacheKey)?.promise === promise) {
      portalBadgeSnapshotCache.delete(cacheKey);
    }
    throw error;
  }
}

async function runSerializedPortalClaim<T>(operation: () => Promise<T>): Promise<T> {
  const previous = portalBadgeClaimQueue;
  let release!: () => void;
  portalBadgeClaimQueue = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  await previous;
  const waitMs = Math.max(
    0,
    portalBadgeClaimLastStartedAt + PORTAL_BADGE_CLAIM_GAP_MS - Date.now(),
  );
  if (waitMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
  portalBadgeClaimLastStartedAt = Date.now();
  try {
    return await operation();
  } finally {
    release();
  }
}

function minimumRacingItemFloor(
  floors: ReadonlyMap<number, bigint>,
  config: HubPack['modules']['gigaverse']['racing'],
): bigint | undefined {
  const ids = new Set([
    config.genericDungItemId,
    config.genericButterflyItemId,
    ...config.dungItemIds,
    ...config.butterflyItemIds,
  ]);
  let minimum: bigint | undefined;
  for (const itemId of ids) {
    const floor = floors.get(itemId);
    if (floor !== undefined && floor > 0n && (minimum === undefined || floor < minimum)) {
      minimum = floor;
    }
  }
  return minimum;
}

function racingBadgeAccountError(account: Account, error: unknown): Record<string, unknown> {
  return {
    ...uiAccountIdentity(account),
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  };
}

function racingBadgeCampaignEnded(
  campaign: HubPack['modules']['abstractBadges']['flash'],
  now = Date.now(),
): boolean {
  const endsAt = Date.parse(campaign.endsAt);
  return Number.isFinite(endsAt) && now >= endsAt;
}

function racingBadgeCampaignEndedError(localAction: ReturnType<BadgeActionStore['get']>): Error {
  return new Error(
    localAction?.verifiedAt
      ? 'Кампания Gigling Racing завершена. Racing-условие выполнено, но Portal не подтвердил бейдж до дедлайна.'
      : 'Кампания Gigling Racing завершена. Новый предмет не будет куплен или потрачен.',
  );
}

function racingBadgeProgress(
  account: Account,
  status: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...uiAccountIdentity(account),
    status,
    claimed: status === 'claimed',
    retryAfterMs: 5_000,
    ...extras,
  };
}

function isTransientRacingBadgeError(error: unknown): boolean {
  if (error instanceof SessionExpiredError) return true;
  if (error instanceof HttpError) {
    return error.status >= 500 || [408, 409, 425, 429].includes(error.status);
  }
  if (error instanceof PortalBadgeClaimError) {
    return error.status >= 500 || [400, 404, 408, 409, 425, 429].includes(error.status);
  }
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  if (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'EADDRNOTAVAIL',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ].includes(code)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|socket|network|fetch failed|ECONNRESET|EADDRNOTAVAIL|Abstract Portal HTTP (?:408|425|429|5\d\d)/i.test(
    message,
  );
}

function portalClaimRecoveryDelay(error: unknown): number {
  if (error instanceof PortalBadgeClaimError) {
    if (error.status === 429) {
      return Math.max(PORTAL_RATE_LIMIT_FLOOR_MS, error.retryAfterMs ?? 0);
    }
    // 400 usually means eligibility is still indexing after the racing action.
    if (error.status === 400) return 3 * 60_000;
    if ([404, 408, 409, 425].includes(error.status) || error.status >= 500) return 90_000;
  }
  return isTransientRacingBadgeError(error) ? 45_000 : 30_000;
}

function racingBadgeJobDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolveDelay) => {
    const timer = setTimeout(done, Math.max(250, ms));
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolveDelay();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function racingBadgeRetryDelay(result: Record<string, unknown>): number {
  const requested = Number(result['retryAfterMs']);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.max(2_000, Math.min(30 * 60_000, requested));
  }
  switch (result['status']) {
    case 'rate_limited':
      return PORTAL_RATE_LIMIT_FLOOR_MS;
    case 'ready_to_claim':
      return 90_000;
    case 'indexing':
      return 60_000;
    case 'waiting_race':
      return 12_000;
    case 'market_empty':
      return 30_000;
    case 'purchase_submitted':
      return 4_000;
    default:
      return 15_000;
  }
}

async function runRacingBadgeUntilTerminal(
  account: Account,
  maxSpendWei: bigint,
  signal: AbortSignal,
  onProgress: (snapshot: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  onProgress(racingBadgeProgress(account, 'processing'));
  while (!signal.aborted) {
    try {
      const result = await runRacingBadgeAccount(account, maxSpendWei, onProgress, signal);
      onProgress(result);
      if (result['status'] === 'claimed' || result['status'] === 'error') return result;
      await racingBadgeJobDelay(racingBadgeRetryDelay(result), signal);
    } catch (error) {
      if (signal.aborted) break;
      if (!isTransientRacingBadgeError(error)) throw error;
      onProgress(
        racingBadgeProgress(account, 'processing', {
          retryAfterMs: 15_000,
        }),
      );
      await racingBadgeJobDelay(15_000, signal);
    }
  }
  return racingBadgeProgress(account, 'stopped');
}

function startRacingBadgeJob(account: Account, maxSpendWei: bigint): Record<string, unknown> {
  const address = account.agwAddress?.toLowerCase();
  if (!address) return racingBadgeAccountError(account, new Error('Не найден адрес Abstract'));
  const existing = activeRacingBadgeJobs.get(address);
  if (existing?.running) return existing.snapshot;
  if (existing?.snapshot['status'] === 'claimed') return existing.snapshot;

  const controller = new AbortController();
  const job: RacingBadgeJob = {
    controller,
    promise: Promise.resolve(),
    running: true,
    snapshot: racingBadgeProgress(account, 'processing'),
    updatedAt: Date.now(),
  };
  const update = (snapshot: Record<string, unknown>): void => {
    job.snapshot = snapshot;
    job.updatedAt = Date.now();
  };
  activeRacingBadgeJobs.set(address, job);
  job.promise = runRacingBadgeUntilTerminal(account, maxSpendWei, controller.signal, update)
    .then(update)
    .catch((error: unknown) => update(racingBadgeAccountError(account, error)))
    .finally(() => {
      job.running = false;
      job.updatedAt = Date.now();
    });
  return job.snapshot;
}

function activeRacingBadgeSnapshot(account: Account): Record<string, unknown> | undefined {
  const address = account.agwAddress?.toLowerCase();
  if (!address) return undefined;
  const job = activeRacingBadgeJobs.get(address);
  if (!job) return undefined;
  if (job.running) return { ...job.snapshot, claimInProgress: true };
  if (job.snapshot['status'] === 'claimed') return { ...job.snapshot, claimInProgress: false };
  if (Date.now() - job.updatedAt <= RACING_BADGE_TERMINAL_SNAPSHOT_MS) return job.snapshot;
  activeRacingBadgeJobs.delete(address);
  return undefined;
}

function remainingDelay(isoDate: string | undefined, now = Date.now()): number {
  if (!isoDate) return 0;
  const timestamp = Date.parse(isoDate);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

function portalIndexingDelay(localAction: ReturnType<BadgeActionStore['get']>): number {
  if (!localAction?.verifiedAt) return 0;
  return Math.max(
    0,
    Date.parse(localAction.verifiedAt) + PORTAL_BADGE_INDEXING_DELAY_MS - Date.now(),
  );
}

function racingBadgeClaimPending(
  account: Account,
  localAction: ReturnType<BadgeActionStore['get']>,
  error: unknown,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const isRateLimit = error instanceof PortalBadgeClaimError && error.status === 429;
  if (isRateLimit) {
    notePortalRateLimit(
      account.agwAddress,
      error instanceof PortalBadgeClaimError ? error.retryAfterMs : undefined,
    );
  }
  const portalDelay =
    error instanceof PortalBadgeClaimError || isTransientRacingBadgeError(error)
      ? portalClaimRecoveryDelay(error)
      : 30_000;
  const rateLimitDelay = Math.max(
    portalDelay,
    remainingDelay(localAction?.claimRetryAt),
    portalCooldownRemaining(account.agwAddress),
  );
  const retryAfterMs = Math.max(
    localAction?.claimTxHash ? 20_000 : 45_000,
    rateLimitDelay,
    isRateLimit ? PORTAL_RATE_LIMIT_FLOOR_MS : 0,
  );
  return {
    ...uiAccountIdentity(account),
    // Keep "rate_limited" only for true 429; indexing waits use ready_to_claim so UI is honest.
    status: localAction?.claimTxHash
      ? 'claim_submitted'
      : isRateLimit
        ? 'rate_limited'
        : 'ready_to_claim',
    claimed: false,
    claimError: error instanceof Error ? error.message : String(error),
    retryAfterMs,
    ...(localAction ? { localAction } : {}),
    ...(localAction?.claimTxHash ? { claimTxHash: localAction.claimTxHash } : {}),
    ...extras,
  };
}

async function inspectRacingBadgeAccount(account: Account): Promise<Record<string, unknown>> {
  const { pack } = hubPackManager().load();
  const campaign = pack.modules.abstractBadges.flash;
  const log = createLogger();
  const client = new GigaClient(account, log);
  const session = await resolveAccountSession({
    account,
    log,
    agwCli: agwCliRuntime(),
  });
  const address = session.agwAddress.toLowerCase();
  client.setJwt(session.loginResult.jwt);

  const localAction = badgeActionStore().get(address, campaign.id);
  const [balancesResult, floorsResult, lobbyResult, profileResult, portalResult, listingResult] =
    await Promise.allSettled([
      client.getItemBalances(),
      client.getFloors(),
      client.syncRacingLobby(buildRacingLobbySyncRequest()),
      client.get<unknown>(`/api/account/${address}`, { authed: true }),
      loadPortalBadgeSnapshot(account, address),
      findCheapestItemListing(
        client,
        [
          pack.modules.gigaverse.racing.genericDungItemId,
          pack.modules.gigaverse.racing.genericButterflyItemId,
        ],
        address,
      ),
    ]);

  const floors =
    floorsResult.status === 'fulfilled' ? floorsResult.value : new Map<number, bigint>();
  const inventory = summarizeRacingInventory(
    balancesResult.status === 'fulfilled' ? balancesResult.value : [],
    pack.modules.gigaverse.racing,
    floors,
  );
  const liveRaces =
    lobbyResult.status === 'fulfilled'
      ? extractLiveRaces(lobbyResult.value, pack.modules.gigaverse.racing.livePhase).length
      : 0;
  const display = extractAccountDisplayInfo(
    account.name,
    address,
    session.loginResult.gameAccount,
    profileResult.status === 'fulfilled' ? profileResult.value : undefined,
  );
  rememberAccountDisplayName(account, display.displayName);
  const claimed = portalResult.status === 'fulfilled' && portalResult.value.claimed;
  const portalError =
    portalResult.status === 'rejected'
      ? portalResult.reason instanceof Error
        ? portalResult.reason.message
        : String(portalResult.reason)
      : undefined;
  const racingError =
    lobbyResult.status === 'rejected'
      ? lobbyResult.reason instanceof Error
        ? lobbyResult.reason.message
        : String(lobbyResult.reason)
      : balancesResult.status === 'rejected'
        ? balancesResult.reason instanceof Error
          ? balancesResult.reason.message
          : String(balancesResult.reason)
        : undefined;
  const marketError =
    listingResult.status === 'rejected'
      ? listingResult.reason instanceof Error
        ? listingResult.reason.message
        : String(listingResult.reason)
      : undefined;
  const marketListing = listingResult.status === 'fulfilled' ? listingResult.value : undefined;

  let status = 'ready';
  if (claimed) {
    status = 'claimed';
    if (localAction) {
      try {
        badgeActionStore().clearClaimRetry(address, campaign.id);
      } catch {
        // Portal ownership is authoritative.
      }
    }
  } else if (localAction?.claimTxHash) status = 'claim_submitted';
  else if (remainingDelay(localAction?.claimRetryAt) > 0) status = 'ready_to_claim';
  else if (localAction?.state === 'completed' && !localAction.verifiedAt)
    status = 'action_unverified';
  else if (localAction?.state === 'completed' && portalIndexingDelay(localAction) > 0)
    status = 'indexing';
  else if (localAction?.state === 'completed') status = 'ready_to_claim';
  else if (localAction?.state === 'submitted') status = 'watching_race';
  else if (localAction?.state === 'pending') status = 'pending_review';
  else if (portalError || racingError || (!inventory.selected && marketError)) status = 'error';
  else if (!inventory.selected) status = marketListing ? 'needs_purchase' : 'market_empty';
  else if (liveRaces === 0) status = 'waiting_race';

  const marketFloor =
    marketListing?.priceWei ?? minimumRacingItemFloor(floors, pack.modules.gigaverse.racing);
  return {
    name: display.displayName,
    alias: display.alias,
    displayName: display.displayName,
    ...(display.username ? { username: display.username } : {}),
    address,
    status,
    claimed,
    portalVerified: portalResult.status === 'fulfilled',
    inventory: {
      dung: inventory.dung,
      butterfly: inventory.butterfly,
      total: inventory.total,
      ...(inventory.selected
        ? {
            selected: {
              ...inventory.selected,
              ...(inventory.selected.floorWei !== undefined
                ? { floorWei: inventory.selected.floorWei.toString() }
                : {}),
            },
          }
        : {}),
      ...(marketFloor !== undefined ? { marketFloorWei: marketFloor.toString() } : {}),
      ...(marketListing
        ? {
            marketItemId: marketListing.itemId,
            marketListingId: marketListing.listingId.toString(),
          }
        : {}),
    },
    liveRaces,
    ...(localAction
      ? {
          localAction: {
            state: localAction.state,
            itemId: localAction.itemId,
            raceId: localAction.raceId,
            startedAt: localAction.startedAt,
            ...(localAction.queuedAt ? { queuedAt: localAction.queuedAt } : {}),
            ...(localAction.serverSubmittedAt
              ? { serverSubmittedAt: localAction.serverSubmittedAt }
              : {}),
            ...(localAction.completedAt ? { completedAt: localAction.completedAt } : {}),
            ...(localAction.verifiedAt ? { verifiedAt: localAction.verifiedAt } : {}),
            ...(localAction.appliedAt ? { appliedAt: localAction.appliedAt } : {}),
            ...(localAction.claimTxHash ? { claimTxHash: localAction.claimTxHash } : {}),
            ...(localAction.claimSubmittedAt
              ? { claimSubmittedAt: localAction.claimSubmittedAt }
              : {}),
            ...(localAction.claimRetryAt ? { claimRetryAt: localAction.claimRetryAt } : {}),
          },
        }
      : {}),
    ...(portalError ? { portalError } : {}),
    ...(racingError ? { racingError } : {}),
    ...(marketError ? { marketError } : {}),
  };
}

async function waitForRacingConsumable(
  client: GigaClient,
  config: HubPack['modules']['gigaverse']['racing'],
  floors: ReadonlyMap<number, bigint>,
): Promise<ReturnType<typeof summarizeRacingInventory>> {
  let inventory = summarizeRacingInventory([], config, floors);
  for (let attempt = 0; attempt < 24; attempt++) {
    if (attempt > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
    }
    inventory = summarizeRacingInventory(await client.getItemBalances(), config, floors);
    if (inventory.selected) break;
  }
  return inventory;
}

async function runRacingBadgeAccount(
  account: Account,
  maxSpendWei: bigint,
  onProgress: (snapshot: Record<string, unknown>) => void = () => undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!account.agwAddress) throw new Error('Для аккаунта не определён адрес Abstract');
  const address = account.agwAddress.toLowerCase();
  if (activeRacingBadgeActions.has(address)) {
    throw new Error('Операция бейджа для этого аккаунта уже выполняется');
  }
  activeRacingBadgeActions.add(address);
  const { pack } = hubPackManager().load();
  const campaign = pack.modules.abstractBadges.flash;
  const store = badgeActionStore();
  onProgress(racingBadgeProgress(account, 'processing'));

  try {
    let localAction = store.get(address, campaign.id);
    const campaignEnded = racingBadgeCampaignEnded(campaign);
    let portal: Awaited<ReturnType<typeof loadPortalBadgeSnapshot>>;
    try {
      portal = await loadPortalBadgeSnapshot(account, address);
    } catch (error) {
      if (campaignEnded) {
        return racingBadgeAccountError(account, racingBadgeCampaignEndedError(localAction));
      }
      if (localAction?.state === 'completed' && localAction.verifiedAt) {
        localAction = store.deferClaim(address, campaign.id, portalClaimRecoveryDelay(error));
        return racingBadgeClaimPending(account, localAction, error);
      }
      throw error;
    }
    if (portal.claimed) {
      try {
        store.clearClaimRetry(address, campaign.id);
      } catch {
        // Local store is best-effort once Portal already shows ownership.
      }
      return {
        ...uiAccountIdentity(account, address),
        status: 'claimed',
        claimed: true,
      };
    }
    if (campaignEnded) {
      return racingBadgeAccountError(account, racingBadgeCampaignEndedError(localAction));
    }

    if (localAction?.claimTxHash) {
      return {
        ...uiAccountIdentity(account, address),
        status: 'claim_submitted',
        claimed: false,
        claimTxHash: localAction.claimTxHash,
        localAction,
        retryAfterMs: 12_000,
      };
    }

    const claimRetryDelay = remainingDelay(localAction?.claimRetryAt);
    if (localAction?.verifiedAt && claimRetryDelay > 0) {
      return racingBadgeClaimPending(
        account,
        localAction,
        new PortalBadgeClaimError(
          'Portal индексирует racing-действие; хаб повторит клейм автоматически',
          400,
          claimRetryDelay,
        ),
      );
    }

    let signerResolution: Awaited<ReturnType<typeof resolveMarketplaceSigner>> | undefined;
    const transactionSigner = async (): Promise<
      Awaited<ReturnType<typeof resolveMarketplaceSigner>>
    > => {
      signerResolution ??= await resolveMarketplaceSigner(
        account,
        agwCliRuntime(),
        runtime.agwCliRunner,
      );
      if (signerResolution.agwAddress.toLowerCase() !== address) {
        throw new Error('Подключённый Abstract аккаунт не совпадает с выбранной строкой');
      }
      return signerResolution;
    };

    let gameClient: GigaClient | undefined;
    const racingClient = async (): Promise<GigaClient> => {
      if (gameClient) return gameClient;
      const log = createLogger();
      const client = new GigaClient(account, log);
      const session = await resolveAccountSession({ account, log, agwCli: agwCliRuntime() });
      if (session.agwAddress.toLowerCase() !== address) {
        throw new Error('Игровая сессия Gigaverse принадлежит другому Abstract-аккаунту');
      }
      client.setJwt(session.loginResult.jwt);
      gameClient = client;
      return client;
    };

    if (localAction?.state === 'pending') {
      const pendingSnapshot = racingBadgeProgress(account, 'pending_review', {
        localAction,
        retryAfterMs: 5_000,
      });
      onProgress(pendingSnapshot);
      try {
        const startedAt = Date.parse(localAction.startedAt);
        const resolution = resolvePendingRacingAction(
          await (await racingClient()).tickRacingRace(localAction.raceId),
          {
            raceId: localAction.raceId,
            petId: localAction.petId,
            itemId: localAction.itemId,
            address,
            startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() - 60_000,
          },
        );
        if (resolution.submission) {
          localAction = store.markSubmitted(address, campaign.id, {
            scheduledTick: resolution.submission.scheduledTick,
            serverSubmittedAt: resolution.submission.submittedAt,
          });
        } else if (resolution.finished) {
          const error = new RacingActionNotAppliedError(
            'Гонка завершилась, но предмет не был поставлен в очередь',
          );
          store.fail(address, campaign.id, error.message);
          throw error;
        } else {
          return pendingSnapshot;
        }
      } catch (error) {
        if (error instanceof RacingActionNotAppliedError) throw error;
        return pendingSnapshot;
      }
    }

    let purchase: Awaited<ReturnType<typeof buyCheapestItem>> | undefined;
    let actionResult: Record<string, unknown> | undefined;
    if (localAction?.state === 'submitted') {
      if (!localAction.serverSubmittedAt) {
        return {
          ...uiAccountIdentity(account, address),
          status: 'pending_review',
          claimed: false,
          localAction,
          error: 'У сохранённой Racing-операции нет идентификатора серверной очереди',
        };
      }
      try {
        onProgress(
          racingBadgeProgress(account, 'watching_race', {
            localAction,
            retryAfterMs: 5_000,
          }),
        );
        const verification = await watchRacingItemApplication({
          client: await racingClient(),
          raceId: localAction.raceId,
          petId: localAction.petId,
          itemId: localAction.itemId,
          address,
          submittedAt: localAction.serverSubmittedAt,
          ...(signal ? { signal } : {}),
        });
        localAction = store.complete(address, campaign.id, {
          appliedAt: verification.appliedAt,
          lastResolvedTick: verification.lastResolvedTick,
        });
        actionResult = {
          raceId: localAction.raceId,
          petId: localAction.petId,
          item: { itemId: localAction.itemId },
          appliedAt: verification.appliedAt,
          lastResolvedTick: verification.lastResolvedTick,
        };
      } catch (error) {
        if (error instanceof RacingActionNotAppliedError) {
          store.fail(address, campaign.id, error.message);
          throw error;
        }
        return {
          ...uiAccountIdentity(account, address),
          status: 'watching_race',
          claimed: false,
          localAction: store.get(address, campaign.id),
          retryAfterMs: 15_000,
          racingError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const needsFreshRacingAction =
      !localAction ||
      localAction.state === 'failed' ||
      (localAction.state === 'completed' && !localAction.verifiedAt);
    if (needsFreshRacingAction) {
      const client = await racingClient();

      const [balances, floors] = await Promise.all([
        client.getItemBalances(),
        client.getFloors().catch(() => new Map<number, bigint>()),
      ]);
      let inventory = summarizeRacingInventory(balances, pack.modules.gigaverse.racing, floors);
      if (!inventory.selected) {
        const signer = await transactionSigner();
        purchase = await buyCheapestItem({
          giga: client,
          sender: signer.signer,
          buyer: address,
          itemIds: [
            pack.modules.gigaverse.racing.genericDungItemId,
            pack.modules.gigaverse.racing.genericButterflyItemId,
          ],
          maxPriceWei: maxSpendWei,
        });
        inventory = await waitForRacingConsumable(client, pack.modules.gigaverse.racing, floors);
        if (!inventory.selected) {
          return {
            ...uiAccountIdentity(account, address),
            status: 'purchase_submitted',
            claimed: false,
            purchase: {
              itemId: purchase.itemId,
              listingId: purchase.listingId.toString(),
              priceWei: purchase.priceWei.toString(),
              txHash: purchase.txHash,
            },
          };
        }
      }

      const selectedItem = inventory.selected;
      const target = await findLiveRacingTarget(client, pack.modules.gigaverse.racing);
      if (!target) {
        return {
          ...uiAccountIdentity(account, address),
          status: 'waiting_race',
          claimed: false,
          inventory: {
            dung: inventory.dung,
            butterfly: inventory.butterfly,
            total: inventory.total,
          },
          ...(purchase
            ? {
                purchase: {
                  itemId: purchase.itemId,
                  listingId: purchase.listingId.toString(),
                  priceWei: purchase.priceWei.toString(),
                  txHash: purchase.txHash,
                },
              }
            : {}),
        };
      }

      store.begin({
        badgeId: campaign.id,
        address,
        raceId: target.raceId,
        petId: target.petId,
        itemId: selectedItem.itemId,
      });
      let serverRejected = false;
      let queued = false;
      try {
        const response = await client.useRacingItem(target.raceId, {
          petId: target.petId,
          itemId: selectedItem.itemId,
          amount: 1,
        });
        serverRejected =
          Boolean(response) &&
          typeof response === 'object' &&
          !Array.isArray(response) &&
          (response as Record<string, unknown>)['success'] === false;
        const accepted = assertRacingItemAccepted(response);
        localAction = store.markSubmitted(address, campaign.id, {
          scheduledTick: accepted.scheduledTick,
          serverSubmittedAt: accepted.submittedAt,
        });
        queued = true;
        onProgress(
          racingBadgeProgress(account, 'watching_race', {
            localAction,
            retryAfterMs: 5_000,
          }),
        );
        const verification = await watchRacingItemApplication({
          client,
          raceId: target.raceId,
          petId: target.petId,
          itemId: selectedItem.itemId,
          address,
          submittedAt: accepted.submittedAt,
          ...(signal ? { signal } : {}),
        });
        localAction = store.complete(address, campaign.id, {
          appliedAt: verification.appliedAt,
          lastResolvedTick: verification.lastResolvedTick,
        });
        actionResult = {
          item: {
            itemId: selectedItem.itemId,
            kind: selectedItem.kind,
            variant: selectedItem.variant,
            count: selectedItem.count,
            ...(selectedItem.floorWei !== undefined
              ? { floorWei: selectedItem.floorWei.toString() }
              : {}),
          },
          raceId: target.raceId,
          petId: target.petId,
          currentTick: accepted.currentTick,
          scheduledTick: accepted.scheduledTick,
          appliedAt: verification.appliedAt,
          lastResolvedTick: verification.lastResolvedTick,
        };
      } catch (error) {
        const definiteRejection =
          error instanceof RacingActionNotAppliedError ||
          (!queued &&
            (serverRejected ||
              error instanceof SessionExpiredError ||
              (error instanceof HttpError && error.status < 500)));
        if (definiteRejection) {
          try {
            store.fail(
              address,
              campaign.id,
              error instanceof Error ? error.message : String(error),
            );
          } catch {
            // The pending record remains the safer state if persistence changed unexpectedly.
          }
        }
        if (queued && !definiteRejection) {
          return {
            ...uiAccountIdentity(account, address),
            status: 'watching_race',
            claimed: false,
            localAction: store.get(address, campaign.id),
            retryAfterMs: 15_000,
            racingError: error instanceof Error ? error.message : String(error),
            ...(actionResult ?? {}),
          };
        }
        if (!queued && !definiteRejection) {
          return {
            ...uiAccountIdentity(account, address),
            status: 'pending_review',
            claimed: false,
            localAction: store.get(address, campaign.id),
            error: 'Gigaverse не дал однозначный ответ. Повторный расход заблокирован до проверки.',
          };
        }
        throw error;
      }
    }

    if (!localAction?.verifiedAt) {
      throw new Error('Racing-действие ещё не подтверждено сервером Gigaverse');
    }

    const indexingDelay = portalIndexingDelay(localAction);
    if (indexingDelay > 0) {
      onProgress(
        racingBadgeProgress(account, 'indexing', {
          localAction,
          retryAfterMs: indexingDelay,
        }),
      );
      if (signal) await racingBadgeJobDelay(indexingDelay, signal);
      else await new Promise((resolveDelay) => setTimeout(resolveDelay, indexingDelay));
      if (signal?.aborted) throw new Error('Операция остановлена');
    }

    const portalCooldown = portalCooldownRemaining(address);
    if (portalCooldown > 0) {
      return racingBadgeClaimPending(
        account,
        localAction,
        new PortalBadgeClaimError(
          'Portal ещё держит паузу после rate limit — ждём, чтобы не усугублять 429',
          429,
          portalCooldown,
        ),
        {
          ...(actionResult ?? {}),
        },
      );
    }

    try {
      const signer = await transactionSigner();
      const portalLoginSigner =
        signer.mode === 'eoa'
          ? signer.signer
          : runtime.agwCliRunner
            ? await makeDelegatedAgwLoginSigner(account, agwCliRuntime(), runtime.agwCliRunner)
            : await makeDelegatedAgwLoginSigner(account, agwCliRuntime());
      const mint = await runSerializedPortalClaim(async () => {
        const dispatcher = makeProxyAgent(account.proxy);
        try {
          const portalClient = new PortalBadgeClaimClient(
            pack.modules.abstractBadges,
            makePortalClaimTransport(dispatcher),
          );
          const cachedPortalSession = portalAuthSessions.get(address);
          if (cachedPortalSession) portalClient.restoreSession(cachedPortalSession, address);
          return await mintPortalBadge({
            client: portalClient,
            signer: portalLoginSigner,
            sender: signer.signer,
            badgeContract: pack.modules.abstractBadges.badgeContract as Address,
            badgeId: campaign.id,
            address: address as Address,
            // One claim request per durable cycle. The same Privy session is reused,
            // and the public Portal profile is polled between attempts.
            claimAttempts: 1,
            onAuthenticated: (session) => {
              portalAuthSessions.set(address, session);
            },
            onTransactionSubmitted: (txHash) => {
              localAction = store.markClaimSubmitted(address, campaign.id, txHash);
            },
          });
        } finally {
          await dispatcher.close();
        }
      });
      portalBadgeSnapshotCache.delete(`${campaign.id}:${address}`);
      return {
        ...uiAccountIdentity(account, address),
        status: mint.validated ? 'claimed' : 'claim_submitted',
        claimed: mint.validated,
        ...(mint.txHash ? { claimTxHash: mint.txHash } : {}),
        ...(localAction ? { localAction } : {}),
        ...(mint.validated ? {} : { retryAfterMs: 12_000 }),
        ...(actionResult ?? {}),
        ...(purchase
          ? {
              purchase: {
                itemId: purchase.itemId,
                listingId: purchase.listingId.toString(),
                priceWei: purchase.priceWei.toString(),
                txHash: purchase.txHash,
              },
            }
          : {}),
      };
    } catch (error) {
      if (error instanceof PortalBadgeClaimError && error.status === 401) {
        portalAuthSessions.delete(address);
      }
      if (localAction?.state === 'completed' && localAction.verifiedAt) {
        if (error instanceof PortalBadgeClaimError || isTransientRacingBadgeError(error)) {
          localAction = store.deferClaim(address, campaign.id, portalClaimRecoveryDelay(error));
        }
        return racingBadgeClaimPending(account, localAction, error, {
          ...(actionResult ?? {}),
          ...(purchase
            ? {
                purchase: {
                  itemId: purchase.itemId,
                  listingId: purchase.listingId.toString(),
                  priceWei: purchase.priceWei.toString(),
                  txHash: purchase.txHash,
                },
              }
            : {}),
        });
      }
      throw error;
    }
  } finally {
    activeRacingBadgeActions.delete(address);
  }
}

async function inspectOrResumeRacingBadgeAccount(
  account: Account,
): Promise<Record<string, unknown>> {
  const activeSnapshot = activeRacingBadgeSnapshot(account);
  const { pack } = hubPackManager().load();
  const address = account.agwAddress?.toLowerCase();
  if (activeSnapshot && address && activeSnapshot['status'] !== 'claimed') {
    try {
      const portal = await loadPortalBadgeSnapshot(account, address);
      if (portal.claimed) {
        const claimed = racingBadgeProgress(account, 'claimed', {
          address,
          claimed: true,
          retryAfterMs: 0,
        });
        const job = activeRacingBadgeJobs.get(address);
        if (job) {
          job.snapshot = claimed;
          job.updatedAt = Date.now();
        }
        return claimed;
      }
    } catch {
      // Keep the durable background job alive when the public profile is temporarily unavailable.
    }
  }
  if (activeSnapshot) return activeSnapshot;
  const localAction = address
    ? badgeActionStore().get(address, pack.modules.abstractBadges.flash.id)
    : undefined;
  const resumable =
    localAction?.state === 'pending' ||
    localAction?.state === 'submitted' ||
    (localAction?.state === 'completed' && Boolean(localAction.verifiedAt));
  if (address && localAction && resumable) {
    try {
      const portal = await loadPortalBadgeSnapshot(account, address);
      if (portal.claimed) {
        return racingBadgeProgress(account, 'claimed', {
          address,
          claimed: true,
          retryAfterMs: 0,
        });
      }
    } catch {
      // The resumable job owns retries and keeps the consumable protected.
    }
    return startRacingBadgeJob(account, DEFAULT_RACING_BADGE_MAX_SPEND_WEI);
  }
  return inspectRacingBadgeAccount(account);
}

app.post('/api/badges/racing/status', async (req: Request, res: Response) => {
  const body = req.body as Partial<RacingBadgeRequestBody>;
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }
  const loaded = await loadBundleAndAccounts(body.password, res);
  if (!loaded) return;
  const { pack } = hubPackManager().load();
  const accounts: Record<string, unknown>[] = [];
  for (const { account } of loaded) {
    try {
      accounts.push(
        await withTimeout(
          inspectOrResumeRacingBadgeAccount(account),
          300_000,
          'Проверка Racing и Portal превысила 5 минут. Хаб продолжит с сохранённого шага.',
        ),
      );
    } catch (error) {
      accounts.push(racingBadgeAccountError(account, error));
    }
  }
  res.json({
    checkedAt: new Date().toISOString(),
    campaign: pack.modules.abstractBadges.flash,
    rewardsUrl: pack.modules.abstractBadges.rewardsUrl,
    marketplaceUrl: pack.modules.gigaverse.marketplaceUrl,
    accounts,
  });
});

app.post('/api/badges/racing/run', async (req: Request, res: Response) => {
  const body = req.body as Partial<RacingBadgeRequestBody>;
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }
  if (body.accountAlias && !/^[a-zA-Z0-9_-]+$/.test(body.accountAlias)) {
    res.status(400).json({ error: 'Некорректный аккаунт' });
    return;
  }
  let maxSpendWei: bigint;
  try {
    maxSpendWei = parseRacingBadgeMaxSpend(body.maxSpendEth);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const loaded = await loadBundleAndAccounts(body.password, res);
  if (!loaded) return;
  const selected = body.accountAlias
    ? loaded.filter(({ account }) => account.name === body.accountAlias)
    : loaded;
  if (selected.length === 0) {
    res.status(404).json({ error: 'Аккаунт не найден' });
    return;
  }

  const accounts = selected.map(({ account }) => startRacingBadgeJob(account, maxSpendWei));
  const { pack } = hubPackManager().load();
  res.json({
    accounts,
    rewardsUrl: pack.modules.abstractBadges.rewardsUrl,
    marketplaceUrl: pack.modules.gigaverse.marketplaceUrl,
    maxSpendWei: maxSpendWei.toString(),
  });
});

/**
 * POST /api/skills/preview
 * Returns current skill levels + the next-best upgrade per account.
 * No state mutation — pure GET against the gigaverse API.
 */
app.post('/api/skills/preview', async (req: Request, res: Response) => {
  const body = req.body as SkillsPreviewBody;
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }
  const loaded = await loadBundleAndAccounts(body.password, res);
  if (!loaded) return;
  const log = createLogger();
  const allowed = new Set<StatId>(DEFAULT_ALLOWED_STATS);

  const results = await Promise.allSettled(
    loaded.map(({ account }) =>
      withTimeout(
        previewSkillsForAccount(account, log, allowed),
        35_000,
        'Проверка скиллов превысила 35 секунд. Проверьте прокси аккаунта.',
      ),
    ),
  );

  const accounts = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          name: loaded[i]!.account.name,
          alias: loaded[i]!.account.name,
          displayName: loaded[i]!.account.name,
          agwAddress: loaded[i]!.account.agwAddress ?? '',
          noobId: 0,
          skills: [],
          nextUpgrade: null,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        },
  );
  res.json({ accounts });
});

/**
 * POST /api/skills/run
 * Runs the combat upgrade loop for every account. Every request has a finite
 * per-account upgrade cap so a large point balance cannot look like a hang.
 */
app.post('/api/skills/run', async (req: Request, res: Response) => {
  const body = req.body as SkillsRunBody;
  if (!body.password) {
    res.status(400).json({ error: 'Пароль обязателен' });
    return;
  }
  const loaded = await loadBundleAndAccounts(body.password, res);
  if (!loaded) return;
  const log = createLogger();
  const maxUpgrades = body.maxUpgrades ?? DEFAULT_SKILLS_MAX_UPGRADES;
  if (
    !Number.isSafeInteger(maxUpgrades) ||
    maxUpgrades < 1 ||
    maxUpgrades > MAX_SKILLS_MAX_UPGRADES
  ) {
    res.status(400).json({
      error: `Лимит апгрейдов должен быть целым числом от 1 до ${MAX_SKILLS_MAX_UPGRADES}`,
    });
    return;
  }

  const results = await Promise.allSettled(
    loaded.map(async ({ account }) => {
      const client = new GigaClient(account, log);
      const session = await resolveAccountSession({ account, log, agwCli: agwCliRuntime() });
      const agwAddress = session.agwAddress;
      const gameAccount = session.loginResult.gameAccount;
      client.setJwt(session.loginResult.jwt);
      const identity = await resolveSkillAccountIdentity(
        client,
        account,
        agwAddress,
        gameAccount,
        log,
      );
      const identityView = {
        name: identity.displayName,
        alias: identity.alias,
        displayName: identity.displayName,
        ...(identity.username ? { username: identity.username } : {}),
      };
      const noobId = identity.noobId;
      if (!noobId) {
        return { ...identityView, upgraded: 0, stopReason: 'noob не сминтен' };
      }

      const result = await runSkillUpgradeLoop(client, noobId, log, {
        maxUpgrades,
        timeLimitMs: SKILLS_RUN_TIME_LIMIT_MS,
        pick: {
          allowedSkills: DEFAULT_ALLOWED_SKILLS,
          allowedStats: DEFAULT_ALLOWED_STATS,
        },
      });
      return {
        ...identityView,
        upgraded: result.upgraded.length,
        stopReason: result.stopReason,
        log: result.upgraded.map((u) => ({
          skillId: u.skillId,
          statName: STAT_NAMES_RU[u.statId],
          fromLevel: u.fromLevel,
          cost: u.cost,
        })),
      };
    }),
  );
  res.json({
    accounts: results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            name: loaded[i]!.account.name,
            alias: loaded[i]!.account.name,
            displayName: loaded[i]!.account.name,
            upgraded: 0,
            stopReason: r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
    ),
  });
});

// applyUpgradeLocally is exported so tests can reach it; reference it here to
// silence the unused-import check in some linter configs.
void applyUpgradeLocally;

// ── /api/stop ─────────────────────────────────────────────────────────────────

/**
 * POST /api/stop
 * Sends SIGINT to the active child process, if any.
 */
app.post('/api/stop', (_req: Request, res: Response) => {
  if (activeChild) {
    activeChild.kill(process.platform === 'win32' ? undefined : 'SIGINT');
    res.json({ ok: true, message: 'Отправлен сигнал остановки' });
  } else {
    res.json({ ok: true, message: 'Процесс не запущен' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function restoreBackgroundAccess(): Promise<void> {
  if (!hasEncrypted({ encPath: dataPath('secrets.enc') })) return;
  const password = await keychainLoad();
  if (!password) return;
  try {
    await decryptToMemory(password, { encPath: dataPath('secrets.enc') });
    unlockedMasterPassword = password;
    vaultSessionToken = randomBytes(32).toString('hex');
    await runDiscoverMaintenance();
  } catch {
    unlockedMasterPassword = undefined;
    await keychainClear();
  }
}

/**
 * Start the localhost UI. Desktop builds call this after Electron is ready;
 * direct `pnpm ui` execution uses the defaults below.
 */
export async function startUiServer(options: UiServerOptions = {}): Promise<UiServerHandle> {
  if (activeServer) throw new Error('Abstract Hub UI is already running');

  runtime = resolveRuntime(options);
  activeHubPackManager = undefined;
  mkdirSync(runtime.dataDir, { recursive: true });

  const host = options.host ?? DEFAULT_BIND_HOST;
  const port = options.port ?? DEFAULT_PORT;

  return await new Promise<UiServerHandle>((resolveStart, rejectStart) => {
    const server = app.listen(port, host);

    const onError = (error: Error): void => {
      server.off('listening', onListening);
      rejectStart(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      activeServer = server;
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const urlHost = host.includes(':') ? `[${host}]` : host;
      const url = `http://${urlHost}:${actualPort}`;
      activeServerUrl = url;
      console.warn(`Abstract Hub UI: ${url} (localhost-only)`);
      void restoreBackgroundAccess();
      discoverMaintenanceTimer = setInterval(
        () => void runDiscoverMaintenance(),
        DISCOVER_MAINTENANCE_INTERVAL_MS,
      );
      discoverMaintenanceTimer.unref();
      if (options.openBrowser ?? !runtime.desktop) void open(url);
      resolveStart({ server, url, stop: stopUiServer });
    };

    server.once('error', onError);
    server.once('listening', onListening);
  });
}

export async function stopUiServer(): Promise<void> {
  if (discoverMaintenanceTimer) clearInterval(discoverMaintenanceTimer);
  discoverMaintenanceTimer = undefined;
  if (discoverMaintenanceKick) clearTimeout(discoverMaintenanceKick);
  discoverMaintenanceKick = undefined;
  unlockedMasterPassword = undefined;
  vaultSessionToken = undefined;
  discoverMaintenancePromise = undefined;
  discoverMaintenanceSnapshot = { state: 'locked', checkedAt: null, accounts: [] };
  for (const operation of abstractAuthOperations.values()) {
    if (!['completed', 'failed'].includes(operation.state)) {
      operation.state = 'failed';
      operation.error = 'Приложение закрыто до завершения подключения Abstract';
      operation.abortController.abort();
    }
  }
  activeAbstractAuthOperationId = undefined;
  for (const operation of browserGameAuthOperations.values()) {
    if (operation.timeout) clearTimeout(operation.timeout);
    if (operation.state === 'awaiting_browser') {
      operation.state = 'failed';
      operation.error = 'Приложение закрыто до завершения входа Gigaverse';
    }
  }
  browserGameAuthOperations.clear();
  activeBrowserGameAuthOperationId = undefined;
  pendingGameSessions.clear();
  pendingTollanSessions.clear();
  knownAccountDisplayNames.clear();
  if (runtime.tollanBrowser) await runtime.tollanBrowser.stop();
  activeDiscoverVotes.clear();
  for (const job of activeRacingBadgeJobs.values()) job.controller.abort();
  activeRacingBadgeJobs.clear();
  activeRacingBadgeActions.clear();
  portalBadgeSnapshotCache.clear();
  portalAuthSessions.clear();
  portalBadgeClaimQueue = Promise.resolve();
  portalBadgeClaimLastStartedAt = 0;
  activeHubPackManager = undefined;
  playStarting = false;
  if (activeChild) {
    activeChild.kill(process.platform === 'win32' ? undefined : 'SIGINT');
    activeChild = undefined;
  }
  if (!activeServer) {
    activeServerUrl = undefined;
    return;
  }

  const server = activeServer;
  activeServer = undefined;
  activeServerUrl = undefined;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

// Bind to 127.0.0.1 ONLY — not 0.0.0.0. This UI receives master passwords.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startUiServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
