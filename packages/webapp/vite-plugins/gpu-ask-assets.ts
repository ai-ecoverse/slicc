import { createHash } from 'node:crypto';
import { cpSync, createReadStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const modelDir = resolve(
  dirname(fileURLToPath(import.meta.resolve('@ai-ecoverse/gpu-ask.js'))),
  '../models/v13'
);
const ortDir = dirname(fileURLToPath(import.meta.resolve('onnxruntime-web/wasm')));
const assets = new Map([
  ...[
    'config.json',
    'crf.json',
    'manifest.json',
    'static_vocab.json',
    'member0.onnx',
    'member1.onnx',
  ].map((name) => [`v13/${name}`, join(modelDir, name)] as const),
  ['runtime/inference.wasm', join(ortDir, 'ort-wasm-simd-threaded.wasm')] as const,
  ['runtime/inference.mjs', join(ortDir, 'ort-wasm-simd-threaded.mjs')] as const,
]);

// The model loader requests fixed filenames. Hash the containing directory so
// those filenames stay intact while old tabs can fetch their own asset version.
const digest = createHash('sha256');
for (const [path, source] of assets) {
  digest.update(path);
  digest.update(readFileSync(source));
}
export const gpuAskAssetBasePath = `assets/gpu-ask-${digest.digest('hex').slice(0, 16)}/`;

/** Serve the same local model and ORT files in dev that the production build ships. */
export function gpuAskAssetsPlugin(): Plugin {
  return {
    name: 'slicc:gpu-ask-assets',
    configureServer(server) {
      server.middlewares.use(`/${gpuAskAssetBasePath}`, (req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '').replace(/^\//, '');
        const source = assets.get(path);
        if (!source) return next();
        res.setHeader(
          'Content-Type',
          extname(path) === '.wasm'
            ? 'application/wasm'
            : extname(path) === '.json'
              ? 'application/json'
              : extname(path) === '.mjs'
                ? 'application/javascript'
                : 'application/octet-stream'
        );
        res.setHeader('Content-Length', statSync(source).size);
        createReadStream(source).pipe(res);
      });
    },
    writeBundle(output) {
      const dir = resolve(output.dir ?? 'dist/ui', gpuAskAssetBasePath);
      for (const [path, source] of assets) {
        const target = join(dir, path);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target);
      }
    },
  };
}
