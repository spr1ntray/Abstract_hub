import { readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const releaseDir = resolve(root, 'release');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const keep = new Set([
  `${pkg.productName}-${pkg.version}-macOS-universal.dmg`,
  `${pkg.productName}-${pkg.version}-Windows-x64.exe`,
]);

for (const entry of await readdir(releaseDir)) {
  if (keep.has(entry)) continue;
  await rm(resolve(releaseDir, entry), { recursive: true, force: true });
}

process.stderr.write(`release: kept ${[...keep].join(', ')}\n`);
