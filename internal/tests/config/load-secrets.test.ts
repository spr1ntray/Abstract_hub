/**
 * Regression tests for the secret-loading state machine (play.ts / loadSecretsCore).
 *
 * Covers all 5 states:
 *   1. No secrets.enc, no plaintext → exits with error
 *   2. Only secrets.enc → decrypt with right password succeeds; wrong password exits
 *   3. Only plaintext (first-time) → prompt-confirm, encrypt, delete plaintext, return data
 *   4. Both present (regression case) → re-encrypt plaintext with matching password, return plaintext data
 *   5. Both present + wrong password → exit with error, do NOT overwrite secrets.enc
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { encryptPlaintext, decryptToMemory } from '../../src/config/encrypted-files.js';
import { loadSecretsCore } from '../../src/play.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gigaverse-test-'));
}

function cfg(dir: string) {
  return {
    encPath: join(dir, 'secrets.enc'),
    accountsPath: join(dir, 'accounts.txt'),
    proxiesPath: join(dir, 'proxies.txt'),
  };
}

const ACCOUNTS_CONTENT = '0x' + 'a'.repeat(64) + '\n';
const PROXIES_CONTENT = '127.0.0.1:1080\n';
const ACCOUNTS_CONTENT_V2 = '0x' + 'b'.repeat(64) + '\n';
const PROXIES_CONTENT_V2 = '127.0.0.1:2080\n';

const PASSWORD = 'correcthorsebattery';
const WRONG_PASSWORD = 'thisIsWrong!123';

/** Write both plaintext files to dir. */
function writePlaintext(dir: string, accounts = ACCOUNTS_CONTENT, proxies = PROXIES_CONTENT) {
  const c = cfg(dir);
  writeFileSync(c.accountsPath, accounts);
  writeFileSync(c.proxiesPath, proxies);
}

/** Create an encrypted secrets.enc from given plaintext content. */
async function writeEncrypted(
  dir: string,
  password: string,
  accounts = ACCOUNTS_CONTENT,
  proxies = PROXIES_CONTENT,
) {
  writePlaintext(dir, accounts, proxies);
  await encryptPlaintext(password, cfg(dir));
  // encryptPlaintext deletes the plaintext — dir now has only secrets.enc
}

/**
 * Build an exitFn that throws an Error when called.
 * This lets tests catch the "exit" without killing the process.
 */
function makeExitThrow(): (code: number) => never {
  return (code: number) => {
    throw new Error(`process.exit(${code})`);
  };
}

/**
 * Build a PromptFn that pops from a fixed queue of answers.
 * Throws if more prompts are issued than answers supplied.
 */
function makePromptQueue(...answers: string[]) {
  const queue = [...answers];
  return async (_message: string): Promise<string> => {
    const answer = queue.shift();
    if (answer === undefined) throw new Error('Unexpected extra password prompt — queue empty');
    return answer;
  };
}

// ---------------------------------------------------------------------------
// State 1: no secrets.enc, no plaintext → error
// ---------------------------------------------------------------------------

describe('loadSecretsCore — state 1: no files', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('calls exitFn(1) when neither file exists', async () => {
    const prompt = makePromptQueue(); // should never be called
    await expect(loadSecretsCore(cfg(dir), prompt, makeExitThrow())).rejects.toThrow(
      'process.exit(1)',
    );
  });

  it('does not call prompt when neither file exists', async () => {
    let called = false;
    const prompt = async (_m: string) => {
      called = true;
      return '';
    };
    await expect(loadSecretsCore(cfg(dir), prompt, makeExitThrow())).rejects.toThrow();
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// State 2: only secrets.enc
// ---------------------------------------------------------------------------

describe('loadSecretsCore — state 2: only secrets.enc', () => {
  let dir: string;
  beforeEach(async () => {
    dir = makeTmpDir();
    await writeEncrypted(dir, PASSWORD);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('decrypts and returns the bundle on correct password', async () => {
    const prompt = makePromptQueue(PASSWORD);
    const bundle = await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    expect(bundle.accounts).toBe(ACCOUNTS_CONTENT);
    expect(bundle.proxies).toBe(PROXIES_CONTENT);
  });

  it('does not leave plaintext files on disk after successful decrypt', async () => {
    const prompt = makePromptQueue(PASSWORD);
    await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    const c = cfg(dir);
    expect(existsSync(c.accountsPath)).toBe(false);
    expect(existsSync(c.proxiesPath)).toBe(false);
  });

  it('calls exitFn(1) on wrong password', async () => {
    const prompt = makePromptQueue(WRONG_PASSWORD);
    await expect(loadSecretsCore(cfg(dir), prompt, makeExitThrow())).rejects.toThrow(
      'process.exit(1)',
    );
  });

  it('does not create plaintext files when wrong password is given', async () => {
    const prompt = makePromptQueue(WRONG_PASSWORD);
    const c = cfg(dir);
    try {
      await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    } catch {
      // expected exit
    }
    expect(existsSync(c.accountsPath)).toBe(false);
    expect(existsSync(c.proxiesPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// State 3: only plaintext (first-time setup)
// ---------------------------------------------------------------------------

describe('loadSecretsCore — state 3: first-time setup (plaintext only)', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
    writePlaintext(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prompts twice (password + confirm) and returns the bundle', async () => {
    // prompt called twice: once for password, once for confirm
    const prompt = makePromptQueue(PASSWORD, PASSWORD);
    const bundle = await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    expect(bundle.accounts).toBe(ACCOUNTS_CONTENT);
    expect(bundle.proxies).toBe(PROXIES_CONTENT);
  });

  it('deletes plaintext files after encrypting', async () => {
    const prompt = makePromptQueue(PASSWORD, PASSWORD);
    const c = cfg(dir);
    await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    expect(existsSync(c.accountsPath)).toBe(false);
    expect(existsSync(c.proxiesPath)).toBe(false);
  });

  it('creates secrets.enc after encrypting', async () => {
    const prompt = makePromptQueue(PASSWORD, PASSWORD);
    const c = cfg(dir);
    await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    expect(existsSync(c.encPath)).toBe(true);
  });

  it('calls exitFn(1) when passwords do not match', async () => {
    const prompt = makePromptQueue(PASSWORD, 'differentpassword');
    await expect(loadSecretsCore(cfg(dir), prompt, makeExitThrow())).rejects.toThrow(
      'process.exit(1)',
    );
  });

  it('calls exitFn(1) when password is shorter than 8 chars', async () => {
    const prompt = makePromptQueue('short', 'short');
    await expect(loadSecretsCore(cfg(dir), prompt, makeExitThrow())).rejects.toThrow(
      'process.exit(1)',
    );
  });

  it('does not create secrets.enc when password confirmation fails', async () => {
    const prompt = makePromptQueue(PASSWORD, 'differentpassword');
    const c = cfg(dir);
    try {
      await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    } catch {
      // expected
    }
    expect(existsSync(c.encPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// State 4: BOTH present — REGRESSION CASE
// Plaintext must win: re-encrypt with same password, return plaintext data.
// ---------------------------------------------------------------------------

describe('loadSecretsCore — state 4: both files present (regression)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = makeTmpDir();
    // Write OLD data to secrets.enc
    await writeEncrypted(dir, PASSWORD, ACCOUNTS_CONTENT, PROXIES_CONTENT);
    // Now write NEWER plaintext (simulates user editing accounts.txt after decrypting)
    writePlaintext(dir, ACCOUNTS_CONTENT_V2, PROXIES_CONTENT_V2);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the PLAINTEXT data, NOT the stale encrypted data', async () => {
    const prompt = makePromptQueue(PASSWORD);
    const bundle = await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    // Must return the NEW plaintext content, not the old encrypted content
    expect(bundle.accounts).toBe(ACCOUNTS_CONTENT_V2);
    expect(bundle.proxies).toBe(PROXIES_CONTENT_V2);
  });

  it('re-encrypts secrets.enc with the plaintext data', async () => {
    const prompt = makePromptQueue(PASSWORD);
    const c = cfg(dir);
    await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    // secrets.enc should now decrypt to the NEW data
    const reloaded = await decryptToMemory(PASSWORD, c);
    expect(reloaded.accounts).toBe(ACCOUNTS_CONTENT_V2);
    expect(reloaded.proxies).toBe(PROXIES_CONTENT_V2);
  });

  it('deletes plaintext files after re-encrypting', async () => {
    const prompt = makePromptQueue(PASSWORD);
    const c = cfg(dir);
    await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    expect(existsSync(c.accountsPath)).toBe(false);
    expect(existsSync(c.proxiesPath)).toBe(false);
  });

  it('prompts only once (no confirm needed — password known from existing enc)', async () => {
    let callCount = 0;
    const prompt = async (_m: string) => {
      callCount++;
      return PASSWORD;
    };
    await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// State 5: both present + wrong password → exit, do NOT overwrite secrets.enc
// ---------------------------------------------------------------------------

describe('loadSecretsCore — state 5: both present, wrong password', () => {
  let dir: string;
  let encBlobBefore: Buffer;

  beforeEach(async () => {
    dir = makeTmpDir();
    await writeEncrypted(dir, PASSWORD, ACCOUNTS_CONTENT, PROXIES_CONTENT);
    writePlaintext(dir, ACCOUNTS_CONTENT_V2, PROXIES_CONTENT_V2);
    // Snapshot the original encrypted blob before the attempt
    encBlobBefore = Buffer.from(readFileSync(cfg(dir).encPath));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('calls exitFn(1) when password does not match existing secrets.enc', async () => {
    const prompt = makePromptQueue(WRONG_PASSWORD);
    await expect(loadSecretsCore(cfg(dir), prompt, makeExitThrow())).rejects.toThrow(
      'process.exit(1)',
    );
  });

  it('does NOT overwrite secrets.enc when wrong password is given', async () => {
    const prompt = makePromptQueue(WRONG_PASSWORD);
    const c = cfg(dir);
    try {
      await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    } catch {
      // expected exit
    }
    const encBlobAfter = Buffer.from(readFileSync(c.encPath));
    expect(encBlobAfter.equals(encBlobBefore)).toBe(true);
  });

  it('does NOT delete the plaintext files when wrong password is given', async () => {
    const prompt = makePromptQueue(WRONG_PASSWORD);
    const c = cfg(dir);
    try {
      await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    } catch {
      // expected exit
    }
    // Plaintext must still be present — user can retry with correct password
    expect(existsSync(c.accountsPath)).toBe(true);
    expect(existsSync(c.proxiesPath)).toBe(true);
  });

  it('secrets.enc still decrypts correctly with old password after failed attempt', async () => {
    const prompt = makePromptQueue(WRONG_PASSWORD);
    const c = cfg(dir);
    try {
      await loadSecretsCore(cfg(dir), prompt, makeExitThrow());
    } catch {
      // expected exit
    }
    // Original encrypted data must still be intact
    const bundle = await decryptToMemory(PASSWORD, c);
    expect(bundle.accounts).toBe(ACCOUNTS_CONTENT);
    expect(bundle.proxies).toBe(PROXIES_CONTENT);
  });
});
