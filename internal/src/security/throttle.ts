/**
 * Brute-force throttle for the vault unlock password prompt.
 *
 * Strategy:
 *   - Failure 1:  sleep 1 s before allowing retry
 *   - Failure 2:  sleep 5 s
 *   - Failure 3+: sleep 30 s
 *   - Failure 6+: refuse for 5 min (write lock-out to attempts file; process exits)
 *
 * State is persisted to ~/.gigabot/.unlock-attempts.json so it survives
 * rapid process restarts.  The user can always `rm ~/.gigabot/.unlock-attempts.json`
 * to reset — the intent is to slow scripted brute force, not lock the legitimate user out.
 *
 * The sleep function is injectable for unit tests.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const GIGABOT_HOME = resolve(process.env['GIGABOT_HOME'] ?? join(homedir(), '.gigabot'));
const ATTEMPTS_FILE = join(GIGABOT_HOME, '.unlock-attempts.json');

/** Delay schedule per failure count (1-indexed). */
const DELAY_MS: Record<number, number> = {
  1: 1_000,
  2: 5_000,
};
const DELAY_HIGH_MS = 30_000;

/** After this many consecutive failures within the lockout window, refuse for LOCKOUT_MS. */
const LOCKOUT_THRESHOLD = 6;
const LOCKOUT_MS = 5 * 60 * 1_000; // 5 minutes

interface AttemptsRecord {
  /** ISO timestamp of the first failure in the current run. */
  firstFailAt: string;
  /** Total consecutive wrong-password attempts since firstFailAt. */
  count: number;
}

/** Exposed for testing: injectable sleep function. */
export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read the persisted attempts record. Returns null if none exists or unreadable. */
function readAttempts(): AttemptsRecord | null {
  if (!existsSync(ATTEMPTS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(ATTEMPTS_FILE, 'utf8')) as AttemptsRecord;
  } catch {
    return null;
  }
}

/** Persist the attempts record. Best-effort — never throws. */
function writeAttempts(rec: AttemptsRecord): void {
  try {
    mkdirSync(GIGABOT_HOME, { recursive: true });
    writeFileSync(ATTEMPTS_FILE, JSON.stringify(rec), { mode: 0o600 });
  } catch {
    // best-effort: if FS is not writable the throttle still works in-process
  }
}

/** Remove the attempts file (called on successful unlock). */
export function clearAttempts(): void {
  try {
    unlinkSync(ATTEMPTS_FILE);
  } catch {
    // already gone — fine
  }
}

/**
 * Record a wrong-password failure, sleep the appropriate delay, and throw if
 * we've hit the lockout threshold.
 *
 * @param sleep Injected sleep function (defaults to real setTimeout).
 * @throws Error with a user-facing message when locked out.
 */
export async function recordFailure(sleep: SleepFn = defaultSleep): Promise<void> {
  const now = Date.now();
  let rec = readAttempts();

  if (rec === null) {
    rec = { firstFailAt: new Date(now).toISOString(), count: 1 };
  } else {
    rec.count += 1;
  }

  writeAttempts(rec);

  // Lockout check: too many failures → refuse for LOCKOUT_MS.
  if (rec.count >= LOCKOUT_THRESHOLD) {
    const firstFail = new Date(rec.firstFailAt).getTime();
    const elapsed = now - firstFail;
    const remaining = LOCKOUT_MS - elapsed;

    if (remaining > 0) {
      const remainSec = Math.ceil(remaining / 1000);
      throw new Error(
        `Too many wrong passwords. Try again in ${remainSec}s ` +
          `(or delete ${ATTEMPTS_FILE} to reset).`,
      );
    } else {
      // Lockout window has expired; reset counter and allow retry.
      rec = { firstFailAt: new Date(now).toISOString(), count: 1 };
      writeAttempts(rec);
    }
  }

  // Sleep before allowing retry.
  const delayMs =
    rec.count === 1
      ? (DELAY_MS[1] ?? 1_000)
      : rec.count === 2
        ? (DELAY_MS[2] ?? 5_000)
        : DELAY_HIGH_MS;

  await sleep(delayMs);
}
