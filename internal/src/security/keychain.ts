/**
 * Optional macOS Keychain (and Linux libsecret) integration via keytar.
 *
 * Enabled when GIGABOT_REMEMBER=true.  Default: disabled (prompt every time).
 *
 * Edge cases handled:
 *   - keytar not installed or native binding unavailable (Linux without libsecret):
 *     silently fall back to password prompt.
 *   - Saved password no longer valid (vault re-keyed): caller treats it as a
 *     keychain miss and falls back to prompt; clears the stale entry on failure.
 *
 * Usage:
 *   const pw = await keychainLoad();       // undefined → prompt
 *   await keychainSave(password);          // after successful unlock
 *   await keychainClear();                 // pnpm forget
 */

const SERVICE = 'abstract-hub';
const LEGACY_SERVICE = 'gigaverse-bot';
const ACCOUNT = 'master';

/** True when the GIGABOT_REMEMBER flag is set. */
export function rememberEnabled(): boolean {
  return process.env['GIGABOT_REMEMBER'] === 'true';
}

/**
 * Attempt to load keytar dynamically.
 * Returns null on any import failure (native binding not built, libsecret absent, etc.).
 */
async function loadKeytar(): Promise<typeof import('keytar') | null> {
  try {
    return await import('keytar');
  } catch {
    return null;
  }
}

/**
 * Load the master password from the OS keychain.
 *
 * Returns undefined if:
 *   - GIGABOT_REMEMBER is not set
 *   - keytar is unavailable
 *   - no password is stored
 */
export async function keychainLoad(): Promise<string | undefined> {
  if (!rememberEnabled()) return undefined;

  const kt = await loadKeytar();
  if (kt === null) return undefined;

  try {
    const stored = await kt.getPassword(SERVICE, ACCOUNT);
    if (stored !== null) return stored;
    const legacy = await kt.getPassword(LEGACY_SERVICE, ACCOUNT);
    if (legacy !== null) {
      await kt.setPassword(SERVICE, ACCOUNT, legacy);
      return legacy;
    }
    return undefined;
  } catch {
    // Keychain access error — fall back gracefully.
    return undefined;
  }
}

/**
 * Save the master password to the OS keychain.
 * No-op when GIGABOT_REMEMBER is not set or keytar is unavailable.
 */
export async function keychainSave(password: string): Promise<void> {
  if (!rememberEnabled()) return;

  const kt = await loadKeytar();
  if (kt === null) return;

  try {
    await kt.setPassword(SERVICE, ACCOUNT, password);
  } catch {
    // best-effort — never crash the bot over keychain write failure
  }
}

/**
 * Remove the master password from the OS keychain.
 * Called by `pnpm forget`.
 *
 * @returns true if an entry was deleted, false if nothing was stored or keytar unavailable.
 */
export async function keychainClear(): Promise<boolean> {
  const kt = await loadKeytar();
  if (kt === null) return false;

  try {
    const [current, legacy] = await Promise.all([
      kt.deletePassword(SERVICE, ACCOUNT),
      kt.deletePassword(LEGACY_SERVICE, ACCOUNT),
    ]);
    return current || legacy;
  } catch {
    return false;
  }
}
