import { describe, it, expect } from 'vitest';
import { splitRoom } from '../../src/orchestrator/presenter.js';

// Gigaverse dungeons are 4 floors × 4 rooms = 16 absolute rooms. The server
// returns ROOM_NUM_CID as a 1-16 cumulative index, and the presenter must
// always split it into "Floor X · Room Y" — there is no "Комната 5" in the
// game.

describe('splitRoom', () => {
  it('room 1 → floor 1, room 1', () => {
    expect(splitRoom(1)).toEqual({ floor: 1, room: 1 });
  });

  it('room 4 → floor 1, room 4 (last room of first floor)', () => {
    expect(splitRoom(4)).toEqual({ floor: 1, room: 4 });
  });

  it('room 5 → floor 2, room 1 (first room of second floor)', () => {
    expect(splitRoom(5)).toEqual({ floor: 2, room: 1 });
  });

  it('room 8 → floor 2, room 4', () => {
    expect(splitRoom(8)).toEqual({ floor: 2, room: 4 });
  });

  it('room 16 → floor 4, room 4 (boss room)', () => {
    expect(splitRoom(16)).toEqual({ floor: 4, room: 4 });
  });

  it('falls back to floor 1 room 1 for 0/negative/NaN/Infinity', () => {
    expect(splitRoom(0)).toEqual({ floor: 1, room: 1 });
    expect(splitRoom(-3)).toEqual({ floor: 1, room: 1 });
    expect(splitRoom(NaN)).toEqual({ floor: 1, room: 1 });
    expect(splitRoom(Infinity)).toEqual({ floor: 1, room: 1 });
  });
});
