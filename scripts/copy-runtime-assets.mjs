import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const assets = [
  ['internal/src/ui/public', 'dist/src/ui/public'],
  ['internal/src/state/migrations', 'dist/src/state/migrations'],
  ['internal/build.yaml', 'dist/build.yaml'],
  ['hub-pack.json', 'dist/hub-pack.json'],
];

for (const [source, destination] of assets) {
  const from = resolve(root, source);
  const to = resolve(root, destination);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, force: true });
}
