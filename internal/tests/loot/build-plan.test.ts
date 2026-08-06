import { describe, it, expect } from 'vitest';
import { loadBuildPlan } from '../../src/loot/build-plan.js';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('loadBuildPlan', () => {
  it('parses yaml with priorities and rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-'));
    const p = join(dir, 'b.yaml');
    writeFileSync(
      p,
      `
priorities:
  UpgradeRock_ATK: 100
defaultScore: 5
rules: []
`,
    );
    const plan = loadBuildPlan(p);
    expect(plan.priorities['UpgradeRock_ATK']).toBe(100);
    expect(plan.defaultScore).toBe(5);
    expect(plan.rules).toEqual([]);
  });

  it('throws on missing required fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-'));
    const p = join(dir, 'b.yaml');
    writeFileSync(p, `priorities: {}`);
    expect(() => loadBuildPlan(p)).toThrow();
  });
});
