import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { encryptVault, decryptVault } from './crypto.js';
import { VaultSchema, type Vault } from './schema.js';

export class VaultStore {
  constructor(private readonly path: string) {}

  async save(data: Vault, password: string): Promise<void> {
    const parsed = VaultSchema.parse(data);
    const blob = await encryptVault(parsed, password);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, blob);
  }

  async load(password: string): Promise<Vault> {
    const blob = await readFile(this.path);
    const data = await decryptVault<unknown>(new Uint8Array(blob), password);
    const migrated = migrateIfV1(data);
    return VaultSchema.parse(migrated);
  }

  async update(patch: Partial<Vault>, password: string): Promise<void> {
    const current = await this.load(password);
    await this.save({ ...current, ...patch }, password);
  }
}

/**
 * v1 → v2 migration: detect old single-account shape and convert to
 * `{ version: 2, accounts: [<one synthetic 'default' account>] }`.
 */
export function migrateIfV1(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'accounts' in raw) {
    return raw; // already v2
  }
  if (!raw || typeof raw !== 'object') {
    return raw;
  }

  const old = raw as {
    privateKey?: string;
    proxy?: unknown;
    capsolver?: unknown;
    sessionToken?: string;
    sessionExpiresAt?: number;
    agwAddress?: string;
  };

  // sessionToken (v1 cookie field) is intentionally dropped — auth now uses JWT
  // derived from AGW-signed login; no cookie pasting required.
  const account: Record<string, unknown> = {
    name: 'default',
    proxy: old.proxy,
  };
  if (old.privateKey !== undefined) account.privateKey = old.privateKey;
  if (old.agwAddress !== undefined) account.agwAddress = old.agwAddress;
  if (old.capsolver !== undefined) account.capsolver = old.capsolver;

  return {
    version: 2,
    accounts: [account],
  };
}
