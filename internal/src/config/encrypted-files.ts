import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  chmodSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { encryptVault, decryptVault } from '../vault/crypto.js';
import type { StoredGameSessions } from '../api/browser-session.js';
import type { StoredTollanSessions } from '../tollan/auth.js';
import type { StoredCambriaSessions } from '../cambria/client.js';

/** Mode 0o600: owner read+write only. Applied to secrets.enc and all plaintext windows. */
const OWNER_RW = 0o600;

export interface SecretsBundle {
  accounts: string;
  proxies: string;
  /** Optional CapSolver key used for Cloudflare Turnstile (Cambria and future modules). */
  capsolverApiKey?: string;
  /** Browser-acquired Gigaverse sessions, encrypted with the rest of the vault. */
  gameSessions?: StoredGameSessions;
  /** One-time Tollan logins captured during the same Abstract browser approval. */
  tollanSessions?: StoredTollanSessions;
  /** Official Cambria Privy sessions captured in the user's regular browser. */
  cambriaSessions?: StoredCambriaSessions;
}

const DEFAULT_ENC_PATH = 'secrets.enc';
const DEFAULT_ACCOUNTS_PATH = 'accounts.txt';
const DEFAULT_PROXIES_PATH = 'proxies.txt';

export interface PathsConfig {
  encPath?: string;
  accountsPath?: string;
  proxiesPath?: string;
}

function resolvePaths(cfg: PathsConfig = {}) {
  return {
    encPath: resolve(cfg.encPath ?? DEFAULT_ENC_PATH),
    accountsPath: resolve(cfg.accountsPath ?? DEFAULT_ACCOUNTS_PATH),
    proxiesPath: resolve(cfg.proxiesPath ?? DEFAULT_PROXIES_PATH),
  };
}

export function hasEncrypted(cfg: PathsConfig = {}): boolean {
  return existsSync(resolvePaths(cfg).encPath);
}

export function hasPlaintext(cfg: PathsConfig = {}): boolean {
  const { accountsPath, proxiesPath } = resolvePaths(cfg);
  return existsSync(accountsPath) && existsSync(proxiesPath);
}

/** Encrypt a complete bundle without writing any plaintext companion files. */
export async function saveEncryptedBundle(
  bundle: SecretsBundle,
  password: string,
  cfg: PathsConfig = {},
): Promise<string> {
  const { encPath } = resolvePaths(cfg);
  const blob = await encryptVault(bundle, password);
  mkdirSync(dirname(encPath), { recursive: true });
  const temporaryPath = `${encPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporaryPath, blob, { mode: OWNER_RW, flag: 'wx' });
    renameSync(temporaryPath, encPath);
  } finally {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // best-effort cleanup after a failed atomic replace
    }
  }
  try {
    chmodSync(encPath, OWNER_RW);
  } catch {
    // best-effort on filesystems without POSIX modes
  }
  return encPath;
}

/** Encrypt accounts.txt + proxies.txt → secrets.enc, then DELETE the plaintext files. */
export async function encryptPlaintext(password: string, cfg: PathsConfig = {}): Promise<string> {
  const { encPath, accountsPath, proxiesPath } = resolvePaths(cfg);
  if (!existsSync(accountsPath) || !existsSync(proxiesPath)) {
    throw new Error('plaintext files missing — need both accounts.txt and proxies.txt');
  }
  // Restrict plaintext files immediately — they should never be world-readable.
  try {
    chmodSync(accountsPath, OWNER_RW);
  } catch {
    // best-effort: may fail on some FS or if file doesn't exist yet
  }
  try {
    chmodSync(proxiesPath, OWNER_RW);
  } catch {
    // best-effort
  }

  const bundle: SecretsBundle = {
    accounts: readFileSync(accountsPath, 'utf8'),
    proxies: readFileSync(proxiesPath, 'utf8'),
  };
  await saveEncryptedBundle(bundle, password, { encPath });

  // Shred plaintext: overwrite with zeros first to make recovery harder, then unlink.
  try {
    const overwrite = Buffer.alloc(Math.max(readFileSync(accountsPath).length, 256));
    writeFileSync(accountsPath, overwrite);
    unlinkSync(accountsPath);
  } catch {
    // best-effort
  }
  try {
    const overwrite = Buffer.alloc(Math.max(readFileSync(proxiesPath).length, 256));
    writeFileSync(proxiesPath, overwrite);
    unlinkSync(proxiesPath);
  } catch {
    // best-effort
  }

  return encPath;
}

/** Decrypt secrets.enc → return contents in memory (does NOT write to disk). */
export async function decryptToMemory(
  password: string,
  cfg: PathsConfig = {},
): Promise<SecretsBundle> {
  const { encPath } = resolvePaths(cfg);
  if (!existsSync(encPath)) {
    throw new Error(`no encrypted secrets at ${encPath}`);
  }
  const blob = new Uint8Array(readFileSync(encPath));
  return await decryptVault<SecretsBundle>(blob, password);
}

/** Decrypt secrets.enc → write back to accounts.txt + proxies.txt (for editing). */
export async function decryptToFiles(password: string, cfg: PathsConfig = {}): Promise<void> {
  const { accountsPath, proxiesPath } = resolvePaths(cfg);
  const bundle = await decryptToMemory(password, cfg);
  writeFileSync(accountsPath, bundle.accounts);
  writeFileSync(proxiesPath, bundle.proxies);
  // Restrict plaintext immediately — they contain private keys.
  try {
    chmodSync(accountsPath, OWNER_RW);
  } catch {
    // best-effort
  }
  try {
    chmodSync(proxiesPath, OWNER_RW);
  } catch {
    // best-effort
  }
}
