import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { BuildPlan } from './types.js';

const Schema = z.object({
  priorities: z.record(z.string(), z.number()),
  defaultScore: z.number(),
  rules: z
    .array(
      z.object({
        when: z.string(),
        boost: z.record(z.string(), z.number()),
      }),
    )
    .default([]),
});

export function loadBuildPlan(path: string): BuildPlan {
  const raw = readFileSync(path, 'utf8');
  const parsed = parse(raw);
  return Schema.parse(parsed);
}
