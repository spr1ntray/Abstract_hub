import type {
  Browser,
  CDPSession,
  Dialog,
  HTTPRequest,
  HTTPResponse,
  KeyInput,
  Page,
} from 'puppeteer-core';
import {
  approveOpenAbstractPortal,
  clickLastVisibleControl,
  clickVisibleControl,
  clickVisibleControlMatching,
} from '../adspower/abstract-portal.js';
import { AdsPowerBrowserController, type AdsPowerPageLease } from '../adspower/browser.js';
import type { DeveloperDiagnosticsBridge } from '../diagnostics/types.js';
import { inRange } from '../timing.js';
import type {
  TollanBrowserRunInput,
  TollanBrowserSessionBridge,
  TollanRunSnapshot,
} from './browser-session.js';
import {
  analyzeTollanCanvas,
  type TollanCanvasAnalysis,
  type TollanCanvasTarget,
  type TollanGameplayGuidance,
} from './canvas-vision.js';
import {
  extractTollanMissionsFromFlight,
  planTollanQuest,
  summarizeTollanQuests,
  tollanMissionProgressed,
  tollanQuestProgressFingerprint,
  type TollanMission,
  type TollanQuestPlan,
} from './quest-engine.js';

const LOAD_TIMEOUT_MS = 2 * 60_000;
const AUTH_TIMEOUT_MS = 2 * 60_000;
const PRACTICE_START_TIMEOUT_MS = 90_000;
const PRACTICE_REQUEST_GRACE_MS = 20_000;
const RUN_STALL_TIMEOUT_MS = 7 * 60_000;
const CHOICE_SETTLE_MS = 550;
const REWARD_TIMEOUT_MS = 2 * 60_000;
const QUEST_SYNC_TIMEOUT_MS = 8_000;
const MAX_QUEST_RUNS_PER_START = 10;
const TOLLAN_AUTH_PROMPT = /\b(sign in|log in|connect|play now|sign in to play)\b/i;

interface RunnerState {
  key: string;
  snapshot: TollanRunSnapshot;
  stopRequested: boolean;
  runVersion: number;
  practiceStartRequestedAt: number;
  clientReadyAt: number;
  missionVersion: number;
  missions: TollanMission[];
  missionBoardRequest: TollanServerActionRequest | undefined;
  bonusTargets: number;
  lastWaveStartedAt: number;
  lastGameDecisionAt: number;
  skillRerollUsed: boolean;
  runPromise: Promise<void> | undefined;
  page: Page | undefined;
  lease: AdsPowerPageLease | undefined;
  focusSession: CDPSession | undefined;
}

export interface TollanServerActionRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface TollanPracticeScreenAction {
  target: TollanCanvasTarget;
  message: string;
}

export function tollanPracticeScreenAction(
  analysis: TollanCanvasAnalysis,
  allowStartAction = true,
): TollanPracticeScreenAction | null {
  const completedRun = tollanCompletedRunAction(analysis);
  if (completedRun) return completedRun;
  if (analysis.screen === 'brightness') {
    return {
      target: analysis.menuTarget ?? { xRatio: 0.5, yRatio: 0.78, score: 12 },
      message: 'Сохраняем настройку яркости',
    };
  }
  if (analysis.screen === 'main_menu') {
    return {
      target: analysis.menuTarget ?? { xRatio: 0.27, yRatio: 0.42, score: 12 },
      message: 'Открываем Practice',
    };
  }
  if (analysis.screen === 'subclass' && analysis.subclassSelected && analysis.actionTarget) {
    return { target: analysis.actionTarget, message: 'Запускаем выбранный класс' };
  }
  if (allowStartAction && analysis.actionTarget && analysis.actionTarget.score >= 12) {
    return { target: analysis.actionTarget, message: 'Нажимаем найденную кнопку START' };
  }
  return null;
}

/** Fallbacks only. The primary target is detected from the rendered Unity frame. */
export const TOLLAN_PRACTICE_START_TARGETS = [
  [0.8, 0.875],
  [0.78, 0.86],
  [0.82, 0.89],
] as const;

export const TOLLAN_MAIN_MENU_TARGETS = [
  [0.27, 0.42],
  [0.265, 0.405],
  [0.275, 0.435],
] as const;

export const TOLLAN_ORBIT_PHASES: readonly (readonly KeyInput[])[] = [
  ['KeyW', 'KeyD'],
  ['KeyD'],
  ['KeyS', 'KeyD'],
  ['KeyS'],
  ['KeyS', 'KeyA'],
  ['KeyA'],
  ['KeyW', 'KeyA'],
  ['KeyW'],
];

export const TOLLAN_DECISION_POLL_MS = [65, 210] as const;

const TOLLAN_MOVEMENT_KEYS = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
] as const satisfies readonly KeyInput[];

export interface TollanControlProfile {
  clockwise: boolean;
  steeringBiasX: number;
  steeringBiasY: number;
  steeringJitter: number;
  directionCommitMs: readonly [number, number];
  lootMemoryMs: number;
  chestMemoryMs: number;
  exploreSteps: readonly [number, number];
}

function randomUnit(random: () => number): number {
  return Math.max(0, Math.min(0.999_999, random()));
}

function randomInteger(random: () => number, min: number, max: number): number {
  return Math.floor(min + randomUnit(random) * (max - min + 1));
}

/** A fresh profile changes execution cadence without changing the strategy. */
export function createTollanControlProfile(
  random: () => number = Math.random,
): TollanControlProfile {
  return {
    clockwise: randomUnit(random) >= 0.5,
    steeringBiasX: (randomUnit(random) * 2 - 1) * 0.07,
    steeringBiasY: (randomUnit(random) * 2 - 1) * 0.055,
    steeringJitter: 0.035 + randomUnit(random) * 0.055,
    directionCommitMs: [randomInteger(random, 180, 310), randomInteger(random, 430, 760)],
    lootMemoryMs: randomInteger(random, 850, 1_650),
    chestMemoryMs: randomInteger(random, 3_800, 6_800),
    exploreSteps: [randomInteger(random, 2, 4), randomInteger(random, 5, 9)],
  };
}

export function tollanMovementTransition(
  current: readonly KeyInput[],
  next: readonly KeyInput[],
): { press: KeyInput[]; release: KeyInput[] } {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  return {
    press: next.filter((key) => !currentSet.has(key)),
    release: current.filter((key) => !nextSet.has(key)),
  };
}

/** The resume overlay requires a sustained native chord, not a single repeated key. */
export function tollanResumeMovementKeys(
  current: readonly KeyInput[],
  fallbackPhase = 0,
): readonly KeyInput[] {
  const held = [
    ...new Set(
      current.filter((key): key is (typeof TOLLAN_MOVEMENT_KEYS)[number] =>
        TOLLAN_MOVEMENT_KEYS.includes(key as (typeof TOLLAN_MOVEMENT_KEYS)[number]),
      ),
    ),
  ];
  if (held.length >= 2) return held.slice(0, 2);
  for (let offset = 0; offset < TOLLAN_ORBIT_PHASES.length; offset++) {
    const phase = TOLLAN_ORBIT_PHASES[(fallbackPhase + offset) % TOLLAN_ORBIT_PHASES.length] ?? [];
    if (phase.length >= 2 && (held.length === 0 || phase.includes(held[0]!))) return phase;
  }
  return ['KeyW', 'KeyD'];
}

export function tollanMovementKeys(
  guidance: Pick<TollanGameplayGuidance, 'directionX' | 'directionY'> | undefined,
  fallbackPhase = 0,
): readonly KeyInput[] {
  if (!guidance || Math.hypot(guidance.directionX, guidance.directionY) < 0.22) {
    return TOLLAN_ORBIT_PHASES[fallbackPhase % TOLLAN_ORBIT_PHASES.length] ?? ['KeyW'];
  }
  const keys: KeyInput[] = [];
  if (guidance.directionY < -0.24) keys.push('KeyW');
  else if (guidance.directionY > 0.24) keys.push('KeyS');
  if (guidance.directionX < -0.24) keys.push('KeyA');
  else if (guidance.directionX > 0.24) keys.push('KeyD');
  return keys.length > 0
    ? keys
    : (TOLLAN_ORBIT_PHASES[fallbackPhase % TOLLAN_ORBIT_PHASES.length] ?? ['KeyW']);
}

export function tollanRunActivitySignature(analysis: TollanCanvasAnalysis, wave: number): string {
  const guidance = analysis.gameplay;
  if (!guidance) {
    return [wave, analysis.screen, ...(analysis.choiceNames ?? [])].join(':');
  }
  const bucket = (value: number | undefined, scale: number): number =>
    value === undefined ? -1 : Math.round(value * scale);
  return [
    wave,
    analysis.screen,
    guidance.mode,
    guidance.enemyCount,
    guidance.pickupKind ?? 'none',
    bucket(guidance.pickupXRatio, 16),
    bucket(guidance.pickupYRatio, 12),
    bucket(guidance.healthRatio, 10),
    bucket(guidance.boundaryStrength, 8),
  ].join(':');
}

const TOLLAN_CHOICE_FALLBACK_X = [0.5, 0.18, 0.82] as const;
const TOLLAN_CHOICE_RETRY_Y = [0.54, 0.38, 0.68, 0.48, 0.61] as const;

/** Keep retrying the strongest card while varying the safe click point inside it. */
export function tollanChoiceClickTarget(
  analysis: TollanCanvasAnalysis,
  attempt = 0,
): TollanCanvasTarget {
  const selected = analysis.choiceTarget;
  const fallbackX = TOLLAN_CHOICE_FALLBACK_X[attempt % TOLLAN_CHOICE_FALLBACK_X.length] ?? 0.5;
  return {
    xRatio: selected?.xRatio ?? fallbackX,
    yRatio: TOLLAN_CHOICE_RETRY_Y[attempt % TOLLAN_CHOICE_RETRY_Y.length] ?? 0.54,
    score: selected?.score ?? 0,
  };
}

export function tollanCompletedRunAction(
  analysis: TollanCanvasAnalysis,
): TollanPracticeScreenAction | null {
  if (analysis.screen !== 'game_over') return null;
  return {
    target: analysis.actionTarget ?? { xRatio: 0.5, yRatio: 0.64, score: 12 },
    message: 'Нажимаем Continue',
  };
}

const SUBCLASS_TARGETS: Readonly<Record<string, readonly [number, number]>> = {
  Phoenix: [0.21, 0.34],
  Scientist: [0.39, 0.34],
  Monk: [0.21, 0.48],
  Oceanus: [0.39, 0.48],
  AcolyteOfChaos: [0.21, 0.62],
  'Acolyte Of Chaos': [0.21, 0.62],
};

const SUBCLASS_RETRY_OFFSETS = [
  [0, 0],
  [0.016, 0],
  [-0.016, 0],
  [0, 0.018],
  [0, -0.018],
] as const;

export function tollanMainMenuClickTarget(
  analysis: TollanCanvasAnalysis,
  attempt = 0,
): TollanCanvasTarget {
  if (attempt === 0 && analysis.menuTarget) return analysis.menuTarget;
  const target = TOLLAN_MAIN_MENU_TARGETS[attempt % TOLLAN_MAIN_MENU_TARGETS.length]!;
  return { xRatio: target[0], yRatio: target[1], score: analysis.menuTarget?.score ?? 0 };
}

export function tollanSubclassClickTarget(
  subclassName: string | undefined,
  attempt = 0,
): TollanCanvasTarget {
  const base =
    (subclassName ? SUBCLASS_TARGETS[subclassName] : undefined) ?? SUBCLASS_TARGETS['Oceanus']!;
  const offset = SUBCLASS_RETRY_OFFSETS[attempt % SUBCLASS_RETRY_OFFSETS.length]!;
  return {
    xRatio: base[0] + offset[0],
    yRatio: base[1] + offset[1],
    score: 0,
  };
}

export function tollanPracticeStartClickTarget(
  analysis: TollanCanvasAnalysis,
  attempt = 0,
): TollanCanvasTarget {
  if (attempt === 0 && analysis.subclassSelected && analysis.actionTarget) {
    return analysis.actionTarget;
  }
  const target = TOLLAN_PRACTICE_START_TARGETS[attempt % TOLLAN_PRACTICE_START_TARGETS.length]!;
  return { xRatio: target[0], yRatio: target[1], score: analysis.actionTarget?.score ?? 0 };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeKey(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .slice(0, 128) || 'account'
  );
}

export function isTollanPracticeDocument(value: string, text: string): boolean {
  try {
    return new URL(value).pathname.startsWith('/game/practice') && !TOLLAN_AUTH_PROMPT.test(text);
  } catch {
    return false;
  }
}

export function tollanWorkerTabNeedsActivation(visibility: string): boolean {
  return visibility !== 'visible';
}

export function shouldAcceptTollanDialog(type: string): boolean {
  return type === 'beforeunload';
}

function snapshotCopy(snapshot: TollanRunSnapshot): TollanRunSnapshot {
  return structuredClone(snapshot);
}

export function tollanClientEndpoint(
  value: string,
):
  | 'get-inventory'
  | 'practice-mode-entry'
  | 'practice-start'
  | 'wave-started'
  | 'frodo-killed'
  | 'frodo-reward-collected'
  | 'practice-score'
  | null {
  try {
    const path = new URL(value).pathname.replace(/\/+$/, '');
    const endpoint =
      /\/api\/client\/(get-inventory|practice-mode-entry|practice-start|wave-started|frodo-killed|frodo-reward-collected|practice-score)$/.exec(
        path,
      )?.[1];
    return endpoint === 'get-inventory' ||
      endpoint === 'practice-mode-entry' ||
      endpoint === 'practice-start' ||
      endpoint === 'wave-started' ||
      endpoint === 'frodo-killed' ||
      endpoint === 'frodo-reward-collected' ||
      endpoint === 'practice-score'
      ? endpoint
      : null;
  } catch {
    return null;
  }
}

export function tollanPracticeScoreBelongsToCurrentRun(lastWaveStartedAt: number): boolean {
  return Number.isFinite(lastWaveStartedAt) && lastWaveStartedAt > 0;
}

export function tollanRouteUrl(hubUrl: string, route: string): string {
  const base = new URL(hubUrl);
  base.pathname = '/';
  base.hash = '';
  const normalizedRoute = route.trim().replace(/^#/, '');
  if (normalizedRoute && normalizedRoute !== '/') {
    base.hash = normalizedRoute.startsWith('/') ? normalizedRoute : `/${normalizedRoute}`;
  }
  return base.href;
}

export function tollanBatchOpenCount(label: string): number {
  const value = Number(/^batch\s+open\s*\((\d+)\)$/i.exec(label.trim())?.[1] ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function rewardSummary(body: Record<string, unknown>): string {
  const transfers = Array.isArray(body['transfers']) ? body['transfers'] : [];
  if (transfers.length === 0) return 'Забег подтверждён';
  return transfers
    .map((raw) => {
      const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const count = Math.max(1, Number(entry['rewardCount'] ?? 0));
      const inventory = String(entry['rewardInventory'] ?? 'награда');
      return inventory === 'GATCHA_CHEST' ? `сундук ×${count}` : `${inventory} ×${count}`;
    })
    .join(' · ');
}

function jitter(value: number, radius = 0.008): number {
  return value + (Math.random() * 2 - 1) * radius;
}

async function responseBody(response: HTTPResponse): Promise<Record<string, unknown>> {
  if ([204, 205].includes(response.status())) return {};
  try {
    const value = (await response.json()) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isTollanServerAction(response: HTTPResponse): boolean {
  try {
    const url = new URL(response.url());
    const headers = response.request().headers();
    return (
      url.origin === 'https://hub.tollan.io' &&
      response.request().method() === 'POST' &&
      Boolean(headers['next-action'])
    );
  } catch {
    return false;
  }
}

function isTollanMissionDocument(response: HTTPResponse): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.origin === 'https://hub.tollan.io' &&
      (url.pathname === '/' || url.pathname.startsWith('/missions/')) &&
      response.request().method() === 'GET' &&
      response.status() >= 200 &&
      response.status() < 300
    );
  } catch {
    return false;
  }
}

const SERVER_ACTION_HEADER_ALLOWLIST = new Set([
  'accept',
  'content-type',
  'next-action',
  'next-router-state-tree',
  'next-url',
]);

export function tollanServerActionRequest(request: HTTPRequest): TollanServerActionRequest | null {
  try {
    const url = new URL(request.url());
    const body = request.postData();
    if (
      url.origin !== 'https://hub.tollan.io' ||
      request.method() !== 'POST' ||
      !body ||
      !request.headers()['next-action']
    ) {
      return null;
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers()).filter(([name]) =>
        SERVER_ACTION_HEADER_ALLOWLIST.has(name.toLowerCase()),
      ),
    );
    return { url: request.url(), headers, body };
  } catch {
    return null;
  }
}

export function tollanServerActionBodyIsReadOnly(body: string): boolean {
  try {
    const value = JSON.parse(body) as unknown;
    if (!Array.isArray(value) || value.length > 1) return false;
    if (value.length === 0) return true;
    const input = value[0];
    return Boolean(
      input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.keys(input as Record<string, unknown>).length === 0,
    );
  } catch {
    return false;
  }
}

export function tollanMissionActionTemplateEligible(request: TollanServerActionRequest): boolean {
  try {
    const url = new URL(request.url);
    return (
      url.origin === 'https://hub.tollan.io' &&
      url.pathname === '/' &&
      Boolean(request.headers['next-action']) &&
      tollanServerActionBodyIsReadOnly(request.body)
    );
  } catch {
    return false;
  }
}

export function tollanMissionClaimRequest(
  template: TollanServerActionRequest,
  actionId: string,
  missionId: string,
): TollanServerActionRequest {
  if (!/^[a-f0-9]{40}$/.test(actionId)) throw new Error('Некорректный action клейма Tollan');
  if (!missionId.trim()) throw new Error('Tollan не вернул ID миссии');
  return {
    url: template.url,
    headers: { ...template.headers, 'next-action': actionId },
    body: JSON.stringify([{ missionId }]),
  };
}

export function tollanMissionBoardRequest(
  template: TollanServerActionRequest,
  actionId: string,
): TollanServerActionRequest {
  if (!/^[a-f0-9]{40}$/.test(actionId)) {
    throw new Error('Некорректный action списка миссий Tollan');
  }
  return {
    url: template.url,
    headers: { ...template.headers, 'next-action': actionId },
    body: '[{}]',
  };
}

export class AdsPowerTollanRunner implements TollanBrowserSessionBridge {
  private readonly states = new Map<string, RunnerState>();

  constructor(
    private readonly browsers: AdsPowerBrowserController,
    private readonly diagnostics?: DeveloperDiagnosticsBridge,
  ) {}

  private trace(state: RunnerState, event: string, data: unknown = {}): void {
    this.diagnostics?.record('tollan-adspower', event, {
      accountAlias: state.snapshot.accountAlias,
      address: state.snapshot.address,
      profileId: state.key,
      state: state.snapshot.state,
      data,
    });
  }

  private stateFor(input: TollanBrowserRunInput): RunnerState {
    const key = safeKey(input.adsPowerProfileId || input.sessionKey || input.address);
    let state = this.states.get(key);
    if (!state) {
      state = {
        key,
        stopRequested: false,
        runVersion: 0,
        practiceStartRequestedAt: 0,
        clientReadyAt: 0,
        missionVersion: 0,
        missions: [],
        missionBoardRequest: undefined,
        bonusTargets: 0,
        lastWaveStartedAt: 0,
        lastGameDecisionAt: 0,
        skillRerollUsed: false,
        runPromise: undefined,
        page: undefined,
        lease: undefined,
        focusSession: undefined,
        snapshot: {
          accountAlias: input.accountAlias,
          address: input.address,
          state: 'idle',
          message: 'Готов к запуску через AdsPower',
          wave: 0,
          updatedAt: Date.now(),
        },
      };
      this.states.set(key, state);
    }
    state.snapshot.accountAlias = input.accountAlias;
    state.snapshot.address = input.address;
    return state;
  }

  private update(
    state: RunnerState,
    patch: { [Key in keyof TollanRunSnapshot]?: TollanRunSnapshot[Key] | undefined },
  ): void {
    const previous = state.snapshot.state;
    Object.assign(state.snapshot, patch, { updatedAt: Date.now() });
    if (previous !== state.snapshot.state) this.trace(state, 'state_changed', { previous });
  }

  private async pageText(page: Page): Promise<string> {
    return (await page.evaluate('document.body?.innerText?.slice(0, 12000) ?? ""')) as string;
  }

  private async tollanSignedIn(page: Page): Promise<boolean> {
    const text = await this.pageText(page);
    if (/\bsign out\b/i.test(text)) return true;
    const hasVisibleAuthControl = (await page.evaluate(`(() => {
      const labels = new Set(['sign in', 'sign in to play', 'log in', 'connect', 'play now']);
      return [...document.querySelectorAll('button, a, [role="button"]')].some((element) => {
        const label = (element.textContent || '').trim().replace(/\\s+/g, ' ').toLowerCase();
        if (!labels.has(label)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    })()`)) as boolean;
    if (hasVisibleAuthControl) return false;
    try {
      const path = new URL(page.url()).pathname;
      return (
        text.trim().length > 20 &&
        (path === '/' || path.startsWith('/game/practice') || path.startsWith('/inventory/'))
      );
    } catch {
      return false;
    }
  }

  private async completeAccountOnboarding(state: RunnerState, page: Page): Promise<void> {
    const text = await this.pageText(page);
    if (!/change account name/i.test(text)) return;
    this.update(state, { state: 'loading', message: 'Завершаем настройку Tollan' });
    const input = await page.$('input:not([type="hidden"]):not([disabled])');
    if (input) {
      const value = (await page.evaluate(
        'document.querySelector(\'input:not([type="hidden"]):not([disabled])\')?.value ?? ""',
      )) as string;
      if (!String(value).trim()) {
        const suffix = state.snapshot.address.replace(/^0x/i, '').slice(-6);
        await input.type(`Abstract${suffix}`, { delay: 45 });
      }
      await input.dispose().catch(() => undefined);
    }
    const clicked = await clickVisibleControl(page, ['Continue']);
    if (!clicked) throw new Error('Tollan не дал завершить настройку имени аккаунта');
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30_000) {
      if (!/change account name/i.test(await this.pageText(page))) return;
      await delay(500);
    }
    throw new Error('Tollan не сохранил имя аккаунта');
  }

  private async ensureAuthenticated(
    state: RunnerState,
    browser: Browser,
    page: Page,
    targetUrl: string,
    expectedAddress: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const expectedOrigin = new URL(targetUrl).origin;
    let nextClickAt = 0;
    while (Date.now() - startedAt < AUTH_TIMEOUT_MS) {
      if (state.stopRequested) throw new Error('Остановлено пользователем');

      const portal = await approveOpenAbstractPortal({
        browser,
        expectedOrigin,
        expectedAddress,
      });
      if (portal) {
        this.update(state, {
          state: 'loading',
          message:
            portal.step === 'connect'
              ? 'Подключаем Tollan к Abstract'
              : 'Подтверждаем вход в Tollan',
        });
        this.trace(state, 'abstract_portal', portal);
        await delay(portal.state === 'approved' ? 900 : 500);
        continue;
      }

      if (await this.tollanSignedIn(page)) {
        await this.completeAccountOnboarding(state, page);
        const current = new URL(page.url());
        const target = new URL(targetUrl);
        if (
          current.origin !== target.origin ||
          current.pathname !== target.pathname ||
          current.search !== target.search ||
          current.hash !== target.hash
        ) {
          this.update(state, { state: 'loading', message: 'Открываем Tollan' });
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        }
        this.trace(state, 'authentication_ready');
        return;
      }

      if (Date.now() >= nextClickAt) {
        const action = await clickVisibleControl(page, [
          'Sign In',
          'Sign In to Play',
          'Play Now',
          'Connect',
          'Log In',
        ]);
        if (action) {
          this.update(state, {
            state: 'loading',
            message: /play now/i.test(action)
              ? 'Открываем вход Tollan'
              : 'Подтверждаем аккаунт Tollan',
          });
          this.trace(state, 'login_control_clicked', { label: action });
          nextClickAt = Date.now() + 3_000;
          await delay(900);
          continue;
        }
        nextClickAt = Date.now() + 1_500;
      }
      await delay(500);
    }
    this.update(state, {
      state: 'needs_auth',
      message: 'Tollan не завершил вход через Abstract',
    });
    throw new Error('Tollan не завершил автоматический вход через Abstract за 2 минуты');
  }

  private async waitForCanvas(state: RunnerState, page: Page) {
    const startedAt = Date.now();
    let canvasSeenAt = 0;
    while (Date.now() - startedAt < LOAD_TIMEOUT_MS) {
      if (state.stopRequested) throw new Error('Остановлено пользователем');
      const body = await this.pageText(page);
      if (!isTollanPracticeDocument(page.url(), body)) {
        await delay(500);
        continue;
      }
      const canvas = await page.$('canvas');
      const box = await canvas?.boundingBox();
      if (box && box.width >= 320 && box.height >= 240) {
        canvasSeenAt ||= Date.now();
        // The canvas exists throughout Unity's loading screen. The inventory call
        // is the stable signal that the interactive menu is ready. Keep a fallback
        // for a future client that renames this endpoint.
        if (state.clientReadyAt > 0 || Date.now() - canvasSeenAt >= 45_000) return box;
      }
      await delay(1_000);
    }
    throw new Error('Tollan не загрузил игровой экран за 2 минуты');
  }

  private applyMissionBoard(state: RunnerState, missions: TollanMission[]): void {
    const categories = new Set(missions.map((mission) => mission.category));
    const merged =
      categories.size === 1
        ? [...state.missions.filter((mission) => !categories.has(mission.category)), ...missions]
        : missions;
    state.missions = [...new Map(merged.map((mission) => [mission.id, mission])).values()];
    state.missionVersion++;
    const plan = planTollanQuest(missions);
    this.update(state, {
      quests: summarizeTollanQuests(missions, plan.mission),
    });
    this.trace(state, 'quest_board', {
      count: missions.length,
      target: plan.mission?.description,
      daily: state.snapshot.quests?.daily,
      weekly: state.snapshot.quests?.weekly,
    });
  }

  private monitor(state: RunnerState, page: Page): () => void {
    const dialogHandler = (dialog: Dialog) => {
      const type = dialog.type();
      this.trace(state, 'browser_dialog_opened', { type, message: dialog.message() });
      if (!shouldAcceptTollanDialog(type)) return;
      void dialog
        .accept()
        .then(() => this.trace(state, 'practice_leave_confirmed'))
        .catch((error) => this.trace(state, 'browser_dialog_failed', { type, error }));
    };
    const requestHandler = (request: { url(): string }) => {
      if (tollanClientEndpoint(request.url()) !== 'practice-start') return;
      state.practiceStartRequestedAt = Date.now();
      this.update(state, {
        state: 'starting',
        message: 'Tollan принял запуск. Ждём подтверждение',
      });
    };
    const handler = (response: HTTPResponse) => {
      void (async () => {
        if (isTollanServerAction(response) || isTollanMissionDocument(response)) {
          const text = await response.text().catch(() => '');
          const missions = extractTollanMissionsFromFlight(text);
          if (missions) this.applyMissionBoard(state, missions);

          const replay = tollanServerActionRequest(response.request());
          if (!state.missionBoardRequest && replay && tollanMissionActionTemplateEligible(replay)) {
            state.missionBoardRequest = replay;
            this.trace(state, 'quest_request_captured', {
              action: replay.headers['next-action'],
              source: missions ? 'mission-action' : 'home-action',
            });
          }
          return;
        }
        const endpoint = tollanClientEndpoint(response.url());
        if (!endpoint) return;
        const status = response.status();
        const body = await responseBody(response);
        this.trace(state, 'practice_response', { endpoint, status, body });
        if (
          status === 401 ||
          /unauthorized/i.test(String(body['message'] ?? body['error'] ?? ''))
        ) {
          this.update(state, {
            state: 'needs_auth',
            message: 'Сессия Tollan истекла. Войдите один раз в AdsPower-профиле',
            error: 'Unauthorized',
            completedAt: Date.now(),
          });
          return;
        }
        const successful = status >= 200 && status < 300 && body['success'] !== false;
        if (endpoint === 'get-inventory') {
          if (successful) {
            state.clientReadyAt = Date.now();
            this.trace(state, 'client_ready');
          }
          return;
        }
        if (endpoint === 'practice-mode-entry') {
          if (successful) state.clientReadyAt ||= Date.now();
          return;
        }
        if (endpoint === 'practice-start') {
          state.practiceStartRequestedAt = 0;
          state.snapshot.sessionId = String(
            body['sessionId'] ?? body['practiceModeUserGameSessionId'] ?? '',
          );
          if (successful) {
            state.lastWaveStartedAt = Date.now();
            this.update(state, { state: 'playing', message: 'Забег идёт автоматически', wave: 1 });
          } else {
            this.update(state, {
              state: status === 408 || status === 429 || status >= 500 ? 'starting' : 'failed',
              message: 'Tollan отклонил запуск Practice',
              error: String(body['message'] ?? body['error'] ?? `HTTP ${status}`),
            });
          }
          return;
        }
        if (endpoint === 'wave-started' && successful) {
          const wave = Math.max(1, state.snapshot.wave + 1);
          const bonusTargets = Array.isArray(body['frodo']) ? body['frodo'].length : 0;
          state.bonusTargets = bonusTargets;
          state.lastWaveStartedAt = Date.now();
          this.update(state, {
            state: 'playing',
            message: bonusTargets ? `Волна ${wave} · найден бонусный противник` : `Волна ${wave}`,
            wave,
            bonusTargets,
          });
          return;
        }
        if (endpoint === 'frodo-killed' && successful) {
          state.bonusTargets = Math.max(0, state.bonusTargets - 1);
          this.update(state, {
            message: `Волна ${state.snapshot.wave} · бонусная цель побеждена`,
            bonusTargets: state.bonusTargets,
          });
          return;
        }
        if (endpoint === 'frodo-reward-collected' && successful) {
          state.bonusTargets = 0;
          this.update(state, {
            message: `Волна ${state.snapshot.wave} · бонус собран`,
            bonusTargets: 0,
          });
          return;
        }
        if (endpoint === 'practice-score') {
          if (!tollanPracticeScoreBelongsToCurrentRun(state.lastWaveStartedAt)) {
            this.trace(state, 'stale_practice_score_ignored', { status, body });
            return;
          }
          this.update(
            state,
            successful
              ? {
                  state: 'completed',
                  message: 'Награда подтверждена Tollan',
                  reward: rewardSummary(body),
                  completedAt: Date.now(),
                }
              : {
                  state: 'failed',
                  message: 'Tollan не подтвердил награду',
                  error: String(body['message'] ?? body['error'] ?? `HTTP ${status}`),
                  completedAt: Date.now(),
                },
          );
        }
      })().catch((error) => this.trace(state, 'response_parse_failed', { error }));
    };
    page.on('dialog', dialogHandler);
    page.on('request', requestHandler);
    page.on('response', handler);
    return () => {
      page.off('dialog', dialogHandler);
      page.off('request', requestHandler);
      page.off('response', handler);
    };
  }

  private async click(
    page: Page,
    box: { x: number; y: number; width: number; height: number },
    x: number,
    y: number,
  ) {
    const canvas = await page.$('canvas');
    const currentBox = (await canvas?.boundingBox()) ?? box;
    await canvas?.dispose().catch(() => undefined);
    const clientX = currentBox.x + currentBox.width * Math.max(0, Math.min(1, x));
    const clientY = currentBox.y + currentBox.height * Math.max(0, Math.min(1, y));
    await this.focusCanvas(page);
    await page.mouse.move(clientX, clientY, { steps: inRange(3, 7) });
    await delay(inRange(45, 95));
    await page.mouse.down({ button: 'left' });
    await delay(inRange(65, 125));
    await page.mouse.up({ button: 'left' });
  }

  private async focusCanvas(page: Page): Promise<void> {
    await page.evaluate(`(() => {
      window.focus();
      const canvas = document.querySelector('canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return;
      if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '-1');
      canvas.focus({ preventScroll: true });
    })()`);
  }

  private async ensureWorkerTabActive(
    state: RunnerState,
    page: Page,
    force = false,
  ): Promise<boolean> {
    const visibility = String(
      await page.evaluate('document.visibilityState').catch(() => 'unknown'),
    );
    if (!force && !tollanWorkerTabNeedsActivation(visibility)) return false;
    if (state.lease) await state.lease.activate();
    else await page.bringToFront();
    this.trace(state, 'practice_tab_activated', { force, previousVisibility: visibility });
    return true;
  }

  private async keyDown(page: Page, input: KeyInput): Promise<void> {
    await page.keyboard.down(input);
  }

  private async keyUp(page: Page, input: KeyInput): Promise<void> {
    await page.keyboard.up(input);
  }

  private async pressKey(page: Page, input: KeyInput): Promise<void> {
    await this.keyDown(page, input);
    await delay(inRange(45, 105));
    await this.keyUp(page, input);
  }

  private async enableGameInput(state: RunnerState, page: Page): Promise<void> {
    const session = state.focusSession ?? (await page.createCDPSession());
    state.focusSession = session;
    try {
      await this.ensureWorkerTabActive(state, page);
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined);
      await this.focusCanvas(page);
      this.trace(state, 'game_input_focus_enabled', {
        hasFocus: await page.evaluate('document.hasFocus()'),
        visibility: await page.evaluate('document.visibilityState'),
      });
    } catch (error) {
      this.trace(state, 'game_input_focus_failed', { error });
      await session.detach().catch(() => undefined);
      if (state.focusSession === session) state.focusSession = undefined;
    }
  }

  private async replayMissionBoardRequest(
    state: RunnerState,
    page: Page,
    actionId: string,
  ): Promise<boolean> {
    const template = state.missionBoardRequest;
    if (!template) return false;
    const request = tollanMissionBoardRequest(template, actionId);
    const previousVersion = state.missionVersion;
    const text = (await page.evaluate(async (input) => {
      const response = await fetch(input.url, {
        method: 'POST',
        headers: input.headers,
        body: input.body,
        credentials: 'include',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    }, request)) as string;
    const missions = extractTollanMissionsFromFlight(text);
    if (missions) this.applyMissionBoard(state, missions);
    return state.missionVersion > previousVersion;
  }

  private async visitMissionBoard(
    state: RunnerState,
    page: Page,
    hubUrl: string,
    missionPath: string,
    actionId: string,
  ): Promise<boolean> {
    if (await this.replayMissionBoardRequest(state, page, actionId).catch(() => false)) return true;
    const previousVersion = state.missionVersion;
    await page.goto(tollanRouteUrl(hubUrl, missionPath), {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    const startedAt = Date.now();
    let replayAttempted = false;
    let reloadAttempted = false;
    while (Date.now() - startedAt < QUEST_SYNC_TIMEOUT_MS) {
      if (state.stopRequested) throw new Error('Остановлено пользователем');
      if (state.missionVersion > previousVersion) return true;
      if (!replayAttempted && state.missionBoardRequest) {
        replayAttempted = true;
        if (await this.replayMissionBoardRequest(state, page, actionId).catch(() => false)) {
          return true;
        }
      }
      if (!reloadAttempted && !state.missionBoardRequest && Date.now() - startedAt >= 2_000) {
        reloadAttempted = true;
        this.trace(state, 'quest_route_reload', { route: missionPath });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
      }
      await delay(350);
    }
    this.trace(state, 'quest_sync_timeout', { route: missionPath });
    return false;
  }

  private async refreshQuestBoard(
    state: RunnerState,
    page: Page,
    hubUrl: string,
    missionPath: string,
    actionId: string,
  ): Promise<TollanQuestPlan> {
    this.update(state, { state: 'loading', message: 'Читаем квесты Tollan' });
    await this.visitMissionBoard(state, page, hubUrl, missionPath, actionId);
    const plan = planTollanQuest(state.missions);
    this.update(state, {
      quests: summarizeTollanQuests(state.missions, plan.mission),
      message: plan.mission
        ? `Цель: ${plan.mission.description} · ${plan.mission.progress}/${plan.mission.goal}`
        : 'Доступные игровые квесты выполнены',
    });
    return plan;
  }

  private async enterPractice(
    state: RunnerState,
    page: Page,
    box: { x: number; y: number; width: number; height: number },
    questPlan: TollanQuestPlan,
  ): Promise<void> {
    const startedAt = Date.now();
    let cycle = 0;
    let menuOpened = false;
    let subclassSelected = false;
    let mainMenuAttempt = 0;
    let subclassAttempt = 0;
    let startAttempt = 0;
    let lastInteractionAt = 0;
    let nextTabHealthAt = 0;
    this.update(state, { state: 'starting', message: 'Запускаем Practice' });
    while (
      Date.now() - startedAt < PRACTICE_START_TIMEOUT_MS &&
      state.snapshot.state !== 'playing'
    ) {
      if (state.stopRequested) throw new Error('Остановлено пользователем');
      if (['failed', 'needs_auth'].includes(state.snapshot.state)) {
        throw new Error(state.snapshot.error || state.snapshot.message);
      }
      if (Date.now() >= nextTabHealthAt) {
        const activated = await this.ensureWorkerTabActive(state, page);
        if (activated) {
          await this.enableGameInput(state, page);
          await delay(inRange(120, 220));
        }
        nextTabHealthAt = Date.now() + 2_500;
      }
      if (state.practiceStartRequestedAt) {
        if (Date.now() - state.practiceStartRequestedAt < PRACTICE_REQUEST_GRACE_MS) {
          await delay(500);
          continue;
        }
        state.practiceStartRequestedAt = 0;
      }
      let analysis = await analyzeTollanCanvas(page);
      const currentBox = (await (await page.$('canvas'))?.boundingBox()) ?? box;
      this.trace(state, 'practice_start_screen', {
        cycle,
        menuOpened,
        subclassSelected,
        mainMenuAttempt,
        subclassAttempt,
        startAttempt,
        ...analysis,
      });

      if (analysis.screen === 'brightness') {
        const target = analysis.menuTarget ?? { xRatio: 0.5, yRatio: 0.8, score: 0 };
        this.update(state, { state: 'starting', message: 'Сохраняем настройку яркости' });
        await this.click(page, currentBox, target.xRatio, target.yRatio);
        await delay(inRange(900, 1_500));
        cycle++;
        continue;
      }

      if (analysis.screen === 'main_menu') {
        const target = tollanMainMenuClickTarget(analysis, mainMenuAttempt);
        this.update(state, { state: 'starting', message: 'Открываем Practice' });
        await this.click(page, currentBox, target.xRatio, target.yRatio);
        lastInteractionAt = Date.now();
        mainMenuAttempt++;
        menuOpened = false;
        subclassSelected = false;
        subclassAttempt = 0;
        startAttempt = 0;
        await delay(inRange(750, 1_150));
        if (mainMenuAttempt % 3 === 0) {
          const confirmation = await analyzeTollanCanvas(page);
          if (confirmation.screen === 'main_menu') {
            await this.pressKey(page, 'Enter').catch(() => undefined);
            this.trace(state, 'practice_menu_keyboard_retry', { attempt: mainMenuAttempt });
            await delay(inRange(650, 1_000));
          }
        }
        cycle++;
        continue;
      }

      if (analysis.screen === 'subclass') {
        menuOpened = true;
        if (analysis.subclassSelected && analysis.actionTarget) {
          subclassSelected = true;
        } else {
          const target = tollanSubclassClickTarget(questPlan.subclass, subclassAttempt);
          this.update(state, {
            state: 'starting',
            message: questPlan.subclass
              ? `Выбираем подкласс для квеста: ${questPlan.subclass}`
              : 'Выбираем доступный подкласс',
          });
          await this.click(
            page,
            currentBox,
            jitter(target.xRatio, 0.003),
            jitter(target.yRatio, 0.003),
          );
          lastInteractionAt = Date.now();
          subclassAttempt++;
          await delay(inRange(650, 1_000));
          const confirmation = await analyzeTollanCanvas(page);
          this.trace(state, 'practice_subclass_confirmation', {
            attempt: subclassAttempt,
            requestedSubclass: questPlan.subclass,
            ...confirmation,
          });
          if (confirmation.screen === 'subclass' && confirmation.subclassSelected) {
            analysis = confirmation;
            subclassSelected = true;
          } else {
            if (subclassAttempt % 3 === 0) {
              await this.pressKey(page, 'Enter').catch(() => undefined);
              this.trace(state, 'practice_subclass_keyboard_retry', {
                attempt: subclassAttempt,
              });
              await delay(inRange(450, 750));
            }
            cycle++;
            continue;
          }
        }

        const start = tollanPracticeStartClickTarget(analysis, startAttempt);
        this.update(state, { state: 'starting', message: 'Запускаем бесплатный Practice' });
        await this.click(
          page,
          currentBox,
          jitter(start.xRatio, 0.004),
          jitter(start.yRatio, 0.004),
        );
        lastInteractionAt = Date.now();
        startAttempt++;
        await delay(inRange(900, 1_400));
        if (!state.practiceStartRequestedAt && startAttempt % 3 === 0) {
          const confirmation = await analyzeTollanCanvas(page);
          if (confirmation.screen === 'subclass' && confirmation.subclassSelected) {
            await this.pressKey(page, 'Enter').catch(() => undefined);
            this.trace(state, 'practice_start_keyboard_retry', { attempt: startAttempt });
            await delay(inRange(650, 1_000));
          }
        }
        cycle++;
        continue;
      }

      if (analysis.actionTarget && analysis.actionTarget.score >= 12) {
        this.update(state, { state: 'starting', message: 'Нажимаем найденную кнопку START' });
        await this.click(
          page,
          currentBox,
          analysis.actionTarget.xRatio,
          analysis.actionTarget.yRatio,
        );
        await delay(inRange(1_000, 1_800));
      } else {
        const sinceInteraction = Date.now() - lastInteractionAt;
        if (sinceInteraction < 2_500) {
          await delay(450);
        } else if (subclassSelected || menuOpened) {
          const target = subclassSelected
            ? tollanPracticeStartClickTarget(analysis, startAttempt++)
            : tollanSubclassClickTarget(questPlan.subclass, subclassAttempt++);
          await this.click(page, currentBox, target.xRatio, target.yRatio);
          lastInteractionAt = Date.now();
          await delay(inRange(700, 1_100));
        } else {
          const target = tollanMainMenuClickTarget(analysis, mainMenuAttempt++);
          await this.click(page, currentBox, target.xRatio, target.yRatio);
          lastInteractionAt = Date.now();
          await delay(inRange(700, 1_100));
        }
      }
      cycle++;
    }
    if (state.snapshot.state !== 'playing') throw new Error('Tollan не подтвердил запуск Practice');
  }

  private async playUntilComplete(
    state: RunnerState,
    page: Page,
    box: { x: number; y: number; width: number; height: number },
    questPlan: TollanQuestPlan,
  ): Promise<void> {
    const controlProfile = createTollanControlProfile();
    let fallbackPhase = Math.floor(Math.random() * TOLLAN_ORBIT_PHASES.length);
    let fallbackSteps = inRange(controlProfile.exploreSteps[0], controlProfile.exploreSteps[1]);
    let nextDashAt = Date.now() + inRange(700, 1_400);
    let nextInteractAt = Date.now() + inRange(1_100, 2_000);
    let nextSteeringAt = 0;
    let nextStatusAt = 0;
    let nextTraceAt = 0;
    let rememberedPickup: TollanGameplayGuidance | undefined;
    let pickupMemoryUntil = 0;
    let choicePendingSince = 0;
    let choiceAttempt = 0;
    let nextChoiceAttemptAt = 0;
    let nonGameplaySince = 0;
    let lastActivitySignature = '';
    let lastProgressAt = Date.now();
    let lastWaveActivityAt = state.lastWaveStartedAt;
    let nextMovementHeartbeatAt = Date.now() + inRange(650, 1_150);
    let nextResumeRecoveryAt = 0;
    let nextTabHealthAt = 0;
    let heldMovementKeys: KeyInput[] = [];
    const applyMovement = async (next: readonly KeyInput[]): Promise<void> => {
      const transition = tollanMovementTransition(heldMovementKeys, next);
      // Press the replacement direction before releasing the old one so Unity
      // never observes a zero-input frame between steering decisions.
      for (const key of transition.press) await this.keyDown(page, key);
      for (const key of transition.release) await this.keyUp(page, key);
      heldMovementKeys = [...next];
    };
    const reassertMovement = async (): Promise<void> => {
      const resumeKeys = heldMovementKeys.length > 0 ? [...heldMovementKeys] : ['KeyW' as const];
      for (const key of TOLLAN_MOVEMENT_KEYS) await this.keyUp(page, key);
      heldMovementKeys = [];
      await this.focusCanvas(page);
      await delay(inRange(35, 80));
      await applyMovement(resumeKeys);
      nextMovementHeartbeatAt = Date.now() + inRange(650, 1_150);
    };
    const resumeMovement = async (): Promise<void> => {
      const resumeKeys = tollanResumeMovementKeys(heldMovementKeys, fallbackPhase);
      for (const key of TOLLAN_MOVEMENT_KEYS) await this.keyUp(page, key).catch(() => undefined);
      heldMovementKeys = [];
      await this.focusCanvas(page);
      await delay(inRange(45, 90));
      for (const key of resumeKeys) await this.keyDown(page, key);
      heldMovementKeys = [...resumeKeys];
      await delay(inRange(720, 1_080));
      nextMovementHeartbeatAt = Date.now() + inRange(650, 1_150);
    };
    try {
      await applyMovement(TOLLAN_ORBIT_PHASES[fallbackPhase] ?? ['KeyW']);
      this.trace(state, 'control_profile_started', controlProfile);
      while (state.snapshot.state === 'playing' && !state.stopRequested) {
        const pursuingBonus = state.bonusTargets > 0;
        try {
          if (Date.now() >= nextTabHealthAt) {
            const activated = await this.ensureWorkerTabActive(state, page);
            if (activated) {
              await this.enableGameInput(state, page);
              await reassertMovement();
            }
            nextTabHealthAt = Date.now() + 2_500;
          }
          const analysis = await analyzeTollanCanvas(page);
          const now = Date.now();
          if (analysis.resumeLikely && now >= nextResumeRecoveryAt) {
            this.update(state, {
              message: `Волна ${state.snapshot.wave} · возобновляем движение`,
            });
            this.trace(state, 'movement_resume_overlay', {
              heldMovementKeys,
              screen: analysis.screen,
            });
            await this.enableGameInput(state, page);
            await resumeMovement();
            nextResumeRecoveryAt = Date.now() + inRange(1_200, 1_800);
            continue;
          }
          const activitySignature = tollanRunActivitySignature(analysis, state.snapshot.wave);
          if (
            activitySignature !== lastActivitySignature ||
            state.lastWaveStartedAt > lastWaveActivityAt
          ) {
            lastActivitySignature = activitySignature;
            lastWaveActivityAt = state.lastWaveStartedAt;
            lastProgressAt = now;
          } else if (now - lastProgressAt >= RUN_STALL_TIMEOUT_MS) {
            this.trace(state, 'practice_stalled', {
              stalledMs: now - lastProgressAt,
              screen: analysis.screen,
              wave: state.snapshot.wave,
            });
            throw new Error('Practice не меняется больше 7 минут');
          }
          if (analysis.choiceLikely) {
            nonGameplaySince = 0;
            if (!choicePendingSince) {
              choicePendingSince = now;
              choiceAttempt = 0;
              nextChoiceAttemptAt = now + CHOICE_SETTLE_MS;
              await applyMovement([]);
              this.trace(state, 'game_choice_opened', {
                choiceNames: analysis.choiceNames,
                choiceScores: analysis.choiceScores,
              });
            }
            if (now < nextChoiceAttemptAt) {
              await delay(inRange(45, 110));
              continue;
            }
            const currentBox = (await (await page.$('canvas'))?.boundingBox()) ?? box;
            const rerollRequested = questPlan.useSkillReroll || questPlan.useAffinityReroll;
            if (rerollRequested && !state.skillRerollUsed) {
              await this.click(
                page,
                currentBox,
                analysis.activeRightRatio * 0.5,
                analysis.activeBottomRatio * 0.88,
              );
              state.skillRerollUsed = true;
              state.lastGameDecisionAt = Date.now();
              this.update(state, { message: 'Выполняем квест: используем reroll' });
              this.trace(state, 'quest_reroll_clicked', { target: questPlan.mission?.description });
              nextChoiceAttemptAt = Date.now() + inRange(650, 1_050);
              await delay(inRange(220, 360));
              continue;
            }

            const target = tollanChoiceClickTarget(analysis, choiceAttempt);
            const option = target.xRatio;
            const optionIndex = option < 0.3 ? 0 : option > 0.7 ? 2 : 1;
            const selectedSkill = analysis.choiceNames?.[optionIndex] ?? undefined;
            await this.click(
              page,
              currentBox,
              analysis.activeRightRatio * option,
              analysis.activeBottomRatio * target.yRatio,
            );
            if (choiceAttempt >= 3) {
              await delay(inRange(80, 140));
              await this.click(
                page,
                currentBox,
                analysis.activeRightRatio * option,
                analysis.activeBottomRatio * target.yRatio,
              );
            }
            choiceAttempt++;
            state.lastGameDecisionAt = Date.now();
            nextChoiceAttemptAt = state.lastGameDecisionAt + inRange(520, 950);
            this.update(state, {
              message: selectedSkill
                ? `Волна ${state.snapshot.wave} · выбираем ${selectedSkill.replace(/_/g, ' ')}`
                : `Волна ${state.snapshot.wave} · усиливаем текущий билд`,
            });
            this.trace(state, 'game_choice_clicked', {
              attempt: choiceAttempt,
              option,
              yRatio: target.yRatio,
              selectedSkill,
              choiceNames: analysis.choiceNames,
              choiceMatchErrors: analysis.choiceMatchErrors,
              choiceScores: analysis.choiceScores,
            });
            await delay(inRange(220, 360));
            const confirmation = await analyzeTollanCanvas(page);
            if (!confirmation.choiceLikely && confirmation.gameplay) {
              this.trace(state, 'game_choice_confirmed', {
                attempts: choiceAttempt,
                elapsedMs: Date.now() - choicePendingSince,
              });
              choicePendingSince = 0;
              choiceAttempt = 0;
              nextChoiceAttemptAt = 0;
              lastProgressAt = Date.now();
              await reassertMovement();
              await delay(inRange(120, 280));
            }
            continue;
          }

          if (choicePendingSince) {
            this.trace(state, 'game_choice_confirmed', {
              attempts: choiceAttempt,
              elapsedMs: now - choicePendingSince,
              screen: analysis.screen,
            });
            choicePendingSince = 0;
            choiceAttempt = 0;
            nextChoiceAttemptAt = 0;
            lastProgressAt = now;
            await reassertMovement();
          }
          if (!analysis.gameplay) {
            if (analysis.screen === 'game_over') {
              await applyMovement([]);
              const action = tollanCompletedRunAction(analysis);
              const currentBox = (await (await page.$('canvas'))?.boundingBox()) ?? box;
              if (action && now >= nextChoiceAttemptAt) {
                await this.click(page, currentBox, action.target.xRatio, action.target.yRatio);
                nextChoiceAttemptAt = Date.now() + inRange(900, 1_500);
                this.trace(state, 'practice_continue_before_score', { target: action.target });
              }
              await delay(inRange(120, 220));
              continue;
            }
            nonGameplaySince ||= now;
            if (now - nonGameplaySince >= 2_200 && now >= nextChoiceAttemptAt) {
              await applyMovement([]);
              const currentBox = (await (await page.$('canvas'))?.boundingBox()) ?? box;
              const target = tollanChoiceClickTarget(analysis, choiceAttempt);
              await this.click(
                page,
                currentBox,
                analysis.activeRightRatio * target.xRatio,
                analysis.activeBottomRatio * target.yRatio,
              );
              choiceAttempt++;
              nextChoiceAttemptAt = Date.now() + inRange(650, 1_050);
              this.update(state, {
                message: `Волна ${state.snapshot.wave} · восстанавливаем выбор усиления`,
              });
              this.trace(state, 'game_choice_recovery_clicked', {
                attempt: choiceAttempt,
                target,
                screen: analysis.screen,
                stalledMs: now - nonGameplaySince,
              });
            }
            await delay(inRange(80, 160));
            continue;
          }
          nonGameplaySince = 0;
          let guidance = analysis.gameplay;
          if (guidance?.pickupKind) {
            rememberedPickup = guidance;
            pickupMemoryUntil =
              now +
              (guidance.pickupKind === 'chest'
                ? controlProfile.chestMemoryMs
                : controlProfile.lootMemoryMs);
          } else if (
            guidance &&
            rememberedPickup?.pickupKind &&
            now < pickupMemoryUntil &&
            guidance.mode === 'explore' &&
            guidance.dangerScore < 0.62
          ) {
            guidance = {
              ...guidance,
              mode: 'collect',
              directionX: rememberedPickup.directionX,
              directionY: rememberedPickup.directionY,
              pickupKind: rememberedPickup.pickupKind,
              ...(rememberedPickup.pickupDistance !== undefined
                ? { pickupDistance: rememberedPickup.pickupDistance }
                : {}),
              ...(rememberedPickup.pickupSource
                ? { pickupSource: rememberedPickup.pickupSource }
                : {}),
              ...(rememberedPickup.pickupXRatio !== undefined
                ? { pickupXRatio: rememberedPickup.pickupXRatio }
                : {}),
              ...(rememberedPickup.pickupYRatio !== undefined
                ? { pickupYRatio: rememberedPickup.pickupYRatio }
                : {}),
              interact: rememberedPickup.interact,
              dash: true,
            };
          }

          const variedGuidance = guidance
            ? {
                directionX:
                  guidance.directionX +
                  controlProfile.steeringBiasX +
                  (Math.random() * 2 - 1) * controlProfile.steeringJitter,
                directionY:
                  guidance.directionY +
                  controlProfile.steeringBiasY +
                  (Math.random() * 2 - 1) * controlProfile.steeringJitter,
              }
            : undefined;
          const keys = tollanMovementKeys(variedGuidance, fallbackPhase);
          const urgentSteering =
            guidance?.mode === 'retreat' ||
            guidance?.mode === 'escape' ||
            (guidance?.healthRatio !== undefined && guidance.healthRatio < 0.46);
          if (urgentSteering || now >= nextSteeringAt || heldMovementKeys.length === 0) {
            await applyMovement(keys);
            nextSteeringAt =
              now +
              inRange(controlProfile.directionCommitMs[0], controlProfile.directionCommitMs[1]);
          }
          if (heldMovementKeys.length > 0 && now >= nextMovementHeartbeatAt) {
            await this.focusCanvas(page);
            for (const key of heldMovementKeys) await this.keyDown(page, key);
            nextMovementHeartbeatAt = Date.now() + inRange(650, 1_150);
          }

          const pursuingChest = guidance?.pickupKind === 'chest';
          if (
            now >= nextInteractAt &&
            (pursuingChest || guidance?.interact || now - nextInteractAt > 3_200)
          ) {
            await this.pressKey(page, 'KeyE');
            nextInteractAt =
              now +
              (pursuingChest
                ? inRange(360, 780)
                : inRange(guidance?.interact ? 900 : 3_400, 5_600));
            this.trace(state, 'world_interaction', {
              pickup: guidance?.pickupKind,
              distance: guidance?.pickupDistance,
            });
          }
          if ((guidance?.dash || pursuingBonus) && now >= nextDashAt) {
            await this.pressKey(page, 'Space');
            nextDashAt =
              now +
              inRange(
                guidance?.mode === 'retreat' || guidance?.mode === 'escape' ? 1_050 : 1_650,
                guidance?.mode === 'retreat' || guidance?.mode === 'escape' ? 1_850 : 2_900,
              );
          }

          if (!guidance || guidance.mode === 'explore') {
            fallbackSteps--;
            if (fallbackSteps <= 0) {
              fallbackPhase =
                (fallbackPhase + (controlProfile.clockwise ? 1 : -1) + TOLLAN_ORBIT_PHASES.length) %
                TOLLAN_ORBIT_PHASES.length;
              fallbackSteps = inRange(
                controlProfile.exploreSteps[0],
                controlProfile.exploreSteps[1],
              );
              nextSteeringAt = 0;
            }
          }
          if (guidance && now >= nextStatusAt) {
            const message =
              guidance.mode === 'retreat'
                ? 'Отходим от группы врагов'
                : guidance.mode === 'escape'
                  ? 'Выходим из края карты'
                  : guidance.pickupKind === 'chest'
                    ? 'Идём к сундуку'
                    : guidance.pickupKind === 'crystal'
                      ? 'Собираем кристаллы'
                      : 'Ищем кристаллы и сундуки';
            this.update(state, { message: `Волна ${state.snapshot.wave} · ${message}` });
            nextStatusAt = now + inRange(3_500, 5_800);
          }
          if (guidance && now >= nextTraceAt) {
            this.trace(state, 'vision_guidance', {
              ...guidance,
              keys,
              heldMovementKeys,
              pickupMemoryUntil,
            });
            nextTraceAt = now + inRange(3_800, 6_200);
          }
        } catch (error) {
          this.trace(state, 'reactive_control_failed', { error });
          fallbackPhase =
            (fallbackPhase + (controlProfile.clockwise ? 1 : -1) + TOLLAN_ORBIT_PHASES.length) %
            TOLLAN_ORBIT_PHASES.length;
          await applyMovement(TOLLAN_ORBIT_PHASES[fallbackPhase] ?? ['KeyW']).catch(
            () => undefined,
          );
          await delay(inRange(80, 190));
        }
        await delay(
          inRange(
            pursuingBonus ? 45 : TOLLAN_DECISION_POLL_MS[0],
            pursuingBonus ? 145 : TOLLAN_DECISION_POLL_MS[1],
          ),
        );
      }
      if (state.stopRequested) throw new Error('Остановлено пользователем');
    } finally {
      for (const key of [...TOLLAN_MOVEMENT_KEYS, 'KeyE', 'Space'] satisfies KeyInput[]) {
        await this.keyUp(page, key);
      }
    }
  }

  private async finishCompletedPractice(
    state: RunnerState,
    page: Page,
    box: { x: number; y: number; width: number; height: number },
  ): Promise<void> {
    this.update(state, { message: 'Забег завершён · ждём Continue' });
    await delay(inRange(900, 1_700));
    for (let attempt = 0; attempt < 16 && !state.stopRequested; attempt++) {
      const analysis = await analyzeTollanCanvas(page);
      const action = tollanCompletedRunAction(analysis);
      this.trace(state, 'practice_finish_screen', { attempt, ...analysis });
      if (action) {
        const currentBox = (await (await page.$('canvas'))?.boundingBox()) ?? box;
        this.update(state, { message: `Забег завершён · ${action.message}` });
        await this.click(page, currentBox, action.target.xRatio, action.target.yRatio);
        this.trace(state, 'practice_continue_clicked', { attempt, target: action.target });
        await delay(inRange(650, 1_050));
        const confirmation = await analyzeTollanCanvas(page);
        if (confirmation.screen !== 'game_over') {
          this.trace(state, 'practice_continue_confirmed', { screen: confirmation.screen });
          return;
        }
      } else if (attempt === 4 || attempt === 9) {
        // The result overlay has a stable centered layout even if effects hide
        // enough red pixels to defeat visual detection.
        const currentBox = (await (await page.$('canvas'))?.boundingBox()) ?? box;
        await this.click(page, currentBox, 0.5, 0.64);
        this.trace(state, 'practice_continue_fallback', { attempt });
      }
      await delay(inRange(350, 650));
    }
    this.trace(state, 'practice_continue_not_confirmed');
  }

  private async approveRewardTransaction(
    state: RunnerState,
    browser: Browser,
    page: Page,
    expectedOrigin: string,
    expectedAddress: string,
    timeoutMs = REWARD_TIMEOUT_MS,
  ): Promise<void> {
    const startedAt = Date.now();
    let portalSeen = false;
    while (Date.now() - startedAt < timeoutMs) {
      if (state.stopRequested) throw new Error('Остановлено пользователем');
      const portal = await approveOpenAbstractPortal({
        browser,
        expectedOrigin,
        expectedAddress,
      });
      if (portal) {
        portalSeen = true;
        this.update(state, { state: 'claiming', message: 'Подтверждаем сундук в Abstract' });
        this.trace(state, 'reward_portal', portal);
        await delay(portal.state === 'approved' ? 900 : 450);
        continue;
      }

      const text = await this.pageText(page);
      if (/transaction (?:failed|rejected)|insufficient funds|something went wrong/i.test(text)) {
        throw new Error('Tollan не смог открыть сундук через Abstract');
      }
      if (/you have received|you got|\bclaimed\b|congratulations/i.test(text)) return;
      if (portalSeen && !/opening|waiting|checking|confirm/i.test(text)) return;
      if (
        !portalSeen &&
        Date.now() - startedAt > 8_000 &&
        !/opening|waiting|checking/i.test(text)
      ) {
        return;
      }
      await delay(500);
    }
    throw new Error(
      `Tollan не подтвердил открытие сундука за ${Math.ceil(timeoutMs / 60_000)} мин`,
    );
  }

  private async closeRewardModal(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await clickVisibleControl(page, ['Close', 'Done'], 'button, [role="button"]')) {
        await delay(700);
        return;
      }
      await delay(350);
    }
    await this.pressKey(page, 'Escape').catch(() => undefined);
  }

  private async claimInventoryRewards(
    state: RunnerState,
    browser: Browser,
    page: Page,
    hubUrl: string,
    inventoryPath: string,
    expectedAddress: string,
  ): Promise<number> {
    this.update(state, { state: 'claiming', message: 'Проверяем сундуки Tollan' });
    const inventoryUrl = tollanRouteUrl(hubUrl, inventoryPath);
    await page.goto(inventoryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    await this.ensureAuthenticated(state, browser, page, inventoryUrl, expectedAddress);
    const readyAt = Date.now();
    while (Date.now() - readyAt < 15_000) {
      const text = await this.pageText(page);
      if (/batch open|chests?\s*\(|your inventory is empty|items?\s*\(/i.test(text)) break;
      await delay(350);
    }

    let opened = 0;
    for (let cycle = 0; cycle < 64 && !state.stopRequested; cycle++) {
      const batch = await clickVisibleControlMatching(
        page,
        /^batch\s+open\s*\(\d+\)$/i,
        'button, [role="button"]',
      );
      if (batch) {
        const count = tollanBatchOpenCount(batch);
        this.trace(state, 'inventory_batch_clicked', { cycle, count });
        await delay(500);
        await clickLastVisibleControl(page, ['Max'], 'button, [role="button"]');
        await delay(250);
        const confirmed = await clickLastVisibleControl(page, ['Open'], 'button, [role="button"]');
        if (!confirmed) throw new Error('Tollan не показал подтверждение Batch Open');
        this.update(state, { state: 'claiming', message: `Открываем сундуки · ${count}` });
        await this.approveRewardTransaction(
          state,
          browser,
          page,
          new URL(hubUrl).origin,
          expectedAddress,
          Math.min(10 * 60_000, Math.max(REWARD_TIMEOUT_MS, count * 90_000)),
        );
        opened += count;
        await this.closeRewardModal(page);
        await delay(inRange(700, 1_400));
        continue;
      }

      const open = await clickLastVisibleControl(page, ['Open'], 'button, [role="button"]');
      if (open) {
        this.trace(state, 'inventory_open_clicked', { cycle });
        await delay(500);
        await clickLastVisibleControl(page, ['Max'], 'button, [role="button"]');
        await delay(250);
        const confirmed = await clickLastVisibleControl(page, ['Open'], 'button, [role="button"]');
        if (!confirmed) throw new Error('Tollan не показал подтверждение открытия сундука');
        this.update(state, { state: 'claiming', message: `Открываем сундук ${opened + 1}` });
        await this.approveRewardTransaction(
          state,
          browser,
          page,
          new URL(hubUrl).origin,
          expectedAddress,
        );
        opened++;
        await this.closeRewardModal(page);
        await delay(inRange(700, 1_400));
        continue;
      }

      const claim = await clickLastVisibleControl(page, ['Claim'], 'button, [role="button"]');
      if (!claim) break;
      this.trace(state, 'inventory_claim_clicked', { cycle });
      await delay(inRange(800, 1_400));
      await this.closeRewardModal(page);
    }
    this.trace(state, 'inventory_rewards_complete', { route: inventoryPath, opened });
    return opened;
  }

  private async claimMissionBoard(
    state: RunnerState,
    page: Page,
    hubUrl: string,
    missionPaths: readonly [string, string],
    missionBoardActionId: string,
    claimActionId: string,
  ): Promise<number> {
    this.update(state, { state: 'claiming', message: 'Проверяем доску миссий' });
    await this.visitMissionBoard(state, page, hubUrl, missionPaths[0], missionBoardActionId);
    let claimed = 0;
    const failures = new Map<string, number>();
    let initiallyClaimable = 0;
    for (let round = 0; round < 8 && !state.stopRequested; round++) {
      const claimable = state.missions.filter(
        (mission) =>
          !mission.claimed &&
          mission.progress >= mission.goal &&
          (failures.get(mission.id) ?? 0) < 2,
      );
      if (round === 0) initiallyClaimable = claimable.length;
      if (!state.missionBoardRequest || claimable.length === 0) break;
      let acceptedThisRound = 0;
      for (const mission of claimable) {
        if (state.stopRequested) break;
        const request = tollanMissionClaimRequest(
          state.missionBoardRequest,
          claimActionId,
          mission.id,
        );
        this.update(state, {
          state: 'claiming',
          message: `Получаем миссию: ${mission.description}`,
        });
        const result = (await page.evaluate(async (input) => {
          try {
            const response = await fetch(input.url, {
              method: 'POST',
              headers: input.headers,
              body: input.body,
              credentials: 'include',
              cache: 'no-store',
            });
            return { status: response.status, text: await response.text() };
          } catch (error) {
            return {
              status: 0,
              text: error instanceof Error ? error.message : String(error),
            };
          }
        }, request)) as { status: number; text: string };
        this.trace(state, 'mission_claim_action', {
          missionId: mission.id,
          status: result.status,
          responseBytes: result.text.length,
        });
        const rejected =
          result.status < 200 ||
          result.status >= 300 ||
          /"status"\s*:\s*[45]\d\d/.test(result.text) ||
          /"success"\s*:\s*false/i.test(result.text) ||
          /(?:^|\W)(?:error|failed)(?:\W|$)/i.test(result.text);
        if (rejected) {
          failures.set(mission.id, (failures.get(mission.id) ?? 0) + 1);
          this.trace(state, 'mission_claim_action_rejected', {
            missionId: mission.id,
            status: result.status,
          });
          continue;
        }
        const current = state.missions.find((entry) => entry.id === mission.id);
        if (current) current.claimed = true;
        claimed++;
        acceptedThisRound++;
        await delay(inRange(650, 1_250));
        await this.visitMissionBoard(
          state,
          page,
          hubUrl,
          missionPaths[0],
          missionBoardActionId,
        ).catch(() => false);
      }
      if (acceptedThisRound === 0) break;
    }

    for (const route of missionPaths) {
      const routeUrl = tollanRouteUrl(hubUrl, route);
      if (page.url() === routeUrl) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
      } else {
        await page.goto(routeUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 120_000,
        });
      }
      await delay(700);
      let misses = 0;
      for (let cycle = 0; cycle < 30 && misses < 12 && !state.stopRequested; cycle++) {
        const button = await clickLastVisibleControl(page, ['Claim'], 'button, [role="button"]');
        if (!button) {
          misses++;
          await delay(300);
          continue;
        }
        misses = 0;
        claimed++;
        this.update(state, { state: 'claiming', message: `Получаем миссии · ${claimed}` });
        this.trace(state, 'mission_claim_clicked', { route, cycle });
        await delay(inRange(700, 1_300));
        await this.closeRewardModal(page);
        await delay(inRange(450, 900));
      }
    }
    this.trace(state, 'mission_claim_complete', { claimed, initiallyClaimable });
    return claimed;
  }

  private async claimAvailableRewards(
    state: RunnerState,
    browser: Browser,
    page: Page,
    input: TollanBrowserRunInput,
  ): Promise<{ chestsOpened: number; missionsClaimed: number; warnings: string[] }> {
    let chestsOpened = 0;
    let missionsClaimed = 0;
    const warnings: string[] = [];
    const attempt = async (label: string, operation: () => Promise<number>): Promise<number> => {
      try {
        return await operation();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`${label}: ${message}`);
        this.trace(state, 'reward_step_failed', { label, error });
        return 0;
      }
    };

    for (let cycle = 0; cycle < 6 && !state.stopRequested; cycle++) {
      const cycleMissions = await attempt(`mission board ${cycle + 1}`, () =>
        this.claimMissionBoard(
          state,
          page,
          input.hubUrl,
          input.missionPaths,
          input.missionBoardActionId,
          input.claimMissionActionId,
        ),
      );
      const cycleChests = await attempt(`inventory ${cycle + 1}`, () =>
        this.claimInventoryRewards(
          state,
          browser,
          page,
          input.hubUrl,
          input.inventoryPath,
          input.address,
        ),
      );
      missionsClaimed += cycleMissions;
      chestsOpened += cycleChests;
      this.trace(state, 'reward_claim_cycle', {
        cycle,
        missionsClaimed: cycleMissions,
        chestsOpened: cycleChests,
      });
      if (cycleMissions === 0 && cycleChests === 0) break;
    }
    return { chestsOpened, missionsClaimed, warnings: [...new Set(warnings)] };
  }

  private async run(input: TollanBrowserRunInput, state: RunnerState): Promise<void> {
    if (!input.adsPower || !input.adsPowerProfileId) {
      throw new Error('Привяжите к аккаунту профиль AdsPower');
    }
    state.stopRequested = false;
    state.practiceStartRequestedAt = 0;
    state.clientReadyAt = 0;
    state.missions = [];
    state.missionVersion = 0;
    state.missionBoardRequest = undefined;
    state.bonusTargets = 0;
    state.lastWaveStartedAt = 0;
    state.lastGameDecisionAt = 0;
    state.skillRerollUsed = false;
    this.update(state, {
      state: 'loading',
      message: 'Открываем квесты Tollan в AdsPower',
      wave: 0,
      startedAt: Date.now(),
      error: undefined,
      note: undefined,
      reward: undefined,
      chestsOpened: undefined,
      missionsClaimed: undefined,
      runsCompleted: 0,
      bonusTargets: 0,
      quests: undefined,
      completedAt: undefined,
    });
    let page: Page | undefined;
    let lease: AdsPowerPageLease | undefined;
    let stopMonitor: () => void = () => undefined;
    try {
      const practiceUrl = new URL(input.practicePath, input.hubUrl).href;
      const missionsUrl = tollanRouteUrl(input.hubUrl, '/');
      lease = await this.browsers.openPage({
        config: input.adsPower,
        profileId: input.adsPowerProfileId,
        url: missionsUrl,
        reuseOrigin: false,
        restoreTabs: false,
        activate: true,
        background: true,
        muteAudio: true,
      });
      page = lease.page;
      state.page = page;
      state.lease = lease;
      stopMonitor = this.monitor(state, page);
      this.update(state, { state: 'loading', message: 'Проверяем вход Tollan' });
      await this.ensureAuthenticated(state, lease.browser, page, missionsUrl, input.address);

      let totalChestsOpened = 0;
      let totalMissionsClaimed = 0;
      let runsCompleted = 0;
      const rewardParts: string[] = [];
      const warnings: string[] = [];
      const initialRewards = await this.claimAvailableRewards(state, lease.browser, page, input);
      totalChestsOpened += initialRewards.chestsOpened;
      totalMissionsClaimed += initialRewards.missionsClaimed;
      warnings.push(...initialRewards.warnings);

      let questPlan = await this.refreshQuestBoard(
        state,
        page,
        input.hubUrl,
        input.missionPaths[0],
        input.missionBoardActionId,
      );
      let questFingerprint = tollanQuestProgressFingerprint(state.missions);
      for (let runIndex = 0; runIndex < MAX_QUEST_RUNS_PER_START; runIndex++) {
        if (runIndex > 0 && !questPlan.practiceNeeded) break;
        if (state.stopRequested) throw new Error('Остановлено пользователем');

        state.practiceStartRequestedAt = 0;
        state.clientReadyAt = 0;
        state.bonusTargets = 0;
        state.lastWaveStartedAt = 0;
        state.lastGameDecisionAt = 0;
        state.skillRerollUsed = false;
        this.update(state, {
          state: 'loading',
          message: questPlan.mission
            ? `Готовим квест: ${questPlan.mission.description}`
            : 'Готовим бесплатный Practice',
          wave: 0,
          bonusTargets: 0,
          error: undefined,
        });
        await page.goto(practiceUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await this.ensureWorkerTabActive(state, page, true);
        const box = await this.waitForCanvas(state, page);
        await this.enableGameInput(state, page);
        await this.enterPractice(state, page, box, questPlan);
        await this.playUntilComplete(state, page, box, questPlan);
        if (state.snapshot.state !== 'completed') {
          throw new Error(state.snapshot.error || 'Tollan не подтвердил завершение Practice');
        }
        await this.finishCompletedPractice(state, page, box);

        runsCompleted++;
        if (state.snapshot.reward) rewardParts.push(state.snapshot.reward);
        this.update(state, { runsCompleted });
        const rewards = await this.claimAvailableRewards(state, lease.browser, page, input);
        totalChestsOpened += rewards.chestsOpened;
        totalMissionsClaimed += rewards.missionsClaimed;
        warnings.push(...rewards.warnings);

        const previousPlan = questPlan;
        questPlan = await this.refreshQuestBoard(
          state,
          page,
          input.hubUrl,
          input.missionPaths[0],
          input.missionBoardActionId,
        );
        const nextFingerprint = tollanQuestProgressFingerprint(state.missions);
        if (
          previousPlan.mission &&
          !tollanMissionProgressed(previousPlan.mission, state.missions)
        ) {
          this.trace(state, 'quest_progress_unchanged', {
            mission: previousPlan.mission,
            runIndex,
            before: questFingerprint,
            after: nextFingerprint,
          });
          warnings.push(`Квест не изменился: ${previousPlan.mission.description}`);
          break;
        }
        questFingerprint = nextFingerprint;
      }

      const outcome = [
        runsCompleted ? `забегов ${runsCompleted}` : undefined,
        totalMissionsClaimed ? `миссий получено ${totalMissionsClaimed}` : undefined,
        totalChestsOpened ? `сундуков открыто ${totalChestsOpened}` : undefined,
      ].filter(Boolean);
      this.update(state, {
        state: 'completed',
        message: runsCompleted ? 'Квестовый цикл Tollan завершён' : 'Квесты и награды проверены',
        reward:
          [outcome.join(' · '), ...new Set(rewardParts)].filter(Boolean).join(' · ') ||
          'Новых наград нет',
        chestsOpened: totalChestsOpened,
        missionsClaimed: totalMissionsClaimed,
        runsCompleted,
        quests: summarizeTollanQuests(state.missions, questPlan.mission),
        error: undefined,
        ...(warnings.length > 0 ? { note: warnings[0] } : { note: undefined }),
        completedAt: Date.now(),
      });
    } catch (error) {
      if (page && this.diagnostics?.status().enabled) {
        try {
          const image = await page.screenshot({ type: 'png' });
          this.diagnostics.saveImage?.(
            'tollan-adspower',
            `${input.accountAlias}-run-failed`,
            Buffer.from(image),
          );
        } catch {
          // Diagnostics must not replace the original run error.
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!['completed', 'needs_auth'].includes(state.snapshot.state)) {
        this.update(state, {
          state: state.stopRequested ? 'stopped' : 'failed',
          message: state.stopRequested ? 'Остановлено' : 'Забег остановлен',
          ...(state.stopRequested ? {} : { error: message }),
          completedAt: Date.now(),
        });
      }
      this.trace(state, 'run_failed', { error });
    } finally {
      stopMonitor();
      if (state.focusSession) {
        await state.focusSession.detach().catch(() => undefined);
        state.focusSession = undefined;
      }
      if (lease) {
        try {
          await lease.release();
          this.trace(state, 'worker_released', {
            pageCreatedByHub: lease.pageCreatedByHub,
            profileStartedByHub: lease.profileStartedByHub,
          });
        } catch (error) {
          this.trace(state, 'worker_release_failed', { error });
          if (!state.snapshot.note) {
            this.update(state, {
              note: 'AdsPower не подтвердил закрытие профиля. Закройте его вручную.',
            });
          }
        }
      }
      state.practiceStartRequestedAt = 0;
      state.clientReadyAt = 0;
      state.page = undefined;
      state.lease = undefined;
      state.runPromise = undefined;
    }
  }

  async start(input: TollanBrowserRunInput): Promise<TollanRunSnapshot> {
    const state = this.stateFor(input);
    if (state.runPromise) return snapshotCopy(state.snapshot);
    const version = ++state.runVersion;
    this.update(state, { state: 'queued', message: 'Готовим AdsPower-профиль', wave: 0 });
    const operation = (async () => {
      if (state.runVersion === version) {
        await delay(inRange(1_200, 6_500));
        await this.run(input, state);
      }
    })();
    state.runPromise = operation;
    void operation.finally(async () => {
      if (state.runPromise === operation) state.runPromise = undefined;
      await input.onSettled?.();
    });
    return snapshotCopy(state.snapshot);
  }

  async stop(sessionKey?: string): Promise<TollanRunSnapshot[]> {
    const key = sessionKey ? safeKey(sessionKey) : undefined;
    const releases: Promise<void>[] = [];
    for (const state of this.states.values()) {
      if (key && state.key !== key) continue;
      state.stopRequested = true;
      state.runVersion++;
      if (state.lease) releases.push(state.lease.release().catch(() => undefined));
      if (state.snapshot.state === 'queued') {
        this.update(state, { state: 'stopped', message: 'Остановлено', completedAt: Date.now() });
      }
    }
    await Promise.all(releases);
    return await this.status(sessionKey);
  }

  async status(sessionKey?: string): Promise<TollanRunSnapshot[]> {
    const key = sessionKey ? safeKey(sessionKey) : undefined;
    return [...this.states.values()]
      .filter((state) => !key || state.key === key)
      .map((state) => snapshotCopy(state.snapshot));
  }

  dispose(): void {
    for (const state of this.states.values()) {
      state.stopRequested = true;
      void state.lease?.release().catch(() => undefined);
    }
    this.states.clear();
  }
}
