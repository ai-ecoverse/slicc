// Build the Electron/CDP overlay bootstrap IIFE. Emits the canonical artifact
// `<repoRoot>/dist/ui/electron-overlay-entry.js` — the exact path node-server
// (`getElectronOverlayEntryDistPath`) reads at runtime and swift-launcher's
// `copy-overlay-entry.mjs` copies into the packaged `.app`. Spoon owns this
// artifact now, so a UI-only webapp change no longer rebuilds it (and the
// swift-launcher CI trigger keys on `packages/spoon/**`).

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(dirname, '../..');
const entry = resolve(dirname, 'src/overlay-entry.ts');
const outfile = resolve(repoRoot, 'dist/ui/electron-overlay-entry.js');

/** esbuild plugin: strip `?raw` and load `.svg` files as text (matches Vite's `?raw`). */
function rawSvgPlugin() {
  return {
    name: 'raw-svg',
    setup(b) {
      b.onResolve({ filter: /\.svg\?raw$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace('?raw', '')),
        namespace: 'raw-svg',
      }));
      b.onLoad({ filter: /.*/, namespace: 'raw-svg' }, async (args) => ({
        contents: await readFile(args.path, 'utf8'),
        loader: 'text',
      }));
    },
  };
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'iife',
  target: 'esnext',
  minify: true,
  define: { __DEV__: 'false', global: 'globalThis' },
  plugins: [rawSvgPlugin()],
});

console.log(`Built spoon overlay bundle: ${outfile}`);
