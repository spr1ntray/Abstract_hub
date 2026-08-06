import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
const electronVersion = packageJson.devDependencies?.electron;
if (process.platform !== 'darwin') {
  throw new Error('Universal keytar can only be prepared on macOS');
}
if (typeof electronVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
  throw new Error('Exact Electron version is missing from package.json');
}

const rootRequire = createRequire(import.meta.url);
const builderRequire = createRequire(rootRequire.resolve('electron-builder/package.json'));
const rebuildEntry = builderRequire.resolve('@electron/rebuild');
const { rebuild } = await import(pathToFileURL(rebuildEntry).href);
const keytarBinary = join(projectRoot, 'node_modules/keytar/build/Release/keytar.node');
const scratch = await mkdtemp(join(tmpdir(), 'gigabot-keytar-universal-'));

async function rebuildAndCopy(arch) {
  await rebuild({
    buildPath: projectRoot,
    electronVersion,
    platform: 'darwin',
    arch,
    force: true,
    onlyModules: ['keytar'],
  });
  const destination = join(scratch, `keytar-${arch}.node`);
  await copyFile(keytarBinary, destination);
  return destination;
}

try {
  const x64Binary = await rebuildAndCopy('x64');
  const arm64Binary = await rebuildAndCopy('arm64');
  const lipo = spawnSync('lipo', [x64Binary, arm64Binary, '-create', '-output', keytarBinary], {
    encoding: 'utf8',
  });
  if (lipo.status !== 0) {
    throw new Error(lipo.stderr.trim() || 'lipo failed to create universal keytar');
  }

  const verify = spawnSync('lipo', ['-archs', keytarBinary], { encoding: 'utf8' });
  const architectures = verify.stdout.trim().split(/\s+/).sort();
  if (verify.status !== 0 || architectures.join(' ') !== 'arm64 x86_64') {
    throw new Error(`Unexpected keytar architectures: ${verify.stdout.trim() || 'none'}`);
  }
  process.stderr.write(`Prepared universal keytar (${architectures.join(', ')})\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
