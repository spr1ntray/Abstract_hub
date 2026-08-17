export type TollanMissionCategory = 'DAILY' | 'WEEKLY';

export interface TollanMission {
  id: string;
  type: string;
  category: TollanMissionCategory;
  description: string;
  goal: number;
  progress: number;
  claimed: boolean;
  propString1?: string;
}

export interface TollanQuestCategorySnapshot {
  total: number;
  completed: number;
  claimed: number;
  claimable: number;
  remaining: number;
}

export interface TollanQuestSnapshot {
  daily: TollanQuestCategorySnapshot;
  weekly: TollanQuestCategorySnapshot;
  target?: string;
  targetType?: string;
  targetProgress?: number;
  targetGoal?: number;
  checkedAt: number;
}

export interface TollanQuestPlan {
  mission?: TollanMission;
  practiceNeeded: boolean;
  subclass?: string;
  useSkillReroll: boolean;
  useAffinityReroll: boolean;
}

const PRACTICE_QUEST_PRIORITY: Readonly<Record<string, number>> = {
  UseSkillRerollInAnyRun: 10,
  UseAffinityRerollInAnyRun: 20,
  PlaySubClassXTimes: 30,
  PlaySubClassXTimesInAnyRun: 30,
  KillXFrodoInAnyRun: 40,
  KillXEnemiesInAnyRun: 50,
  OpenXChests: 60,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseMission(value: unknown): TollanMission | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const category = String(record['category'] ?? '').toUpperCase();
  const goal = finiteNonNegative(record['goal']);
  const progress = finiteNonNegative(record['progress']);
  const id = String(record['id'] ?? '').trim();
  const type = String(record['type'] ?? '').trim();
  if (!id || !type || goal === undefined || progress === undefined) return undefined;
  if (category !== 'DAILY' && category !== 'WEEKLY') return undefined;
  const propString1 = String(record['propString1'] ?? '').trim();
  return {
    id,
    type,
    category,
    description: String(record['description'] ?? type).trim() || type,
    goal,
    progress,
    claimed: record['claimed'] === true,
    ...(propString1 ? { propString1 } : {}),
  };
}

function findMissionArray(value: unknown, depth = 0): TollanMission[] | undefined {
  if (depth > 6) return undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  if (Array.isArray(record['missions'])) {
    const missions = record['missions'].flatMap((entry) => {
      const parsed = parseMission(entry);
      return parsed ? [parsed] : [];
    });
    if (missions.length > 0) return missions;
  }
  for (const nested of Object.values(record)) {
    const missions = findMissionArray(nested, depth + 1);
    if (missions) return missions;
  }
  return undefined;
}

/** Extract the mission board from a Next.js React Flight/server-action response. */
export function extractTollanMissionsFromFlight(text: string): TollanMission[] | undefined {
  const candidates = [text.trim()];
  const embeddedFlight = /self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g;
  for (const match of text.matchAll(embeddedFlight)) {
    try {
      const decoded = JSON.parse(match[1] ?? '""') as unknown;
      if (typeof decoded === 'string') candidates.push(decoded);
    } catch {
      // Ignore unrelated or truncated Next.js bootstrap entries.
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator >= 0) candidates.push(line.slice(separator + 1).trim());
  }
  for (const payload of [...candidates]) {
    if (payload === text.trim()) continue;
    for (const line of payload.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator >= 0) candidates.push(line.slice(separator + 1).trim());
    }
  }
  for (const candidate of candidates) {
    if (!candidate || !['{', '['].includes(candidate[0] ?? '')) continue;
    try {
      const missions = findMissionArray(JSON.parse(candidate) as unknown);
      if (missions) return missions;
    } catch {
      // Flight responses include references and control rows that are not JSON.
    }
  }
  return undefined;
}

function categorySnapshot(
  missions: readonly TollanMission[],
  category: TollanMissionCategory,
): TollanQuestCategorySnapshot {
  const selected = missions.filter((mission) => mission.category === category);
  const completed = selected.filter((mission) => mission.progress >= mission.goal).length;
  const claimed = selected.filter((mission) => mission.claimed).length;
  const claimable = selected.filter(
    (mission) => !mission.claimed && mission.progress >= mission.goal,
  ).length;
  return {
    total: selected.length,
    completed,
    claimed,
    claimable,
    remaining: selected.filter((mission) => mission.progress < mission.goal).length,
  };
}

export function summarizeTollanQuests(
  missions: readonly TollanMission[],
  target?: TollanMission,
): TollanQuestSnapshot {
  return {
    daily: categorySnapshot(missions, 'DAILY'),
    weekly: categorySnapshot(missions, 'WEEKLY'),
    ...(target
      ? {
          target: target.description,
          targetType: target.type,
          targetProgress: target.progress,
          targetGoal: target.goal,
        }
      : {}),
    checkedAt: Date.now(),
  };
}

function normalizedPracticeType(type: string): string | undefined {
  if (type.startsWith('PlaySubClassXTimes')) return 'PlaySubClassXTimes';
  return PRACTICE_QUEST_PRIORITY[type] !== undefined ? type : undefined;
}

export function planTollanQuest(missions: readonly TollanMission[]): TollanQuestPlan {
  const candidates = missions
    .filter((mission) => !mission.claimed && mission.progress < mission.goal)
    .flatMap((mission) => {
      const normalized = normalizedPracticeType(mission.type);
      return normalized ? [{ mission, normalized }] : [];
    })
    .sort((left, right) => {
      const category =
        left.mission.category === right.mission.category
          ? 0
          : left.mission.category === 'DAILY'
            ? -1
            : 1;
      if (category !== 0) return category;
      return (
        (PRACTICE_QUEST_PRIORITY[left.normalized] ?? 1_000) -
        (PRACTICE_QUEST_PRIORITY[right.normalized] ?? 1_000)
      );
    });
  const selected = candidates[0];
  if (!selected) {
    return {
      practiceNeeded: false,
      useSkillReroll: false,
      useAffinityReroll: false,
    };
  }
  return {
    mission: selected.mission,
    practiceNeeded: true,
    ...(selected.normalized === 'PlaySubClassXTimes' && selected.mission.propString1
      ? { subclass: selected.mission.propString1 }
      : {}),
    useSkillReroll: selected.normalized === 'UseSkillRerollInAnyRun',
    useAffinityReroll: selected.normalized === 'UseAffinityRerollInAnyRun',
  };
}

export function tollanQuestProgressFingerprint(missions: readonly TollanMission[]): string {
  return missions
    .map((mission) => `${mission.id}:${mission.progress}:${mission.claimed ? 1 : 0}`)
    .sort()
    .join('|');
}

export function tollanMissionProgressed(
  before: TollanMission,
  missions: readonly TollanMission[],
): boolean {
  const after = missions.find((mission) => mission.id === before.id);
  return Boolean(after && (after.progress > before.progress || (!before.claimed && after.claimed)));
}
