/* global module */

const {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require('node:fs');
const { Buffer } = require('node:buffer');
const { basename, join } = require('node:path');

const SENSITIVE_KEY =
  /(?:password|master.?password|secret|private.?key|authorization|cookie|signature|jwt|access.?token|refresh.?token|identity.?token|callback.?secret|proxy.?username)/i;
const PRIVATE_KEY = /0x[a-fA-F0-9]{64}/g;
const JWT = /eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){1,2}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi;
const AUTH_LINK =
  /(\/(?:api\/)?(?:game|cambria)-auth(?:\/(?:callback|challenge|tollan\/nonce))?\/[a-f0-9]{48}\/)[a-f0-9]{48}/gi;
const PROXY_CREDENTIALS = /(:\/\/)[^/@:\s]+:[^/@\s]+@/g;

function timestampName(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function scrubString(value) {
  return String(value)
    .replace(PRIVATE_KEY, '[REDACTED-PRIVATE-KEY]')
    .replace(JWT, '[REDACTED-JWT]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(AUTH_LINK, '$1[REDACTED-LINK-SECRET]')
    .replace(PROXY_CREDENTIALS, '$1[REDACTED]@');
}

function sanitize(value, key = '', seen = new WeakSet(), depth = 0) {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      ...(value.stack ? { stack: scrubString(value.stack) } : {}),
      ...(value.code !== undefined ? { code: sanitize(value.code, 'code', seen, depth + 1) } : {}),
    };
  }
  if (typeof value !== 'object') return scrubString(String(value));
  if (depth >= 8) return '[TRUNCATED-DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, 200).map((entry) => sanitize(entry, '', seen, depth + 1));
    if (value.length > 200) result.push(`[TRUNCATED ${value.length - 200} ITEMS]`);
    return result;
  }
  const result = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    result[entryKey] = sanitize(entryValue, entryKey, seen, depth + 1);
  }
  return result;
}

class DesktopDiagnostics {
  constructor({ dataDir, shell, metadata = {} }) {
    this.directory = join(dataDir, 'diagnostics');
    this.configPath = join(dataDir, 'developer-mode.json');
    this.shell = shell;
    this.metadata = sanitize(metadata);
    this.enabled = this.readEnabled();
    this.currentFile = null;
    this.recentEvents = [];
    if (this.enabled) {
      this.ensureSessionFile();
      this.record('desktop', 'application_started', this.metadata);
    }
  }

  readEnabled() {
    try {
      if (!existsSync(this.configPath)) return false;
      return JSON.parse(readFileSync(this.configPath, 'utf8')).enabled === true;
    } catch {
      return false;
    }
  }

  persistEnabled() {
    writeFileSync(this.configPath, JSON.stringify({ enabled: this.enabled }, null, 2), {
      mode: 0o600,
    });
    chmodSync(this.configPath, 0o600);
  }

  ensureSessionFile() {
    if (this.currentFile) return this.currentFile;
    mkdirSync(this.directory, { recursive: true });
    this.currentFile = join(this.directory, `diagnostics-${timestampName()}.jsonl`);
    writeFileSync(this.currentFile, '', { flag: 'a', mode: 0o600 });
    chmodSync(this.currentFile, 0o600);
    return this.currentFile;
  }

  setEnabled(enabled) {
    const next = enabled === true;
    if (next === this.enabled) return this.status();
    if (!next) this.record('developer', 'mode_disabled');
    this.enabled = next;
    this.persistEnabled();
    if (next) {
      this.ensureSessionFile();
      this.record('developer', 'mode_enabled', this.metadata);
    }
    return this.status();
  }

  record(source, event, data = {}) {
    if (!this.enabled) return;
    const entry = sanitize({
      timestamp: new Date().toISOString(),
      source: String(source || 'unknown'),
      event: String(event || 'event'),
      data,
    });
    const file = this.ensureSessionFile();
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.recentEvents.push(entry);
    if (this.recentEvents.length > 500) this.recentEvents.splice(0, this.recentEvents.length - 500);
  }

  saveImage(source, label, buffer) {
    if (!this.enabled || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    mkdirSync(this.directory, { recursive: true });
    const safeSource = String(source || 'capture')
      .replace(/[^a-z0-9_-]/gi, '-')
      .slice(0, 40);
    const safeLabel = String(label || 'state')
      .replace(/[^a-z0-9_-]/gi, '-')
      .slice(0, 60);
    const file = join(this.directory, `${safeSource}-${safeLabel}-${timestampName()}.png`);
    writeFileSync(file, buffer, { mode: 0o600 });
    chmodSync(file, 0o600);
    this.record(source, 'screenshot_saved', { file: basename(file), bytes: buffer.length });
    return file;
  }

  recent(limit = 100) {
    const normalized = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.recentEvents.slice(-normalized);
  }

  status() {
    let files;
    try {
      files = readdirSync(this.directory)
        .filter((name) => /\.(?:jsonl|png)$/.test(name))
        .sort()
        .reverse()
        .slice(0, 50);
    } catch {
      files = [];
    }
    return {
      available: true,
      enabled: this.enabled,
      directory: this.directory,
      currentFile: this.currentFile ? basename(this.currentFile) : null,
      files,
    };
  }

  async openFolder() {
    mkdirSync(this.directory, { recursive: true });
    const error = await this.shell.openPath(this.directory);
    if (error) throw new Error(error);
  }
}

module.exports = {
  DesktopDiagnostics,
  sanitizeDiagnosticValue: sanitize,
  scrubDiagnosticString: scrubString,
};
