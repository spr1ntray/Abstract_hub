import { ProxyAgent } from 'undici';
import type { Account } from '../vault/schema.js';
import { buildProxyUri } from './abstract-chain.js';

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** True if host looks like an IPv4 or IPv6 literal. */
export function isIpHost(host: string): boolean {
  return IPV4_RE.test(host) || host.includes(':');
}

/**
 * Build a ProxyAgent that tolerates proxies whose host is an IP literal.
 *
 * Per RFC 6066, TLS SNI must be a hostname, not an IP address. When the
 * proxy host is an IP, Node's tls.connect() throws ERR_INVALID_ARG_VALUE
 * if `servername` is set to that IP.
 *
 * undici (v8.3.0) sets servername to `proxyTls.servername || proxyHostname`,
 * so passing an empty string is FALSY and falls back to the IP. We need a
 * non-empty legal placeholder. Combined with `rejectUnauthorized: false`
 * (cert won't match anyway since there's no hostname for it), TLS to the
 * proxy succeeds and the CONNECT tunnel proceeds normally — destination TLS
 * (to gigaverse.io) is unaffected and uses proper SNI/cert validation.
 *
 * Security note: residential proxies see all your traffic anyway. The
 * MITM threat model here is "the proxy provider is trusted". Skipping
 * the proxy's own cert validation does not affect end-to-end TLS to
 * gigaverse.io, which still validates normally.
 */
export function makeProxyAgent(proxy: Account['proxy']): ProxyAgent {
  const uri = buildProxyUri(proxy);
  if (isIpHost(proxy.host) && proxy.type === 'https') {
    return new ProxyAgent({
      uri,
      proxyTls: {
        servername: 'proxy.local',
        rejectUnauthorized: false,
      },
    });
  }
  return new ProxyAgent({ uri });
}
