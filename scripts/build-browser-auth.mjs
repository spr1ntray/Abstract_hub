import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

await build({
  entryPoints: [resolve(root, 'browser-src/game-auth.ts')],
  outfile: resolve(root, 'internal/src/ui/public/game-auth.js'),
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  platform: 'browser',
  format: 'iife',
  target: ['chrome109', 'edge109', 'firefox115', 'safari16'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});
