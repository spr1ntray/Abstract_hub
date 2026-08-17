/**
 * User-configurable timing ranges for anti-sybil pacing delays.
 *
 * Values live at ~/.gigabot/timing.json so the user can tune them without
 * touching source code. Each delay independently samples a value within its
 * [minMs, maxMs] range (see humanizeFromRange in timing.ts).
 *
 * Defaults match the old humanish(mean, tail) behaviour approximately:
 *   action.mean ≈ 2500, tail ≈ 15000  →  range [1500, 5000] covers most cases
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface TimingRange {
  minMs: number;
  maxMs: number;
}

export interface TimingConfig {
  /** Independent delay before each selected account starts its session. */
  accountStart: TimingRange;
  /** Per-move delay (rock/paper/scissor/flee). */
  action: TimingRange;
  /** Pot, chest, craft, repair and salvage interactions. */
  nodeAction: TimingRange;
  /** Pause before loot pick (humans read the card text). */
  lootThinking: TimingRange;
  /** Post-action jitter so consecutive actions don't look robotic. */
  postAction: TimingRange;
  /** Between-runs pause (real players take breaks). */
  interRun: TimingRange;
}

export const DEFAULT_TIMING: TimingConfig = {
  accountStart: { minMs: 2_500, maxMs: 28_000 },
  action: { minMs: 1_800, maxMs: 7_500 },
  nodeAction: { minMs: 1_200, maxMs: 6_500 },
  lootThinking: { minMs: 2_500, maxMs: 11_000 },
  postAction: { minMs: 250, maxMs: 2_200 },
  interRun: { minMs: 70_000, maxMs: 300_000 },
};

const CONFIG_PATH = resolve(
  process.env['GIGABOT_HOME'] ?? resolve(homedir(), '.gigabot'),
  'timing.json',
);

/**
 * Load timing config from ~/.gigabot/timing.json.
 * Falls back to DEFAULT_TIMING if the file is absent or malformed.
 * Individual range fields fall back individually (partial override is fine).
 */
export function loadTimingConfig(): TimingConfig {
  // Env-var overrides take precedence over file — useful for CI / quick testing
  const fromEnv = loadTimingFromEnv();
  if (fromEnv) return fromEnv;

  if (!existsSync(CONFIG_PATH)) return DEFAULT_TIMING;

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<TimingConfig>;
    return mergeWithDefaults(raw);
  } catch {
    // Malformed JSON — fall back silently
    return DEFAULT_TIMING;
  }
}

/**
 * Merge a partial config with the defaults.
 * Each category merges its own min/max fields independently.
 */
function mergeWithDefaults(raw: Partial<TimingConfig>): TimingConfig {
  return {
    accountStart: { ...DEFAULT_TIMING.accountStart, ...raw.accountStart },
    action: { ...DEFAULT_TIMING.action, ...raw.action },
    nodeAction: { ...DEFAULT_TIMING.nodeAction, ...raw.nodeAction },
    lootThinking: { ...DEFAULT_TIMING.lootThinking, ...raw.lootThinking },
    postAction: { ...DEFAULT_TIMING.postAction, ...raw.postAction },
    interRun: { ...DEFAULT_TIMING.interRun, ...raw.interRun },
  };
}

/**
 * Check env vars for timing overrides.  Returns null if none are set.
 *
 * Supported vars:
 *   GIGABOT_ACTION_MIN_MS / GIGABOT_ACTION_MAX_MS
 *   GIGABOT_LOOT_MIN_MS   / GIGABOT_LOOT_MAX_MS
 *   GIGABOT_POST_MIN_MS   / GIGABOT_POST_MAX_MS
 *   GIGABOT_RUN_MIN_MS    / GIGABOT_RUN_MAX_MS
 */
function loadTimingFromEnv(): TimingConfig | null {
  const e = process.env;
  // Only kick in if at least one env override is present
  if (
    !e['GIGABOT_ACTION_MIN_MS'] &&
    !e['GIGABOT_ACTION_MAX_MS'] &&
    !e['GIGABOT_LOOT_MIN_MS'] &&
    !e['GIGABOT_LOOT_MAX_MS'] &&
    !e['GIGABOT_POST_MIN_MS'] &&
    !e['GIGABOT_POST_MAX_MS'] &&
    !e['GIGABOT_RUN_MIN_MS'] &&
    !e['GIGABOT_RUN_MAX_MS']
  ) {
    return null;
  }

  const n = (key: string, fallback: number): number => {
    const v = Number(e[key]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };

  return {
    accountStart: DEFAULT_TIMING.accountStart,
    action: {
      minMs: n('GIGABOT_ACTION_MIN_MS', DEFAULT_TIMING.action.minMs),
      maxMs: n('GIGABOT_ACTION_MAX_MS', DEFAULT_TIMING.action.maxMs),
    },
    nodeAction: DEFAULT_TIMING.nodeAction,
    lootThinking: {
      minMs: n('GIGABOT_LOOT_MIN_MS', DEFAULT_TIMING.lootThinking.minMs),
      maxMs: n('GIGABOT_LOOT_MAX_MS', DEFAULT_TIMING.lootThinking.maxMs),
    },
    postAction: {
      minMs: n('GIGABOT_POST_MIN_MS', DEFAULT_TIMING.postAction.minMs),
      maxMs: n('GIGABOT_POST_MAX_MS', DEFAULT_TIMING.postAction.maxMs),
    },
    interRun: {
      minMs: n('GIGABOT_RUN_MIN_MS', DEFAULT_TIMING.interRun.minMs),
      maxMs: n('GIGABOT_RUN_MAX_MS', DEFAULT_TIMING.interRun.maxMs),
    },
  };
}

/**
 * Persist a timing config to ~/.gigabot/timing.json.
 * Creates the directory if it doesn't exist.
 *
 * @throws If the file cannot be written (permissions, disk full, etc.).
 */
export function saveTimingConfig(cfg: TimingConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** Returns the absolute path to the timing config file. */
export function getTimingConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Validate that a timing config has positive ranges with minMs <= maxMs.
 * Returns an error string if invalid, null if valid.
 */
export function validateTimingConfig(cfg: TimingConfig): string | null {
  for (const [key, range] of Object.entries(cfg) as [keyof TimingConfig, TimingRange][]) {
    if (!Number.isFinite(range.minMs) || range.minMs < 0) {
      return `${key}.minMs must be a non-negative number`;
    }
    if (!Number.isFinite(range.maxMs) || range.maxMs < 0) {
      return `${key}.maxMs must be a non-negative number`;
    }
    if (range.minMs > range.maxMs) {
      return `${key}.minMs (${range.minMs}) must be <= maxMs (${range.maxMs})`;
    }
  }
  return null;
}
