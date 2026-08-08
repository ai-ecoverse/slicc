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
// Second artifact: the CDP virtual-network overlay loader, injected into the
// `srcdoc` frame when an Electron app blocks renderer network egress. Read from
// disk at runtime by node-server / swift-server (like electron-overlay-entry.js).
const tunnelEntry = resolve(dirname, 'src/tunnel/tunnel-loader-entry.ts');
const tunnelOutfile = resolve(repoRoot, 'dist/ui/electron-tunnel-loader.js');

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

const commonOptions = {
  bundle: true,
  format: 'iife',
  target: 'esnext',
  minify: true,
  define: { __DEV__: 'false', global: 'globalThis' },
  plugins: [rawSvgPlugin()],
};

await build({ ...commonOptions, entryPoints: [entry], outfile });
console.log(`Built spoon overlay bundle: ${outfile}`);

await build({ ...commonOptions, entryPoints: [tunnelEntry], outfile: tunnelOutfile });
console.log(`Built spoon tunnel loader bundle: ${tunnelOutfile}`);
