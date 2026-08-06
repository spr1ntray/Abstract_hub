import Table from 'cli-table3';
import chalk from 'chalk';

export interface RunStats {
  runs: number;
  deaths: number;
  fled: number;
  rooms: number;
  picks: string[];
  considered: number;
  listed: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

export function formatSummary(stats: RunStats): string {
  const successRuns = stats.runs - stats.deaths;
  const table = new Table({
    head: [chalk.bold('Metric'), chalk.bold('Value')],
    colWidths: [22, 50],
    wordWrap: true,
  });

  const top3Picks = topN(stats.picks, 3).join(', ') || '(none)';

  const fledSegment = stats.fled > 0 ? ` · ${chalk.yellow(`${stats.fled} fled (PvP)`)}` : '';

  table.push(
    [
      'Runs',
      `${stats.runs}  ${chalk.green(`${successRuns} OK`)} · ${chalk.red(`${stats.deaths} died`)}${fledSegment}`,
    ],
    ['Rooms cleared', stats.rooms.toString()],
    ['Loot picks', `${stats.picks.length}  top: ${top3Picks}`],
    ['Items listed', chalk.green(stats.listed.toString())],
    ['Items skipped', stats.skipped.toString()],
    ['Items failed', stats.failed > 0 ? chalk.red(stats.failed.toString()) : '0'],
    ['Duration', formatDuration(stats.durationMs)],
  );
  return table.toString();
}

function topN(items: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, c]) => `${name}×${c}`);
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}
