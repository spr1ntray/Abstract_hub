import { describe, expect, it } from 'vitest';
import { extractNoobTokenId } from '../../src/orchestrator/main.js';

describe('extractNoobTokenId', () => {
  it('reads noob id from auth gameAccount shape', () => {
    expect(extractNoobTokenId({ noob: { _id: '74599' } })).toBe(74599);
  });

  it('prefers numeric docId when auth also contains a Mongo object id', () => {
    expect(
      extractNoobTokenId({
        noob: { _id: '6877ed63b621a2ed0409ecbf', docId: '74599' },
      }),
    ).toBe(74599);
  });

  it('reads noob id from account profile entity shape', () => {
    expect(
      extractNoobTokenId({
        accountEntity: { NOOB_TOKEN_CID: 74599 },
        noob: { docId: '74599' },
      }),
    ).toBe(74599);
  });

  it('falls through non-token object ids and uses accountEntity token id', () => {
    expect(
      extractNoobTokenId({
        noob: { _id: '6877ed63f172f211b16bf792' },
        accountEntity: { NOOB_TOKEN_CID: 75769 },
      }),
    ).toBe(75769);
  });
});
