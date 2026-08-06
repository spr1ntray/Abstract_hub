import { gcm } from '@noble/ciphers/aes.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { randomBytes } from 'node:crypto';

/**
 * scrypt cost parameter N.
 *
 * Production default: 2^18 (~2 s on a modern Mac, doubles brute-force cost vs. old 2^17).
 * Override via GIGABOT_SCRYPT_N for tests or constrained environments:
 *   GIGABOT_SCRYPT_N=4096  # 2^12 — fast for unit tests
 *
 * The value must be a power of 2 and ≥ 2 (scrypt requirement).
 */
function resolveScryptN(): number {
  const raw = process.env['GIGABOT_SCRYPT_N'];
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 2 || (n & (n - 1)) !== 0) {
      throw new Error(`GIGABOT_SCRYPT_N must be a power-of-2 integer ≥ 2, got: ${raw}`);
    }
    return n;
  }
  return 2 ** 18;
}

const SCRYPT_PARAMS = { N: resolveScryptN(), r: 8, p: 1, dkLen: 32 };
const SALT_LEN = 16;
const NONCE_LEN = 12;
const MAGIC = new Uint8Array([0x47, 0x42, 0x56, 0x01]); // "GBV\x01"

export async function encryptVault(data: unknown, password: string): Promise<Uint8Array> {
  const salt = new Uint8Array(randomBytes(SALT_LEN));
  const nonce = new Uint8Array(randomBytes(NONCE_LEN));
  const key = scrypt(password, salt, SCRYPT_PARAMS);

  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = gcm(key, nonce).encrypt(plaintext);

  const out = new Uint8Array(MAGIC.length + salt.length + nonce.length + ciphertext.length);
  out.set(MAGIC, 0);
  out.set(salt, MAGIC.length);
  out.set(nonce, MAGIC.length + salt.length);
  out.set(ciphertext, MAGIC.length + salt.length + nonce.length);
  return out;
}

export async function decryptVault<T>(blob: Uint8Array, password: string): Promise<T> {
  if (blob.length < MAGIC.length + SALT_LEN + NONCE_LEN + 16) {
    throw new Error('vault: blob too short');
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) throw new Error('vault: magic mismatch');
  }
  const salt = blob.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const nonce = blob.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + NONCE_LEN);
  const ciphertext = blob.subarray(MAGIC.length + SALT_LEN + NONCE_LEN);

  const key = scrypt(password, salt, SCRYPT_PARAMS);
  const plaintext = gcm(key, nonce).decrypt(ciphertext);

  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
