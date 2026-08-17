import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import type { Account } from '../vault/schema.js';

export interface LoadedAccount {
  account: Account;
  lineNumber: number;
}

export interface LoadError {
  file: string;
  lineNumber: number;
  message: string;
}

export class FileLoadError extends Error {
  constructor(public errors: LoadError[]) {
    super(
      'Failed to load accounts/proxies:\n' +
        errors.map((e) => `  ${e.file}:${e.lineNumber}: ${e.message}`).join('\n'),
    );
    this.name = 'FileLoadError';
  }
}

function splitLines(raw: string): { line: string; n: number }[] {
  return raw
    .split(/\r?\n/)
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line.length > 0 && !line.startsWith('#'));
}

function parsePrivateKey(input: string): `0x${string}` {
  const trimmed = input.trim();
  const withPrefix = trimmed.startsWith('0x') ? trimmed : '0x' + trimmed;
  if (!/^0x[a-fA-F0-9]{64}$/.test(withPrefix)) {
    throw new Error(
      `invalid private key (expected 0x + 64 hex chars, got ${withPrefix.length} chars)`,
    );
  }
  return withPrefix as `0x${string}`;
}

/** Strip wrapping quotes, "Bearer " prefix, leading/trailing whitespace. */
function normalizeAccountLine(input: string): string {
  let s = input.trim();
  // Drop wrapping quotes (single or double)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Drop "Bearer " prefix if user copied a full Authorization header value
  if (s.toLowerCase().startsWith('bearer ')) {
    s = s.slice(7).trim();
  }
  return s;
}

/**
 * Parse optional account-line fields.
 * Format: `<credential> [| session=<id>] [| <dungeon>]`.
 * Legacy JWT and signer fields remain readable for automatic migration.
 */
function splitAccountOptions(line: string): {
  credential: string;
  signingKey?: `0x${string}`;
  dungeon?: 1 | 3;
  sessionId?: string;
  adsPowerProfileId?: string;
} {
  const [credentialPart = '', ...optionParts] = line.split('|');
  const result: {
    credential: string;
    signingKey?: `0x${string}`;
    dungeon?: 1 | 3;
    sessionId?: string;
    adsPowerProfileId?: string;
  } = { credential: credentialPart.trim() };

  for (const rawOption of optionParts) {
    const option = rawOption.trim();
    if (!option) continue;
    const signerMatch = option.match(/^signer\s*=\s*(.+)$/i);
    if (signerMatch) {
      if (result.signingKey) throw new Error('signer key is specified more than once');
      result.signingKey = parsePrivateKey(normalizeAccountLine(signerMatch[1]!));
      continue;
    }
    const sessionMatch = option.match(/^session\s*=\s*([a-f0-9]{32,64})$/i);
    if (sessionMatch) {
      if (result.sessionId) throw new Error('Abstract session is specified more than once');
      result.sessionId = sessionMatch[1]!.toLowerCase();
      continue;
    }
    const adsPowerMatch = option.match(/^adspower\s*=\s*([a-zA-Z0-9_-]{1,128})$/i);
    if (adsPowerMatch) {
      if (result.adsPowerProfileId) {
        throw new Error('AdsPower profile is specified more than once');
      }
      result.adsPowerProfileId = adsPowerMatch[1]!;
      continue;
    }

    const normalized = option.toLowerCase();
    if (/^(1|5000|d5000|dungeon5000|dungeon-5000)$/.test(normalized)) {
      if (result.dungeon) throw new Error('dungeon suffix is specified more than once');
      result.dungeon = 1;
      continue;
    }
    if (/^(3|underhaul|u|dungetron|dungetron-underhaul)$/.test(normalized)) {
      if (result.dungeon) throw new Error('dungeon suffix is specified more than once');
      result.dungeon = 3;
      continue;
    }
    throw new Error(
      `unknown dungeon suffix or account option "${option}" — use "5000", "underhaul", "session=<id>", or "adspower=<profile_id>" after "|"`,
    );
  }
  return result;
}

function looksLikeJwt(s: string): boolean {
  return s.startsWith('eyJ') && s.split('.').length === 3;
}

function parseAbstractAddress(s: string): `0x${string}` | undefined {
  const match = s.match(/^(?:abstract|agw)\s*:\s*(0x[a-fA-F0-9]{40})$/i);
  return match?.[1]?.toLowerCase() as `0x${string}` | undefined;
}

/** Decode JWT payload (base64url middle segment) and extract `address` field. */
function extractAgwFromJwt(jwt: string): `0x${string}` {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('JWT must have 3 segments separated by dots');
  const payloadB64 = parts[1]!;
  let payload: { address?: string };
  try {
    const decoded = Buffer.from(payloadB64, 'base64url').toString('utf8');
    payload = JSON.parse(decoded) as { address?: string };
  } catch {
    throw new Error('JWT payload is not valid base64url-encoded JSON');
  }
  const addr = payload.address;
  if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    throw new Error(`JWT payload missing "address" field (or not a valid 0x address): ${addr}`);
  }
  return addr.toLowerCase() as `0x${string}`;
}

export function migrateLegacyJwtAccountsText(raw: string): {
  accountsText: string;
  migrated: number;
} {
  let migrated = 0;
  const hadTrailingNewline = /\r?\n$/.test(raw);
  const lines = raw.split(/\r?\n/).map((original) => {
    const trimmed = original.trim();
    if (!trimmed || trimmed.startsWith('#')) return original;
    const options = splitAccountOptions(trimmed);
    const credential = normalizeAccountLine(options.credential);
    if (!looksLikeJwt(credential)) return original;

    const address = extractAgwFromJwt(credential);
    const fields = [`abstract:${address}`];
    if (options.sessionId) fields.push(`session=${options.sessionId}`);
    if (options.adsPowerProfileId) fields.push(`adspower=${options.adsPowerProfileId}`);
    if (options.dungeon === 1) fields.push('5000');
    if (options.dungeon === 3) fields.push('underhaul');
    migrated++;
    return fields.join(' | ');
  });
  if (hadTrailingNewline && lines.at(-1) !== '') lines.push('');
  return { accountsText: lines.join('\n'), migrated };
}

/**
 * Parse a proxy line. Accepted formats:
 *   - `http://user:pass@host:port`
 *   - `socks5://user:pass@host:port`
 *   - `host:port:user:pass`        (treated as http://)
 *   - `host:port`                  (no auth, treated as http://)
 */
function parseProxy(input: string): Account['proxy'] {
  const trimmed = input.trim();

  // URI form: scheme://...
  const uriMatch = trimmed.match(/^(https?|socks5):\/\/(?:([^:@\s]+):([^@\s]+)@)?([^:\s]+):(\d+)$/);
  if (uriMatch) {
    const [, scheme, user, pass, host, port] = uriMatch;
    return {
      type: scheme as 'http' | 'https' | 'socks5',
      host: host!,
      port: Number(port),
      ...(user ? { username: decodeURIComponent(user) } : {}),
      ...(pass ? { password: decodeURIComponent(pass) } : {}),
    };
  }

  // Colon form: host:port[:user:pass]
  const parts = trimmed.split(':');
  if (parts.length === 2 || parts.length === 4) {
    const [host, portStr, user, pass] = parts;
    const port = Number(portStr);
    if (!host || !Number.isFinite(port) || port <= 0) {
      throw new Error(`invalid proxy "${trimmed}" — expected host:port or host:port:user:pass`);
    }
    return {
      type: 'http',
      host,
      port,
      ...(user ? { username: user } : {}),
      ...(pass ? { password: pass } : {}),
    };
  }

  throw new Error(
    `unrecognized proxy format "${trimmed}" — use http://user:pass@host:port or host:port:user:pass`,
  );
}

/** Parse account+proxy line pairs from raw text content. */
export function parseAccountsFromText(opts: {
  accountsText: string;
  proxiesText: string;
  accountsSourceLabel?: string;
  proxiesSourceLabel?: string;
}): LoadedAccount[] {
  const accountsLines = splitLines(opts.accountsText);
  const proxiesLines = splitLines(opts.proxiesText);

  const accountsLabel = opts.accountsSourceLabel ?? 'accounts';
  const proxiesLabel = opts.proxiesSourceLabel ?? 'proxies';

  const errors: LoadError[] = [];

  if (accountsLines.length === 0) {
    errors.push({
      file: accountsLabel,
      lineNumber: 0,
      message:
        'no private keys found (file missing or empty). Copy accounts.example.txt → accounts.txt and fill in your keys.',
    });
  }
  if (proxiesLines.length === 0) {
    errors.push({
      file: proxiesLabel,
      lineNumber: 0,
      message:
        'no proxies found (file missing or empty). Copy proxies.example.txt → proxies.txt and fill in your proxies.',
    });
  }
  if (accountsLines.length !== proxiesLines.length) {
    errors.push({
      file: `${accountsLabel} + ${proxiesLabel}`,
      lineNumber: 0,
      message: `account count (${accountsLines.length}) does not match proxy count (${proxiesLines.length}). Line N pairs with line N — pad with blank or # comment lines if needed.`,
    });
  }
  if (errors.length > 0) throw new FileLoadError(errors);

  const loaded: LoadedAccount[] = [];
  for (let i = 0; i < accountsLines.length; i++) {
    const acctEntry = accountsLines[i]!;
    const proxyEntry = proxiesLines[i]!;
    try {
      const proxy = parseProxy(proxyEntry.line);
      const { credential, signingKey, dungeon, sessionId, adsPowerProfileId } = splitAccountOptions(
        acctEntry.line,
      );
      const line = normalizeAccountLine(credential);
      const abstractAddress = parseAbstractAddress(line);

      if (abstractAddress) {
        if (signingKey) {
          throw new Error('Abstract browser accounts do not use an exported signer key');
        }
        const account: Account = {
          name: `acc${i + 1}-${abstractAddress.slice(2, 8)}`,
          agwAddress: abstractAddress,
          ...(sessionId ? { sessionId } : {}),
          ...(adsPowerProfileId ? { adsPowerProfileId } : {}),
          proxy,
          ...(dungeon ? { dungeon } : {}),
        };
        loaded.push({ account, lineNumber: acctEntry.n });
      } else if (looksLikeJwt(line)) {
        // Legacy token is decoded only to recover the public AGW address. It is
        // deliberately discarded; all game sessions now come from Abstract.
        const agw = extractAgwFromJwt(line);
        const account: Account = {
          name: `acc${i + 1}-${agw.slice(2, 8)}`,
          agwAddress: agw,
          ...(signingKey ? { privateKey: signingKey } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(adsPowerProfileId ? { adsPowerProfileId } : {}),
          proxy,
          ...(dungeon ? { dungeon } : {}),
        };
        loaded.push({ account, lineNumber: acctEntry.n });
      } else {
        // Private-key mode: derive EOA + sign login msg later.
        if (sessionId) throw new Error('session= is only valid for an Abstract account');
        if (adsPowerProfileId) {
          throw new Error('adspower= is only valid for an Abstract account');
        }
        const privateKey = parsePrivateKey(line);
        if (signingKey && signingKey.toLowerCase() !== privateKey.toLowerCase()) {
          throw new Error('signer key must match the primary private key');
        }
        const eoa = privateKeyToAccount(privateKey);
        const account: Account = {
          name: `acc${i + 1}-${eoa.address.slice(2, 8)}`,
          privateKey,
          proxy,
          ...(dungeon ? { dungeon } : {}),
        };
        loaded.push({ account, lineNumber: acctEntry.n });
      }
    } catch (e) {
      errors.push({
        file: accountsLabel,
        lineNumber: acctEntry.n,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (errors.length > 0) throw new FileLoadError(errors);
  return loaded;
}

/** Load accounts.txt + proxies.txt by line pairing (plaintext convenience wrapper). */
export function loadAccountsFromFiles(
  opts: {
    accountsPath?: string;
    proxiesPath?: string;
  } = {},
): LoadedAccount[] {
  const accountsPath = resolve(opts.accountsPath ?? 'accounts.txt');
  const proxiesPath = resolve(opts.proxiesPath ?? 'proxies.txt');
  return parseAccountsFromText({
    accountsText: existsSync(accountsPath) ? readFileSync(accountsPath, 'utf8') : '',
    proxiesText: existsSync(proxiesPath) ? readFileSync(proxiesPath, 'utf8') : '',
    accountsSourceLabel: accountsPath,
    proxiesSourceLabel: proxiesPath,
  });
}
