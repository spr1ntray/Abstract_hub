import { describe, expect, it } from 'vitest';
import {
  AccountWorkConflictError,
  AccountWorkCoordinator,
} from '../../src/orchestrator/account-work-coordinator.js';

const address = `0x${'1'.repeat(40)}`;

describe('AccountWorkCoordinator', () => {
  it('allows Gigaverse and Tollan to run for the same account', () => {
    const coordinator = new AccountWorkCoordinator();
    const tollan = coordinator.acquire({
      module: 'tollan',
      label: 'Practice',
      accountAlias: 'acc1',
      displayName: '@pilot',
      address,
      profileId: 'profile-1',
    });

    const gigaverse = coordinator.acquire({
      module: 'gigaverse',
      label: 'Dungeon',
      accountAlias: 'acc1',
      displayName: '@pilot',
      address,
      profileId: 'profile-1',
    });
    expect(coordinator.snapshot()).toHaveLength(2);
    expect(coordinator.tasksForAccount('acc1', address).map((task) => task.module)).toEqual([
      'tollan',
      'gigaverse',
    ]);

    tollan.release();
    gigaverse.release();
    expect(coordinator.snapshot()).toEqual([]);
  });

  it('prevents two Tollan browser jobs for the same account', () => {
    const coordinator = new AccountWorkCoordinator();
    coordinator.acquire({
      module: 'tollan',
      label: 'Practice',
      accountAlias: 'acc1',
      displayName: '@pilot',
      address,
      profileId: 'profile-1',
    });

    expect(() =>
      coordinator.acquire({
        module: 'tollan',
        label: 'Second Practice',
        accountAlias: 'acc1',
        displayName: '@pilot',
        address,
        profileId: 'profile-1',
      }),
    ).toThrow(AccountWorkConflictError);
  });

  it('locks a shared AdsPower profile even when aliases differ', () => {
    const coordinator = new AccountWorkCoordinator();
    coordinator.acquire({
      module: 'tollan',
      label: 'Practice',
      accountAlias: 'acc1',
      displayName: '@one',
      address,
      profileId: 'shared-profile',
    });

    expect(() =>
      coordinator.acquire({
        module: 'tollan',
        label: 'Practice',
        accountAlias: 'acc2',
        displayName: '@two',
        address: `0x${'2'.repeat(40)}`,
        profileId: 'shared-profile',
      }),
    ).toThrow(/уже занят в Tollan/);
  });

  it('rolls back a batch when one account is busy', () => {
    const coordinator = new AccountWorkCoordinator();
    coordinator.acquire({
      module: 'tollan',
      label: 'Practice',
      accountAlias: 'acc2',
      displayName: '@two',
      address: `0x${'2'.repeat(40)}`,
      profileId: 'profile-2',
    });

    expect(() =>
      coordinator.acquireMany([
        {
          module: 'tollan',
          label: 'Practice',
          accountAlias: 'acc1',
          displayName: '@one',
          address,
        },
        {
          module: 'tollan',
          label: 'Practice',
          accountAlias: 'acc2',
          displayName: '@two',
          address: `0x${'2'.repeat(40)}`,
          profileId: 'profile-2',
        },
      ]),
    ).toThrow(AccountWorkConflictError);
    expect(coordinator.snapshot().map((task) => task.accountAlias)).toEqual(['acc2']);
  });
});
