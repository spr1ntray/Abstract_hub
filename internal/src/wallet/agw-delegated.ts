import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import type { Address, Hex } from 'viem';
import type { Account } from '../vault/schema.js';
import type { MarketplaceTransactionSender } from '../marketplace/lister.js';
import type { GigaverseLoginSigner } from '../api/auth.js';

export const ABSTRACT_MAINNET_CHAIN_ID = 2741;

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_AUTH_TIMEOUT_MS = 16 * 60_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface AgwCliRuntimeOptions {
  appRoot?: string;
  homeRoot?: string;
  command?: string;
  electronRunAsNode?: boolean;
  commandTimeoutMs?: number;
  authTimeoutMs?: number;
  signal?: AbortSignal;
  /** UI flows suppress the CLI's eager browser launch and expose their own controls. */
  suppressBrowserOpen?: boolean;
  /** Receives the hosted Abstract approval URL without writing it to app logs. */
  onApprovalUrl?: (url: string) => void;
}

export interface DelegatedAgwSession {
  status: string;
  readiness: string;
  writeReady: boolean;
  accountAddress: string | null;
  chainId: number;
  policyPreset: string | null;
  enabledTools: string[];
}

export type DelegatedAgwState =
  | 'ready'
  | 'missing'
  | 'wrong_account'
  | 'wrong_chain'
  | 'needs_permission'
  | 'incomplete';

export interface DelegatedAgwAvailability {
  state: DelegatedAgwState;
  message: string;
  session: DelegatedAgwSession;
}

type JsonObject = Record<string, unknown>;

export type AgwCliRunner = (
  account: Account,
  args: string[],
  options?: AgwCliRuntimeOptions & { timeoutMs?: number },
) => Promise<JsonObject>;

export class AgwDelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgwDelegationError';
  }
}

function safePathSegment(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return safe.replace(/^-+|-+$/g, '') || 'account';
}

export function delegatedAgwHome(
  account: Pick<Account, 'name' | 'agwAddress' | 'sessionId'>,
  options: AgwCliRuntimeOptions = {},
): string {
  const homeRoot = resolve(
    options.homeRoot ??
      process.env['GIGABOT_HOME'] ??
      process.env['GIGABOT_DATA_DIR'] ??
      process.cwd(),
  );
  if (account.sessionId) {
    return resolve(homeRoot, 'agw-sessions', `session-${account.sessionId}`);
  }
  const addressSuffix = account.agwAddress?.slice(2, 10).toLowerCase() ?? 'eoa';
  return resolve(homeRoot, 'agw-sessions', `${safePathSegment(account.name)}-${addressSuffix}`);
}

function delegatedAgwRoot(options: AgwCliRuntimeOptions = {}): string {
  return resolve(
    options.homeRoot ??
      process.env['GIGABOT_HOME'] ??
      process.env['GIGABOT_DATA_DIR'] ??
      process.cwd(),
    'agw-sessions',
  );
}

interface StoredAgwSessionIndex {
  accountAddress?: unknown;
  chainId?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  policyMeta?: unknown;
  capabilitySummary?: unknown;
}

interface StoredAgwToolPolicy {
  enabledTools?: unknown;
}

interface StoredAgwPolicyMeta extends StoredAgwToolPolicy {
  presetId?: unknown;
  presetLabel?: unknown;
  warnings?: unknown;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
}

/**
 * AGW CLI 0.1.8's hosted default flow approves typed-data signatures but omits
 * sign_message from its local tool metadata. The CLI then blocks the same
 * capability before the approved remote signer can handle it. Repair only this
 * exact official default bundle; custom and older policies remain untouched.
 */
export function repairDelegatedAgwDefaultPolicy(
  account: Pick<Account, 'name' | 'agwAddress' | 'sessionId'>,
  options: AgwCliRuntimeOptions = {},
): boolean {
  const home = resolveDelegatedAgwHome(account, options);
  const sessionPath = resolve(home, 'session.json');
  if (!existsSync(sessionPath)) return false;

  try {
    const stored = JSON.parse(readFileSync(sessionPath, 'utf8')) as StoredAgwSessionIndex;
    const policyMeta = recordValue(stored.policyMeta) as StoredAgwPolicyMeta | null;
    const capabilitySummary = recordValue(stored.capabilitySummary) as StoredAgwToolPolicy | null;
    const enabledTools = exactStringArray(policyMeta?.enabledTools);
    const capabilityTools = exactStringArray(capabilitySummary?.enabledTools);
    const warnings = exactStringArray(policyMeta?.warnings);
    const expectedAddress = account.agwAddress?.toLowerCase();

    if (
      stored.status !== 'active' ||
      stored.chainId !== ABSTRACT_MAINNET_CHAIN_ID ||
      typeof stored.accountAddress !== 'string' ||
      (expectedAddress && stored.accountAddress.toLowerCase() !== expectedAddress) ||
      policyMeta?.presetId !== 'full_app_control' ||
      policyMeta.presetLabel !== 'AGW CLI Default' ||
      !enabledTools ||
      !capabilityTools ||
      !warnings ||
      enabledTools.includes('sign_message') ||
      !enabledTools.includes('sign_transaction') ||
      !enabledTools.includes('send_transaction') ||
      !capabilityTools.includes('sign_transaction') ||
      !capabilityTools.includes('send_transaction') ||
      !warnings.some((warning) => warning.includes('typed-data signatures')) ||
      !warnings.some((warning) => warning.includes('Plain personal_sign requests are not enabled'))
    ) {
      return false;
    }

    policyMeta.enabledTools = [...enabledTools, 'sign_message'];
    const tempPath = `${sessionPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(stored, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(tempPath, sessionPath);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Recover an AGW CLI home by its public account address. This keeps sessions
 * usable when onboarding completed but the generated session id was not saved
 * into the encrypted account row.
 */
export function resolveDelegatedAgwHome(
  account: Pick<Account, 'name' | 'agwAddress' | 'sessionId'>,
  options: AgwCliRuntimeOptions = {},
): string {
  const configured = delegatedAgwHome(account, options);
  const expectedAddress = account.agwAddress?.toLowerCase();
  if (!expectedAddress) return configured;

  const candidates: Array<{ home: string; updatedAt: number }> = [];
  const root = delegatedAgwRoot(options);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const home = resolve(root, entry.name);
      const sessionPath = resolve(home, 'session.json');
      if (!existsSync(sessionPath) || !existsSync(resolve(home, 'privy-auth.key'))) continue;
      try {
        const parsed = JSON.parse(readFileSync(sessionPath, 'utf8')) as StoredAgwSessionIndex;
        if (
          typeof parsed.accountAddress !== 'string' ||
          parsed.accountAddress.toLowerCase() !== expectedAddress ||
          parsed.status === 'revoked'
        ) {
          continue;
        }
        candidates.push({
          home,
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        });
      } catch {
        // Ignore malformed or partial sessions and let the CLI report its own state.
      }
    }
  } catch {
    return configured;
  }

  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates[0]?.home ?? configured;
}

export function resolveAgwCliEntry(options: AgwCliRuntimeOptions = {}): string {
  const explicit = process.env['GIGABOT_AGW_CLI_ENTRY'];
  const appRoot = resolve(options.appRoot ?? process.env['GIGABOT_APP_ROOT'] ?? process.cwd());
  const entry = explicit
    ? resolve(explicit)
    : resolve(appRoot, 'node_modules/@abstract-foundation/agw-cli/dist/index.mjs');
  if (!existsSync(entry)) {
    throw new AgwDelegationError(
      'Компонент Abstract AGW CLI не найден. Переустановите актуальную версию приложения.',
    );
  }
  return entry;
}

function parseCliJson(stdout: string): JsonObject {
  const trimmed = stdout.trim();
  if (!trimmed) throw new AgwDelegationError('Abstract не вернул результат операции');
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as JsonObject;
  } catch {
    throw new AgwDelegationError('Abstract вернул ответ в неизвестном формате');
  }
}

function cliErrorMessage(stderr: string, exitCode: number | null): string {
  const trimmed = stderr.trim();
  const jsonStart = trimmed.lastIndexOf('\n{');
  const candidate = jsonStart >= 0 ? trimmed.slice(jsonStart + 1) : trimmed;
  try {
    const parsed = JSON.parse(candidate) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error.message === 'string') return parsed.error.message;
  } catch {
    // Logger output may precede the machine-readable error envelope.
  }
  const commanderError = trimmed.split(/\r?\n/).find((line) => /^error:/i.test(line.trim()));
  if (commanderError) return commanderError.replace(/^error:\s*/i, '');
  const lastLine = trimmed.split(/\r?\n/).filter(Boolean).at(-1);
  return lastLine && !lastLine.includes('auth_pubkey=')
    ? lastLine
    : `Abstract завершил операцию с кодом ${exitCode ?? 'unknown'}`;
}

export function extractAgwApprovalUrls(stderr: string): string[] {
  const urls: string[] = [];
  const pattern = /Opening hosted (?:onboarding app|revoke flow):\s*(https?:\/\/[^\s]+)/g;
  for (const match of stderr.matchAll(pattern)) {
    if (match[1]) urls.push(match[1]);
  }
  return urls;
}

const AGW_BROWSER_GUARD_SOURCE = `
import childProcess from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browserOpeners = new Set([
  'open', 'open.exe', 'xdg-open', 'gio',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
]);
const originalSpawn = childProcess.spawn.bind(childProcess);

childProcess.spawn = (command, args, options) => {
  const commandName = path.basename(String(command)).toLowerCase();
  if (
    process.env.GIGABOT_AGW_SUPPRESS_BROWSER_OPEN === '1' &&
    browserOpeners.has(commandName)
  ) {
    return originalSpawn(process.execPath, ['-e', ''], {
      env: process.env,
      stdio: options?.stdio ?? 'ignore',
      windowsHide: true,
    });
  }
  return originalSpawn(command, args, options);
};

const realEntry = process.env.GIGABOT_AGW_CLI_REAL_ENTRY;
if (!realEntry) throw new Error('GIGABOT_AGW_CLI_REAL_ENTRY is missing');
await import(pathToFileURL(realEntry).href);
`;

function prepareBrowserGuardLauncher(homeDir: string): string {
  const launcher = resolve(homeDir, '.gigabot-agw-browser-guard.mjs');
  writeFileSync(launcher, AGW_BROWSER_GUARD_SOURCE, { encoding: 'utf8', mode: 0o600 });
  return launcher;
}

export const runAgwCli: AgwCliRunner = async (account, args, options = {}) => {
  if (options.signal?.aborted) {
    throw new AgwDelegationError('Операция Abstract отменена');
  }
  const entry = resolveAgwCliEntry(options);
  const isAuthInit = args[0] === 'auth' && args[1] === 'init';
  const homeDir = isAuthInit
    ? delegatedAgwHome(account, options)
    : resolveDelegatedAgwHome(account, options);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  const command = options.command ?? process.execPath;
  const electronRunAsNode = options.electronRunAsNode ?? Boolean(process.versions.electron);
  const timeoutMs = options.timeoutMs ?? options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const isAuthFlow = args[0] === 'auth' && (args[1] === 'init' || args[1] === 'revoke');
  const suppressBrowserOpen =
    isAuthFlow && (options.suppressBrowserOpen ?? Boolean(options.onApprovalUrl));
  const commandEntry = suppressBrowserOpen ? prepareBrowserGuardLauncher(homeDir) : entry;

  return await new Promise<JsonObject>((resolvePromise, reject) => {
    // AGW_HOME works for every command. The CLI's --home flag is command-specific
    // and, notably, is rejected by `tx send` and `tx sign-message`.
    const child = spawn(command, [commandEntry, ...args], {
      cwd: options.appRoot ?? process.env['GIGABOT_APP_ROOT'] ?? process.cwd(),
      env: {
        ...process.env,
        AGW_HOME: homeDir,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        ...(suppressBrowserOpen
          ? {
              GIGABOT_AGW_SUPPRESS_BROWSER_OPEN: '1',
              GIGABOT_AGW_CLI_REAL_ENTRY: entry,
            }
          : {}),
        ...(electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let outputTooLarge = false;
    let timedOut = false;
    let aborted = false;
    let approvalHandlerError: Error | undefined;
    const reportedApprovalUrls = new Set<string>();

    const reportApprovalUrls = (): void => {
      if (!options.onApprovalUrl) return;
      for (const url of extractAgwApprovalUrls(stderr)) {
        if (!url || reportedApprovalUrls.has(url)) continue;
        reportedApprovalUrls.add(url);
        try {
          options.onApprovalUrl(url);
        } catch (error) {
          approvalHandlerError =
            error instanceof Error ? error : new Error('Не удалось подготовить ссылку Abstract');
          child.kill();
        }
      }
    };

    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const value = chunk.toString();
      if (stdout.length + stderr.length + value.length > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill();
        return;
      }
      if (target === 'stdout') stdout += value;
      else {
        stderr += value;
        reportApprovalUrls();
      }
    };
    child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref();

    const abortHandler = (): void => {
      aborted = true;
      child.kill();
    };
    options.signal?.addEventListener('abort', abortHandler, { once: true });
    if (options.signal?.aborted) abortHandler();

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortHandler);
    };

    child.once('error', (error) => {
      cleanup();
      reject(new AgwDelegationError(`Не удалось запустить компонент Abstract: ${error.message}`));
    });
    child.once('close', (code) => {
      cleanup();
      if (aborted) {
        reject(new AgwDelegationError('Операция Abstract отменена'));
        return;
      }
      if (timedOut) {
        reject(
          new AgwDelegationError(
            'Ожидание подтверждения Abstract истекло. Запустите подключение ещё раз.',
          ),
        );
        return;
      }
      if (approvalHandlerError) {
        reject(new AgwDelegationError(approvalHandlerError.message));
        return;
      }
      if (outputTooLarge) {
        reject(new AgwDelegationError('Abstract вернул слишком большой ответ'));
        return;
      }
      if (code !== 0) {
        reject(new AgwDelegationError(cliErrorMessage(stderr, code)));
        return;
      }
      try {
        resolvePromise(parseCliJson(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
};

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export async function getDelegatedAgwSession(
  account: Account,
  options: AgwCliRuntimeOptions = {},
  runner: AgwCliRunner = runAgwCli,
): Promise<DelegatedAgwSession> {
  repairDelegatedAgwDefaultPolicy(account, options);
  const result = await runner(
    account,
    [
      'session',
      'status',
      '--json',
      JSON.stringify({
        fields: [
          'status',
          'readiness',
          'writeReady',
          'accountAddress',
          'chainId',
          'policyPreset',
          'enabledTools',
        ],
      }),
    ],
    options,
  );
  return {
    status: stringValue(result['status'], 'missing'),
    readiness: stringValue(result['readiness'], 'missing'),
    writeReady: result['writeReady'] === true,
    accountAddress: typeof result['accountAddress'] === 'string' ? result['accountAddress'] : null,
    chainId: typeof result['chainId'] === 'number' ? result['chainId'] : ABSTRACT_MAINNET_CHAIN_ID,
    policyPreset: typeof result['policyPreset'] === 'string' ? result['policyPreset'] : null,
    enabledTools: stringArray(result['enabledTools']),
  };
}

export function assessDelegatedAgwSession(
  session: DelegatedAgwSession,
  expectedAddress: string,
): DelegatedAgwAvailability {
  if (session.status === 'missing' || !session.accountAddress) {
    return { state: 'missing', message: 'Abstract ещё не подключён', session };
  }
  if (session.accountAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    return {
      state: 'wrong_account',
      message: 'Подключён другой Abstract-аккаунт',
      session,
    };
  }
  if (session.chainId !== ABSTRACT_MAINNET_CHAIN_ID) {
    return { state: 'wrong_chain', message: 'Подключена другая сеть Abstract', session };
  }
  if (!session.writeReady || session.readiness !== 'active_write_ready') {
    return {
      state: 'incomplete',
      message: 'Подключение Abstract не готово к транзакциям',
      session,
    };
  }
  if (!session.enabledTools.includes('send_transaction')) {
    return {
      state: 'needs_permission',
      message: 'В подключении Abstract не разрешены транзакции',
      session,
    };
  }
  if (!session.enabledTools.includes('sign_message')) {
    return {
      state: 'needs_permission',
      message: 'В подключении Abstract недоступен автоматический вход: нет Sign message',
      session,
    };
  }
  return {
    state: 'ready',
    message: 'Abstract подключён для входа и транзакций',
    session,
  };
}

export async function inspectDelegatedAgw(
  account: Account,
  options: AgwCliRuntimeOptions = {},
  runner: AgwCliRunner = runAgwCli,
): Promise<DelegatedAgwAvailability> {
  if (!account.agwAddress) {
    throw new AgwDelegationError(`У аккаунта ${account.name} не определён AGW-адрес`);
  }
  const session = await getDelegatedAgwSession(account, options, runner);
  return assessDelegatedAgwSession(session, account.agwAddress);
}

export async function connectDelegatedAgw(
  account: Account,
  options: AgwCliRuntimeOptions = {},
  runner: AgwCliRunner = runAgwCli,
): Promise<DelegatedAgwAvailability> {
  if (account.agwAddress) {
    try {
      const existing = await inspectDelegatedAgw(account, options, runner);
      if (existing.state === 'ready') return existing;
    } catch {
      // No reusable local session; continue with browser onboarding.
    }
  }
  await runner(
    account,
    ['auth', 'init', '--json', JSON.stringify({ chainId: ABSTRACT_MAINNET_CHAIN_ID }), '--execute'],
    { ...options, timeoutMs: options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS },
  );
  const session = await getDelegatedAgwSession(account, options, runner);
  const expectedAddress = account.agwAddress ?? session.accountAddress;
  if (!expectedAddress) {
    throw new AgwDelegationError('Abstract не вернул адрес подключённого аккаунта');
  }
  return assessDelegatedAgwSession(session, expectedAddress);
}

export async function revokeDelegatedAgw(
  account: Account,
  options: AgwCliRuntimeOptions = {},
  runner: AgwCliRunner = runAgwCli,
): Promise<DelegatedAgwAvailability> {
  await runner(account, ['auth', 'revoke', '--json', '{}', '--execute'], {
    ...options,
    timeoutMs: options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
  });
  return await inspectDelegatedAgw(account, options, runner);
}

export async function makeDelegatedAgwSigner(
  account: Account,
  options: AgwCliRuntimeOptions = {},
  runner: AgwCliRunner = runAgwCli,
): Promise<MarketplaceTransactionSender> {
  if (!account.agwAddress) {
    throw new AgwDelegationError(`У аккаунта ${account.name} не определён AGW-адрес`);
  }
  const availability = await inspectDelegatedAgw(account, options, runner);
  if (availability.state !== 'ready') {
    throw new AgwDelegationError(
      `${availability.message}. Подключите Abstract во вкладке аккаунтов.`,
    );
  }

  return {
    sendTransaction: async ({ to, data, value = 0n }) => {
      // AGW CLI validates mixed-case addresses as EIP-55 checksums. Lowercase is
      // canonical and prevents a harmless casing typo from rejecting the tx.
      const normalizedTo = to.toLowerCase();
      if (!isAddress(normalizedTo)) {
        throw new AgwDelegationError('Некорректный адрес контракта для транзакции');
      }
      const payload = JSON.stringify({ to: normalizedTo, data, value: value.toString() });
      await runner(account, ['tx', 'send', '--json', payload, '--dry-run'], options);
      const result = await runner(account, ['tx', 'send', '--json', payload, '--execute'], options);
      const txHash = result['txHash'];
      if (typeof txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        throw new AgwDelegationError('Abstract не вернул хеш отправленной транзакции');
      }
      return txHash as Hex;
    },
  } satisfies MarketplaceTransactionSender;
}

export async function makeDelegatedAgwLoginSigner(
  account: Account,
  options: AgwCliRuntimeOptions = {},
  runner: AgwCliRunner = runAgwCli,
): Promise<GigaverseLoginSigner> {
  if (!account.agwAddress || !isAddress(account.agwAddress)) {
    throw new AgwDelegationError(`У аккаунта ${account.name} не определён AGW-адрес`);
  }
  const availability = await inspectDelegatedAgw(account, options, runner);
  if (availability.state !== 'ready') {
    throw new AgwDelegationError(
      `${availability.message}. Переподключите Abstract во вкладке аккаунтов.`,
    );
  }
  const expectedAddress = account.agwAddress;
  return {
    account: { address: expectedAddress },
    signMessage: async ({ message }) => {
      const payload = JSON.stringify({ message });
      await runner(account, ['tx', 'sign-message', '--json', payload, '--dry-run'], options);
      const result = await runner(
        account,
        ['tx', 'sign-message', '--json', payload, '--execute'],
        options,
      );
      const returnedAddress = result['accountAddress'];
      if (
        typeof returnedAddress === 'string' &&
        returnedAddress.toLowerCase() !== expectedAddress.toLowerCase()
      ) {
        throw new AgwDelegationError('Abstract подписал сообщение другим аккаунтом');
      }
      const signature = result['signature'];
      if (typeof signature !== 'string' || !/^0x[a-fA-F0-9]+$/.test(signature)) {
        throw new AgwDelegationError('Abstract не вернул подпись сообщения');
      }
      return signature as Hex;
    },
  };
}

export function isAddress(value: string): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}
