import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export const PORTAL_EXPERIENCE_LIMIT = 100;

export const PortalExperienceItemSchema = z
  .object({
    userId: z.union([z.string(), z.number()]),
    epoch: z.coerce.number().int().nonnegative(),
    description: z.string().optional(),
    points: z.coerce.number().finite().nonnegative(),
    referralXp: z.coerce.number().finite().nonnegative().optional(),
    season: z.coerce.number().int().nonnegative(),
  })
  .passthrough();

export const PortalExperienceSchema = z.object({
  items: z.array(PortalExperienceItemSchema),
  lastEpoch: z.coerce.number().int().nonnegative(),
});

export type PortalExperience = z.infer<typeof PortalExperienceSchema>;
export type PortalExperienceItem = z.infer<typeof PortalExperienceItemSchema>;

export interface AbstractXpSnapshot {
  items: PortalExperienceItem[];
  lastEpoch: number;
  currentEpoch: number;
  /** Sum of the epochs returned for the active season. */
  totalXp: number;
  /** XP visible in epochs newer than Portal's last confirmed epoch. */
  pendingPoints: number;
  /** Portal's all-time XP counter when the profile response exposes it. */
  lifetimeXp?: number | undefined;
  latestEpoch: number | null;
  latestPoints: number;
}

export interface StoredAbstractXpSnapshot extends AbstractXpSnapshot {
  checkedAt: string;
  changedAt?: string | undefined;
  hasNewXp: boolean;
  /** Unacknowledged positive XP delta, including pending XP found on first sync. */
  newPoints: number;
}

const StoredSnapshotSchema = z.object({
  items: z.array(PortalExperienceItemSchema),
  lastEpoch: z.number().int().nonnegative(),
  currentEpoch: z.number().int().nonnegative(),
  totalXp: z.number().finite().nonnegative(),
  pendingPoints: z.number().finite().nonnegative().default(0),
  lifetimeXp: z.number().finite().nonnegative().optional(),
  latestEpoch: z.number().int().nonnegative().nullable(),
  latestPoints: z.number().finite().nonnegative(),
  checkedAt: z.string(),
  changedAt: z.string().optional(),
  hasNewXp: z.boolean(),
  newPoints: z.number().finite().nonnegative().default(0),
});

const StoreSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), StoredSnapshotSchema),
});

export function summarizePortalExperience(
  raw: unknown,
  options: { lifetimeXp?: number } = {},
): AbstractXpSnapshot {
  const parsed = PortalExperienceSchema.parse(raw);
  const items = [...parsed.items].sort((left, right) => right.epoch - left.epoch);
  const latest = items.find((item) => item.epoch <= parsed.lastEpoch) ?? items[0];
  return {
    items,
    lastEpoch: parsed.lastEpoch,
    currentEpoch: parsed.lastEpoch + 1,
    totalXp: items.reduce((total, item) => total + item.points, 0),
    pendingPoints: items
      .filter((item) => item.epoch > parsed.lastEpoch)
      .reduce((total, item) => total + item.points, 0),
    ...(options.lifetimeXp !== undefined ? { lifetimeXp: options.lifetimeXp } : {}),
    latestEpoch: latest?.epoch ?? null,
    latestPoints: latest?.points ?? 0,
  };
}

function addressKey(address: string): string {
  const normalized = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new Error('Некорректный адрес Abstract');
  return normalized;
}

export class AbstractXpStore {
  constructor(private readonly path: string) {}

  get(address: string): StoredAbstractXpSnapshot | undefined {
    const snapshot = this.read().accounts[addressKey(address)];
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  record(address: string, snapshot: AbstractXpSnapshot): StoredAbstractXpSnapshot {
    const key = addressKey(address);
    const store = this.read();
    const previous = store.accounts[key];
    const now = new Date().toISOString();
    const previousCounter = previous ? (previous.lifetimeXp ?? previous.totalXp) : undefined;
    const currentCounter = snapshot.lifetimeXp ?? snapshot.totalXp;
    const increase = previous
      ? Math.max(0, currentCounter - (previousCounter ?? 0))
      : Math.max(0, snapshot.pendingPoints);
    const next: StoredAbstractXpSnapshot = {
      ...snapshot,
      checkedAt: now,
      newPoints: (previous?.newPoints ?? 0) + increase,
      hasNewXp: increase > 0 || previous?.hasNewXp === true,
      ...((increase > 0 ? now : previous?.changedAt)
        ? { changedAt: increase > 0 ? now : previous?.changedAt }
        : {}),
    };
    store.accounts[key] = next;
    this.write(store);
    return structuredClone(next);
  }

  acknowledge(address: string): StoredAbstractXpSnapshot | undefined {
    const key = addressKey(address);
    const store = this.read();
    const current = store.accounts[key];
    if (!current) return undefined;
    current.hasNewXp = false;
    current.newPoints = 0;
    this.write(store);
    return structuredClone(current);
  }

  clear(): void {
    this.write({ version: 1, accounts: {} });
  }

  private read(): z.infer<typeof StoreSchema> {
    if (!existsSync(this.path)) return { version: 1, accounts: {} };
    try {
      return StoreSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      return { version: 1, accounts: {} };
    }
  }

  private write(store: z.infer<typeof StoreSchema>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
