import { describe, it, expect } from 'vitest';
import { decideMove } from '../../src/combat/engine.js';
import type { BattleState, PlayerState } from '../../src/combat/types.js';
import fc from 'fast-check';

function mkPlayer(p: Partial<PlayerState> = {}): PlayerState {
  return {
    rock: {
      startingATK: 10,
      startingDEF: 5,
      currentATK: 10,
      currentDEF: 5,
      currentCharges: 3,
      maxCharges: 3,
    },
    paper: {
      startingATK: 0,
      startingDEF: 0,
      currentATK: 0,
      currentDEF: 0,
      currentCharges: 3,
      maxCharges: 3,
    },
    scissor: {
      startingATK: 10,
      startingDEF: 5,
      currentATK: 10,
      currentDEF: 5,
      currentCharges: 3,
      maxCharges: 3,
    },
    health: { current: 20, starting: 20, currentMax: 20, startingMax: 20 },
    shield: { current: 0, starting: 0, currentMax: 0, startingMax: 0 },
    lastMove: '',
    thisPlayerWin: false,
    otherPlayerWin: false,
    statusEffects: [],
    activeEffects: [],
    ...p,
  };
}

function mkState(me: Partial<PlayerState>, enemy: Partial<PlayerState> = {}): BattleState {
  return { me: mkPlayer(me), enemy: mkPlayer(enemy), room: 1, dungeonId: 1 };
}

describe('decideMove', () => {
  it('first move is rock when lastMove is empty', () => {
    expect(decideMove(mkState({ lastMove: '' }))).toBe('rock');
  });

  it('alternates rock → scissor', () => {
    expect(decideMove(mkState({ lastMove: 'rock' }))).toBe('scissor');
  });

  it('alternates scissor → rock', () => {
    expect(decideMove(mkState({ lastMove: 'scissor' }))).toBe('rock');
  });

  it('falls back to the other type if preferred is 0 charges', () => {
    const state = mkState({
      lastMove: 'scissor', // хотим rock
      rock: { ...mkPlayer().rock, currentCharges: 0 },
    });
    expect(decideMove(state)).toBe('scissor');
  });

  it('uses paper only when both rock and scissor are dry', () => {
    const state = mkState({
      lastMove: 'rock',
      rock: { ...mkPlayer().rock, currentCharges: 0 },
      scissor: { ...mkPlayer().scissor, currentCharges: 0 },
    });
    expect(decideMove(state)).toBe('paper');
  });

  it('never returns a move with 0 charges if alternatives exist', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 1, max: 3 }), // paper всегда >= 1
        (r, s, p) => {
          if (r === 0 && s === 0) return;
          const move = decideMove(
            mkState({
              lastMove: '',
              rock: { ...mkPlayer().rock, currentCharges: r },
              scissor: { ...mkPlayer().scissor, currentCharges: s },
              paper: { ...mkPlayer().paper, currentCharges: p },
            }),
          );
          if (move === 'rock') expect(r).toBeGreaterThan(0);
          if (move === 'scissor') expect(s).toBeGreaterThan(0);
        },
      ),
    );
  });
});
