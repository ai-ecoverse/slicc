/**
 * Pure helpers shared by the worker asset-serving path (TS, esbuild-bundled) and
 * the CI upload script (Node, run from source). Plain ESM so both import it with
 * no build step. No worker/DOM/Node deps.
 */

/** Vite-hashed asset under /assets/: `<name>-<8+ url-safe>[.compound].<ext>`. */
export const HASHED_ASSET_RE =
  /^\/assets\/[A-Za-z0-9_][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,}(\.[a-z0-9]+)*\.(js|mjs|css|map|wasm|woff2|woff|ttf|otf|svg|png|jpg|jpeg|gif|webp|avif|ico|json)$/;

/** Fixed loader filenames inside a directory hashed from every gpu-ask asset. */
export const GPU_ASK_ASSET_RE =
  /^\/assets\/gpu-ask-[a-f0-9]{16}\/(?:v13\/(?:config|crf|manifest|static_vocab)\.json|v13\/member[0-9]+\.onnx|runtime\/inference\.(?:wasm|mjs))$/;

export function matchHashedAssetPath(pathname) {
  return HASHED_ASSET_RE.test(pathname) || GPU_ASK_ASSET_RE.test(pathname);
}

const MIME = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  map: 'application/json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
};

export function mimeForAssetPath(pathname) {
  const ext = pathname.slice(pathname.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}
