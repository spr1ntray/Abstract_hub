import { main } from './orchestrator/main.js';

const argv = process.argv.slice(2);

function arg(name: string, dflt: string): string {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  return dflt;
}

const account = arg('--account', '');
const all = argv.includes('--all');
if (!account && !all) {
  console.error('Specify --account <name> or --all');
  process.exit(1);
}

const dungeonName = arg('--dungeon', '5000');
const dungeon: 1 | 3 = dungeonName === 'underhaul' ? 3 : 1;
const dryRun = argv.includes('--dry-run');
const list = argv.includes('--list');

main({
  ...(account ? { account } : {}),
  all,
  dungeon,
  dryRun,
  list,
}).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
