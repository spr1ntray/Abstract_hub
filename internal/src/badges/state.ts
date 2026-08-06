import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const AddressSchema = z.string().regex(/^0x[a-f0-9]{40}$/);

const BadgeActionRecordSchema = z
  .object({
    badgeId: z.number().int().positive(),
    address: AddressSchema,
    action: z.literal('gigaverse_racing_item'),
    state: z.enum(['pending', 'submitted', 'completed', 'failed']),
    raceId: z.number().int().positive(),
    petId: z.number().int().positive(),
    itemId: z.number().int().positive(),
    amount: z.literal(1),
    startedAt: z.iso.datetime(),
    queuedAt: z.iso.datetime().optional(),
    scheduledTick: z.number().int().nonnegative().optional(),
    serverSubmittedAt: z.number().int().positive().optional(),
    completedAt: z.iso.datetime().optional(),
    verifiedAt: z.iso.datetime().optional(),
    appliedAt: z.number().int().positive().optional(),
    lastResolvedTick: z.number().int().nonnegative().optional(),
    claimTxHash: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .optional(),
    claimSubmittedAt: z.iso.datetime().optional(),
    claimRetryAt: z.iso.datetime().optional(),
    failedAt: z.iso.datetime().optional(),
    error: z.string().max(1_000).optional(),
  })
  .strict();

const BadgeActionFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    records: z.record(z.string(), BadgeActionRecordSchema),
  })
  .strict();

export type BadgeActionRecord = z.infer<typeof BadgeActionRecordSchema>;

interface BadgeActionInput {
  badgeId: number;
  address: string;
  raceId: number;
  petId: number;
  itemId: number;
}

function normalizedAddress(address: string): string {
  const value = address.toLowerCase();
  if (!AddressSchema.safeParse(value).success) throw new Error('Некорректный адрес Abstract');
  return value;
}

function recordKey(address: string, badgeId: number): string {
  return `${badgeId}:${normalizedAddress(address)}`;
}

function emptyFile(): z.infer<typeof BadgeActionFileSchema> {
  return { schemaVersion: 1, records: {} };
}

export function blocksBadgeAction(record: BadgeActionRecord | undefined): boolean {
  return (
    record?.state === 'pending' ||
    record?.state === 'submitted' ||
    (record?.state === 'completed' && Boolean(record.verifiedAt))
  );
}

/**
 * Durable guard for consumable badge actions. A pending record is written
 * before the network mutation, so an ambiguous timeout can never cause an
 * automatic second spend.
 */
export class BadgeActionStore {
  constructor(private readonly filePath: string) {}

  get(address: string, badgeId: number): BadgeActionRecord | undefined {
    return this.read().records[recordKey(address, badgeId)];
  }

  begin(input: BadgeActionInput, now = new Date()): BadgeActionRecord {
    const file = this.read();
    const key = recordKey(input.address, input.badgeId);
    const existing = file.records[key];
    if (blocksBadgeAction(existing)) {
      throw new Error(
        existing?.state === 'completed'
          ? 'Действие для этого бейджа уже выполнено'
          : existing?.state === 'submitted'
            ? 'Предмет уже поставлен в гонку; сначала нужно дождаться её завершения'
            : 'Предыдущая отправка имеет неопределённый результат; повтор заблокирован',
      );
    }
    const record: BadgeActionRecord = {
      badgeId: input.badgeId,
      address: normalizedAddress(input.address),
      action: 'gigaverse_racing_item',
      state: 'pending',
      raceId: input.raceId,
      petId: input.petId,
      itemId: input.itemId,
      amount: 1,
      startedAt: now.toISOString(),
    };
    file.records[key] = record;
    this.write(file);
    return record;
  }

  markSubmitted(
    address: string,
    badgeId: number,
    submission: { scheduledTick: number; serverSubmittedAt: number },
    now = new Date(),
  ): BadgeActionRecord {
    const file = this.read();
    const key = recordKey(address, badgeId);
    const current = file.records[key];
    if (!current || current.state !== 'pending') {
      throw new Error('Не найдена ожидающая операция бейджа');
    }
    const record: BadgeActionRecord = {
      ...current,
      state: 'submitted',
      queuedAt: now.toISOString(),
      scheduledTick: submission.scheduledTick,
      serverSubmittedAt: submission.serverSubmittedAt,
    };
    file.records[key] = record;
    this.write(file);
    return record;
  }

  complete(
    address: string,
    badgeId: number,
    verification: { appliedAt: number; lastResolvedTick: number },
    now = new Date(),
  ): BadgeActionRecord {
    const file = this.read();
    const key = recordKey(address, badgeId);
    const current = file.records[key];
    if (!current || current.state !== 'submitted') {
      throw new Error('Не найдена поставленная в гонку операция бейджа');
    }
    const timestamp = now.toISOString();
    const record: BadgeActionRecord = {
      ...current,
      state: 'completed',
      completedAt: timestamp,
      verifiedAt: timestamp,
      appliedAt: verification.appliedAt,
      lastResolvedTick: verification.lastResolvedTick,
    };
    file.records[key] = record;
    this.write(file);
    return record;
  }

  markClaimSubmitted(
    address: string,
    badgeId: number,
    claimTxHash: string,
    now = new Date(),
  ): BadgeActionRecord {
    const file = this.read();
    const key = recordKey(address, badgeId);
    const current = file.records[key];
    if (!current || current.state !== 'completed' || !current.verifiedAt) {
      throw new Error('Racing-действие для этого бейджа ещё не завершено');
    }
    const record = BadgeActionRecordSchema.parse({
      ...current,
      claimTxHash,
      claimSubmittedAt: now.toISOString(),
      claimRetryAt: undefined,
    });
    file.records[key] = record;
    this.write(file);
    return record;
  }

  deferClaim(
    address: string,
    badgeId: number,
    retryAfterMs: number,
    now = new Date(),
  ): BadgeActionRecord {
    const file = this.read();
    const key = recordKey(address, badgeId);
    const current = file.records[key];
    if (!current || current.state !== 'completed' || !current.verifiedAt) {
      throw new Error('Racing-действие для этого бейджа ещё не завершено');
    }
    const delay = Math.max(1_000, Math.min(30 * 60_000, Math.ceil(retryAfterMs)));
    const record = BadgeActionRecordSchema.parse({
      ...current,
      claimRetryAt: new Date(now.getTime() + delay).toISOString(),
    });
    file.records[key] = record;
    this.write(file);
    return record;
  }

  /** Clear claim backoff once Portal confirms the badge is owned. */
  clearClaimRetry(address: string, badgeId: number): BadgeActionRecord | undefined {
    const file = this.read();
    const key = recordKey(address, badgeId);
    const current = file.records[key];
    if (!current) return undefined;
    if (!current.claimRetryAt && !current.error) return current;
    const record = BadgeActionRecordSchema.parse({
      ...current,
      claimRetryAt: undefined,
      error: undefined,
    });
    file.records[key] = record;
    this.write(file);
    return record;
  }

  fail(address: string, badgeId: number, error: string, now = new Date()): BadgeActionRecord {
    const file = this.read();
    const key = recordKey(address, badgeId);
    const current = file.records[key];
    if (!current || !['pending', 'submitted'].includes(current.state)) {
      throw new Error('Не найдена ожидающая операция бейджа');
    }
    const record: BadgeActionRecord = {
      ...current,
      state: 'failed',
      failedAt: now.toISOString(),
      error: error.slice(0, 1_000),
    };
    file.records[key] = record;
    this.write(file);
    return record;
  }

  private read(): z.infer<typeof BadgeActionFileSchema> {
    if (!existsSync(this.filePath)) return emptyFile();
    try {
      return BadgeActionFileSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      throw new Error(
        'Локальная защита бейджей повреждена. Расход предметов заблокирован до проверки файла.',
        { cause: error },
      );
    }
  }

  private write(file: z.infer<typeof BadgeActionFileSchema>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporaryPath, this.filePath);
  }
}
