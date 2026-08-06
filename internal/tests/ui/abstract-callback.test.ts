import { describe, expect, it } from 'vitest';
import {
  AbstractCallbackError,
  bridgeAbstractApprovalUrl,
  buildAbstractCallbackTarget,
} from '../../src/ui/abstract-callback.js';

const OPERATION_ID = 'a'.repeat(48);
const CALLBACK_SECRET = 'b'.repeat(48);
const STATE = 'c'.repeat(32);

function approvalUrl(callbackUrl: string): string {
  const url = new URL('https://cli.abs.xyz/session/new');
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('chain_id', '2741');
  url.searchParams.set('action', 'init');
  return url.toString();
}

describe('Abstract callback bridge', () => {
  it('keeps the CLI callback private and exposes the persistent app callback', () => {
    const original = `http://127.0.0.1:54321/callback/once?state=${STATE}`;
    const bridged = bridgeAbstractApprovalUrl({
      approvalUrl: approvalUrl(original),
      appBaseUrl: 'http://127.0.0.1:3737',
      operationId: OPERATION_ID,
      callbackSecret: CALLBACK_SECRET,
      allowedApprovalOrigins: new Set(['https://cli.abs.xyz']),
    });

    const publicUrl = new URL(bridged.approvalUrl);
    const callback = new URL(publicUrl.searchParams.get('callback_url')!);
    expect(bridged.callbackTarget).toBe(original);
    expect(callback.origin).toBe('http://127.0.0.1:3737');
    expect(callback.pathname).toBe(`/api/abstract/callback/${OPERATION_ID}/${CALLBACK_SECRET}`);
    expect(callback.searchParams.get('state')).toBe(STATE);
  });

  it('forwards only a matching state and the signed session payload', () => {
    const target = buildAbstractCallbackTarget(
      `http://127.0.0.1:54321/callback/once?state=${STATE}`,
      `http://127.0.0.1:3737/api/abstract/callback/x/y?state=${STATE}&session=signed-token`,
    );

    expect(target.toString()).toBe(
      `http://127.0.0.1:54321/callback/once?state=${STATE}&session=signed-token`,
    );
  });

  it('rejects remote callback targets and mismatched state', () => {
    expect(() =>
      bridgeAbstractApprovalUrl({
        approvalUrl: approvalUrl(`https://example.com/callback/once?state=${STATE}`),
        appBaseUrl: 'http://127.0.0.1:3737',
        operationId: OPERATION_ID,
        callbackSecret: CALLBACK_SECRET,
        allowedApprovalOrigins: new Set(['https://cli.abs.xyz']),
      }),
    ).toThrow(AbstractCallbackError);

    expect(() =>
      buildAbstractCallbackTarget(
        `http://127.0.0.1:54321/callback/once?state=${STATE}`,
        'http://127.0.0.1:3737/api/abstract/callback/x/y?state=wrong&session=signed-token',
      ),
    ).toThrow('некорректным state');
  });
});
