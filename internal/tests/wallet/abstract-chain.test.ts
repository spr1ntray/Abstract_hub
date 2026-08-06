import { describe, it, expect } from 'vitest';
import { buildProxyUri } from '../../src/wallet/abstract-chain.js';

describe('buildProxyUri', () => {
  it('builds http proxy with auth', () => {
    expect(
      buildProxyUri({
        type: 'http',
        host: 'p.com',
        port: 8080,
        username: 'u',
        password: 'pw',
      }),
    ).toBe('http://u:pw@p.com:8080');
  });

  it('builds proxy without auth', () => {
    expect(buildProxyUri({ type: 'http', host: 'p.com', port: 8080 })).toBe('http://p.com:8080');
  });

  it('url-encodes special chars in auth', () => {
    expect(
      buildProxyUri({
        type: 'http',
        host: 'p.com',
        port: 8080,
        username: 'u@x',
        password: 'p:w',
      }),
    ).toBe('http://u%40x:p%3Aw@p.com:8080');
  });
});
