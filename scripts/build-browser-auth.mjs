import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

await build({
  entryPoints: {
    'game-auth': resolve(root, 'browser-src/game-auth.ts'),
    'cambria-auth': resolve(root, 'browser-src/cambria-auth.ts'),
  },
  outdir: resolve(root, 'internal/src/ui/public'),
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
