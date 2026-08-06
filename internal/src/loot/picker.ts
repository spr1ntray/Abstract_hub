import type { BattleState } from '../combat/types.js';
import type { LootOption, BuildPlan } from './types.js';

export function decideLoot(options: LootOption[], state: BattleState, plan: BuildPlan): 1 | 2 | 3 {
  if (options.length === 0) throw new Error('decideLoot: empty options');

  const scored = options.map((opt, i) => ({
    index: (i + 1) as 1 | 2 | 3,
    score: scoreOption(opt, state, plan),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.index;
}

function scoreOption(opt: LootOption, state: BattleState, plan: BuildPlan): number {
  let base = plan.priorities[opt.boonTypeString] ?? plan.defaultScore;
  for (const rule of plan.rules) {
    if (safeEval(rule.when, { me: state.me, enemy: state.enemy })) {
      const boost = rule.boost[opt.boonTypeString];
      if (boost) base += boost;
    }
  }
  return base;
}

// Very narrow eval: only comparisons/arithmetic over me/enemy
function safeEval(expr: string, ctx: { me: unknown; enemy: unknown }): boolean {
  if (!/^[\w\d\s.()+\-*/<>=!&|?:]+$/.test(expr)) {
    throw new Error(`unsafe expr: ${expr}`);
  }
  const fn = new Function('me', 'enemy', `return (${expr});`);
  return Boolean(fn(ctx.me, ctx.enemy));
}
