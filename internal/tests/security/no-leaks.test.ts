import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../../src/logger.js';

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

describe('security: no secrets in logs', () => {
  it('does not leak 64-hex private keys (positional or nested)', () => {
    const cap = captureLogs();
    const log = createLogger({ destination: cap.stream });
    const key = '0x' + 'c'.repeat(64);
    log.info({ data: key, nested: { privateKey: key }, message: key }, key);
    const out = cap.lines.join('');
    expect(out).not.toContain('cccccccccccccccc');
  });

  it('does not leak JWT-shaped tokens', () => {
    const cap = captureLogs();
    const log = createLogger({ destination: cap.stream });
    const jwt = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.test.test';
    log.info({ sessionToken: jwt, free: `received token ${jwt}` }, 'login');
    const out = cap.lines.join('');
    expect(out).not.toContain('eyJhbGc');
  });

  it('does not leak hex in stack traces or error messages', () => {
    const cap = captureLogs();
    const log = createLogger({ destination: cap.stream });
    const key = '0x' + 'd'.repeat(64);
    log.error({ err: new Error(`boom ${key}`) }, 'oops');
    const out = cap.lines.join('');
    expect(out).not.toContain('dddddd');
  });

  it('does not leak proxy passwords', () => {
    const cap = captureLogs();
    const log = createLogger({ destination: cap.stream });
    log.info(
      { proxy: { host: 'p.com', port: 8080, username: 'u', password: 'SECRET-PROXY-PW' } },
      'proxy',
    );
    const out = cap.lines.join('');
    expect(out).not.toContain('SECRET-PROXY-PW');
  });

  it('does not leak signatures', () => {
    const cap = captureLogs();
    const log = createLogger({ destination: cap.stream });
    log.info({ signature: '0xdeadbeef' + '0'.repeat(120), msg: 'signed' }, 'sign');
    const out = cap.lines.join('');
    // Signature path is redacted by name
    expect(out).toContain('REDACTED');
  });
});
