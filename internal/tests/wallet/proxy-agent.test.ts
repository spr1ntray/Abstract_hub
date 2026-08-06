import { describe, it, expect } from 'vitest';
import { isIpHost, makeProxyAgent } from '../../src/wallet/proxy-agent.js';
import type { Account } from '../../src/vault/schema.js';

describe('isIpHost', () => {
  it('detects IPv4', () => {
    expect(isIpHost('1.2.3.4')).toBe(true);
    expect(isIpHost('84.55.4.79')).toBe(true);
    expect(isIpHost('255.255.255.255')).toBe(true);
  });

  it('detects IPv6 (any colon literal)', () => {
    expect(isIpHost('::1')).toBe(true);
    expect(isIpHost('2001:db8::1')).toBe(true);
  });

  it('rejects FQDNs', () => {
    expect(isIpHost('proxy.example.com')).toBe(false);
    expect(isIpHost('gigaverse.io')).toBe(false);
    expect(isIpHost('localhost')).toBe(false);
  });

  it('rejects strings that look numeric but are not IPv4', () => {
    expect(isIpHost('1.2.3')).toBe(false);
    expect(isIpHost('not.an.ip.address')).toBe(false);
  });
});

describe('makeProxyAgent', () => {
  function mkProxy(over: Partial<Account['proxy']> = {}): Account['proxy'] {
    return { type: 'http', host: 'proxy.example.com', port: 8080, ...over };
  }

  it('returns a ProxyAgent instance for FQDN host', () => {
    const agent = makeProxyAgent(mkProxy({ host: 'proxy.example.com' }));
    expect(agent).toBeDefined();
    expect(typeof agent.dispatch).toBe('function');
  });

  it('returns a ProxyAgent instance for IPv4 host', () => {
    const agent = makeProxyAgent(mkProxy({ host: '84.55.4.79' }));
    expect(agent).toBeDefined();
    expect(typeof agent.dispatch).toBe('function');
  });

  it('returns a ProxyAgent instance for HTTPS scheme with IP', () => {
    const agent = makeProxyAgent(mkProxy({ type: 'https', host: '1.2.3.4', port: 443 }));
    expect(agent).toBeDefined();
    expect(typeof agent.dispatch).toBe('function');
  });
});
