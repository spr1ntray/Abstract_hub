export type Move = 'rock' | 'paper' | 'scissor';

export interface StatBlock {
  startingATK: number;
  startingDEF: number;
  currentATK: number;
  currentDEF: number;
  currentCharges: number;
  maxCharges: number;
}

export interface Resource {
  current: number;
  starting: number;
  currentMax?: number;
  startingMax?: number;
}

export interface PlayerState {
  /** Monster name (e.g. "Enemy Room 1") or 42-char 0x address when facing a PvP player. */
  id?: string;
  rock: StatBlock;
  paper: StatBlock;
  scissor: StatBlock;
  health: Resource;
  shield: Resource;
  lastMove: '' | Move;
  thisPlayerWin: boolean;
  otherPlayerWin: boolean;
  statusEffects: unknown[];
  activeEffects: unknown[];
}

export interface BattleState {
  me: PlayerState;
  enemy: PlayerState;
  room: number;
  dungeonId: 1 | 3;
}
