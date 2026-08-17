import { request } from 'undici';

const BASE = 'https://api.capsolver.com';
const MAX_POLL = 60;
const POLL_INTERVAL_MS = 2_000;

export interface SolveTurnstileInput {
  apiKey: string;
  websiteURL: string;
  websiteKey: string;
  /** Optional CapSolver task type override. */
  taskType?: string;
  /** Optional action / pageAction for managed Turnstile widgets. */
  pageAction?: string;
}

/**
 * Solve a Cloudflare Turnstile challenge through CapSolver.
 * Used by CF-gated modules when a sitekey is known.
 */
export async function solveTurnstile(opts: SolveTurnstileInput): Promise<string> {
  const taskType = opts.taskType?.trim() || 'AntiTurnstileTaskProxyLess';
  const task: Record<string, unknown> = {
    type: taskType,
    websiteURL: opts.websiteURL,
    websiteKey: opts.websiteKey,
  };
  if (opts.pageAction?.trim()) task['metadata'] = { action: opts.pageAction.trim() };

  const create = await postJson(`${BASE}/createTask`, {
    clientKey: opts.apiKey,
    task,
  });
  if (create.errorId !== 0) {
    throw new Error(`capsolver create: ${String(create.errorDescription ?? 'unknown')}`);
  }

  const taskId = create.taskId;
  if (typeof taskId !== 'string') throw new Error('capsolver create: no taskId');

  for (let i = 0; i < MAX_POLL; i++) {
    await sleep(POLL_INTERVAL_MS);
    const r = await postJson(`${BASE}/getTaskResult`, { clientKey: opts.apiKey, taskId });
    if (r.errorId !== 0) {
      throw new Error(`capsolver poll: ${String(r.errorDescription ?? 'unknown')}`);
    }
    if (r.status === 'ready') {
      const sol = r.solution;
      if (
        sol &&
        typeof sol === 'object' &&
        'token' in sol &&
        typeof (sol as { token: unknown }).token === 'string'
      ) {
        return (sol as { token: string }).token;
      }
      throw new Error('capsolver ready but no token in solution');
    }
  }
  throw new Error('capsolver timeout');
}

/** Resolve a CapSolver API key from account config, vault bundle, or environment. */
export function resolveCapsolverApiKey(sources: {
  accountKey?: string | undefined;
  bundleKey?: string | undefined;
  envKey?: string | undefined;
}): string | undefined {
  for (const value of [sources.accountKey, sources.bundleKey, sources.envKey]) {
    const key = value?.trim();
    if (key) return key;
  }
  return undefined;
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.body.json()) as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
