export interface LootOption {
  docId: string;
  RARITY_CID: number;
  UINT256_CID: number;
  selectedVal1: number;
  selectedVal2: number;
  boonTypeString: string;
}

export interface BuildPlan {
  priorities: Record<string, number>;
  defaultScore: number;
  rules: BuildRule[];
}

export interface BuildRule {
  when: string; // выражение, eval-friendly
  boost: Record<string, number>;
}
