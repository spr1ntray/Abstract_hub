import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import { createLogger } from '../src/logger.js';

function captureLogs(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

describe('logger redact', () => {
  it('redacts privateKey field', () => {
    const cap = captureLogs();
    const log = createLogger({ destination: cap.stream });
    log.info({ privateKey: '0x' + 'a'.repeat(64), normal: 'visible' }, 'msg');
    const out = cap.lines.join('');
    expect(out).not.toContain('aaaaaaaa');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('visible');
  });

  it('redacts session tokens', () => {
    const cap = captureLogs();
    const log = createLogger({ destination: cap.stream });
    log.info({ sessionToken: 'eyJhbGc...' }, 'login');
    expect(cap.lines.join('')).not.toContain('eyJhbGc');
  });

  it('does not log 64-hex strings even in nested error messages', () => {
    const cap = captureLogs();
    const log = createLogger({ destination: cap.stream });
    const fakeKey = '0x' + 'b'.repeat(64);
    log.error({ err: new Error(`failed with key ${fakeKey}`) }, 'oops');
    expect(cap.lines.join('')).not.toContain(fakeKey);
  });
});
