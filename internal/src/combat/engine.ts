import type { BattleState, Move } from './types.js';

/**
 * Pick a move for the player.
 *
 * Base strategy: strict rock↔scissor alternation, paper only as fallback when
 * both charges are gone. That was the original deterministic logic.
 *
 * Anti-sybil overlay: with a small probability (~12%) we swap to the OTHER
 * non-paper move when both have charges, and occasionally fire paper even
 * when not forced. This breaks the perfect-alternation pattern that would
 * trivially cluster two accounts playing the same room with identical state.
 *
 * Test-mode (NODE_ENV=test or VITEST=true) keeps deterministic behavior so
 * existing combat tests stay reproducible.
 */
export function decideMove(state: BattleState): Move {
  const deterministic = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  const last = state.me.lastMove;
  const preferred: Move = last === 'rock' ? 'scissor' : 'rock';
  const fallback: Move = preferred === 'rock' ? 'scissor' : 'rock';

  const prefAvail = state.me[preferred].currentCharges > 0;
  const fallAvail = state.me[fallback].currentCharges > 0;

  if (!deterministic && prefAvail && fallAvail && Math.random() < 0.12) {
    return fallback;
  }
  // ~2% chance to throw paper even when stronger moves are available — humans
  // do this surprisingly often, bots almost never.
  if (!deterministic && (prefAvail || fallAvail) && Math.random() < 0.02) {
    return 'paper';
  }

  if (prefAvail) return preferred;
  if (fallAvail) return fallback;
  return 'paper';
}
