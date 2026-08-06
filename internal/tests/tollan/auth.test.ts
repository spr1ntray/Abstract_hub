import { describe, expect, it } from 'vitest';
import {
  parseTollanActionResponse,
  storedTollanSessionForAddress,
  upsertStoredTollanSession,
  type StoredTollanSession,
} from '../../src/tollan/auth.js';

const agwAddress = `0x${'a'.repeat(40)}`;
const signerAddress = `0x${'b'.repeat(40)}`;

function session(): StoredTollanSession {
  return {
    agwAddress,
    signerAddress,
    capturedAt: 1_785_607_841_435,
    cookies: [],
    state: {
      payload: { sub: 'user-1', address: agwAddress, signer: signerAddress },
      account: { accountName: 'main-account', defaultAccount: false },
    },
  };
}

describe('Tollan browser authentication', () => {
  it('parses a resolved Next.js server action value', () => {
    const text =
      '0:["$@1",["build-id",null]]\n' +
      `1:{"payload":{"sub":"user-1","address":"${agwAddress}","signer":"${signerAddress}"},"account":{"accountName":"main-account","defaultAccount":false}}\n`;
    expect(parseTollanActionResponse(text)).toMatchObject({
      payload: { address: agwAddress, signer: signerAddress },
      account: { accountName: 'main-account' },
    });
  });

  it('follows the action reference when page frames arrive before the root frame', () => {
    const text =
      '4:I[41241,["23663","static/chunks/provider.js"],"Provider"]\n' +
      '5:I[5613,[],""]\n' +
      '0:["$@1",["build-id",[["",{"children":["__PAGE__",{}]}]]]]\n' +
      `1:{"payload":{"sub":"user-1","address":"${agwAddress}","signer":"${signerAddress}"},"account":{"accountName":"main-account","defaultAccount":false}}\n` +
      '3:["$","main",null,{"children":"page revalidation"}]\n';

    expect(parseTollanActionResponse(text)).toMatchObject({
      payload: { address: agwAddress, signer: signerAddress },
      account: { accountName: 'main-account' },
    });
  });

  it('rejects a server-action error frame', () => {
    expect(() =>
      parseTollanActionResponse('0:["$@1",["build-id",null]]\n1:E{"message":"Denied"}\n'),
    ).toThrow('Denied');
  });

  it('stores sessions by normalized AGW address and validates both addresses', () => {
    const stored = upsertStoredTollanSession(undefined, session());
    expect(storedTollanSessionForAddress(stored, `0x${'A'.repeat(40)}`)).toMatchObject({
      agwAddress,
      signerAddress,
    });
    stored[agwAddress]!.state.payload.signer = `0x${'c'.repeat(40)}`;
    expect(storedTollanSessionForAddress(stored, agwAddress)).toBeUndefined();
  });
});
