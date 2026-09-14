import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(dirname, '../..');
const entry = resolve(dirname, 'src/overlay-entry.ts');
const outfile = resolve(repoRoot, 'dist/ui/electron-overlay-entry.js');

const tunnelEntry = resolve(dirname, 'src/tunnel/tunnel-loader-entry.ts');
const tunnelOutfile = resolve(repoRoot, 'dist/ui/electron-tunnel-loader.js');

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
