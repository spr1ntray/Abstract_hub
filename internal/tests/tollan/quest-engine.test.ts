import { describe, expect, it } from 'vitest';
import {
  extractTollanMissionsFromFlight,
  planTollanQuest,
  summarizeTollanQuests,
  tollanMissionProgressed,
  tollanQuestProgressFingerprint,
  type TollanMission,
} from '../../src/tollan/quest-engine.js';

const missions: TollanMission[] = [
  {
    id: 'weekly-kills',
    type: 'KillXEnemiesInAnyRun',
    category: 'WEEKLY',
    description: 'Kill 100 enemies',
    goal: 100,
    progress: 20,
    claimed: false,
  },
  {
    id: 'daily-acolyte',
    type: 'PlaySubClassXTimes',
    category: 'DAILY',
    description: 'Play Acolyte twice',
    goal: 2,
    progress: 0,
    claimed: false,
    propString1: 'Acolyte Of Chaos',
  },
  {
    id: 'daily-ready',
    type: 'LogIn',
    category: 'DAILY',
    description: 'Log in',
    goal: 1,
    progress: 1,
    claimed: false,
  },
];

describe('Tollan quest engine', () => {
  it('extracts a mission board from a React Flight response', () => {
    const flight = `0:["$@1"]\n1:${JSON.stringify({ data: { missions } })}`;
    expect(extractTollanMissionsFromFlight(flight)).toEqual(missions);
  });

  it('extracts missions from an embedded Next.js bootstrap payload', () => {
    const flight = `0:["$@1"]\n1:${JSON.stringify({ data: { missions } })}`;
    const html = `<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script>`;
    expect(extractTollanMissionsFromFlight(html)).toEqual(missions);
  });

  it('prioritizes an unfinished daily quest and carries its subclass into the run', () => {
    expect(planTollanQuest(missions)).toMatchObject({
      practiceNeeded: true,
      subclass: 'Acolyte Of Chaos',
      mission: { id: 'daily-acolyte' },
    });
  });

  it('summarizes claimable work and fingerprints server progress', () => {
    expect(summarizeTollanQuests(missions)).toMatchObject({
      daily: { total: 2, completed: 1, claimable: 1, remaining: 1 },
      weekly: { total: 1, completed: 0, claimable: 0, remaining: 1 },
    });
    expect(tollanQuestProgressFingerprint(missions)).toContain('daily-ready:1:0');
    expect(
      tollanMissionProgressed(missions[1]!, [
        missions[0]!,
        { ...missions[1]!, progress: 1 },
        missions[2]!,
      ]),
    ).toBe(true);
    expect(tollanMissionProgressed(missions[1]!, missions)).toBe(false);
  });
});
