/**
 * Human-ish delay distribution for anti-sybil pacing.
 *
 * Real players don't have flat-uniform timing — they have a fast common case
 * (most actions are ~mean), occasional hesitations (1-3x mean), and rare
 * zone-outs (toward the tail). This produces something closer to log-normal.
 *
 *   85% chance: 0.5x..1.5x mean   (normal action tempo)
 *   15% chance: mean..tail with cubic skew toward fast (rare long pauses)
 */
export function humanish(meanMs: number, tailMs: number): number {
  // Short-circuit in tests so unit tests don't sleep for real seconds.
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return 1;
  if (Math.random() < 0.85) {
    return Math.floor(meanMs * (0.5 + Math.random()));
  }
  const r = Math.random() ** 3; // cubic — most "long" pauses are still close to mean
  return Math.floor(meanMs + (tailMs - meanMs) * r);
}

/**
 * Pick a uniformly-random delay within [minMs, maxMs].
 * Short-circuits to 1 in test mode so unit tests never sleep.
 */
export function inRange(minMs: number, maxMs: number): number {
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return 1;
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

/**
 * Convenience wrapper — picks a delay from a TimingRange object.
 * Use this instead of humanish() for config-driven timing.
 */
export function humanizeFromRange(range: { minMs: number; maxMs: number }): number {
  return inRange(range.minMs, range.maxMs);
}

/** Sleep helper. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Legacy timing presets kept for backwards-compatibility.
 * New code should use loadTimingConfig() + humanizeFromRange() instead.
 */
export const TIMING = {
  /**
   * Per-move delay (rock/paper/scissor/flee).
   *
   * Real humans look at the screen, parse enemy HP/charges, decide a move.
   * 2.5s mean matches a relaxed turn-based player; 15s tail covers
   * occasional distraction. Previously 350ms which let rooms clear in
   * a couple seconds — way too fast, easy anti-bot flag.
   */
  action: { mean: 2500, tail: 15_000 },
  /** Pause before picking loot (humans actually read the card text). */
  lootThinking: { mean: 3000, tail: 12_000 },
  /** Small post-action jitter so loops don't have inhuman regularity. */
  postAction: { mean: 400, tail: 2500 },
  /** Inter-run pause: real players take real breaks. 90s mean, up to 10min.
   *  Set GIGABOT_FAST=true to compress to 30s mean for testing. */
  interRun: { mean: 90_000, tail: 600_000 },
  interRunFast: { mean: 30_000, tail: 90_000 },
};
