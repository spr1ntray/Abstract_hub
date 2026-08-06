import { describe, expect, it } from 'vitest';
import { extractSkillAccountIdentity } from '../../src/ui/server.js';

describe('skill account display identity', () => {
  it('uses the Gigaverse username from the account profile', () => {
    expect(
      extractSkillAccountIdentity(
        'account-two',
        '0x2222222222222222222222222222222222222222',
        {},
        {
          primaryUsername: 'player_two',
          accountEntity: { NOOB_TOKEN_CID: 321 },
        },
      ),
    ).toEqual({
      alias: 'account-two',
      displayName: '@player_two',
      username: 'player_two',
      noobId: 321,
    });
  });

  it('falls back to login data before technical account labels', () => {
    expect(
      extractSkillAccountIdentity(
        'account-one',
        '0x1111111111111111111111111111111111111111',
        {
          username: 'player_one',
          noob: { docId: '123' },
        },
        undefined,
      ),
    ).toEqual({
      alias: 'account-one',
      displayName: '@player_one',
      username: 'player_one',
      noobId: 123,
    });
  });
});
