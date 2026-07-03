/**
 * Vite config for the Chrome extension build.
 *
 * Produces dist/extension/ with:
 * - service-worker.js (built from packages/chrome-extension/src/service-worker.ts)
 * - sidepanel.html + sidepanel.js (on-demand cherry side-panel cockpit)
 * - secrets.html + secrets.js (options page)
 * - sandbox.html, manifest.json (copied from packages/chrome-extension/)
 *
 * The thin extension does not bundle the webapp UI or an offscreen
 * agent engine — those load from the hosted sliccy.ai leader tab over
 * the CDP pass-through bridge (`bridge-sw.ts`).
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { stripBiomeWasmAssetPlugin } from '../webapp/vite-plugins/strip-biome-wasm-asset';
import { stripFfmpegCoreCdnLiteralPlugin } from '../webapp/vite-plugins/strip-ffmpeg-core-cdn-literal';
import { stripOrtWasmAssetPlugin } from '../webapp/vite-plugins/strip-ort-wasm-asset';
import { devReloadPlugin } from './vite-plugins/dev-reload';

const Dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(Dirname, '../..');
const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as {
  version: string;
};
const sliccReleasedAt = process.env['SLICC_RELEASED_AT'] ?? null;
const outDir = resolve(repoRoot, 'dist/extension');

/** Build-time signal that the extension is being packaged for local development
 *  (the same env var that already strips the manifest `key` and widens
 *  `externally_connectable` in `writeExtensionManifest`). The vite `mode`
 *  cannot stand in for this because `npm run dev:extension` runs `vite build
 *  --watch` without `--mode development`, so `mode === 'production'` in both
 *  prod and dev:extension. Code that needs to swap hosted URLs for the local
 *  vite dev server reads `__SLICC_EXT_DEV__` instead of `__DEV__`. */
const isExtDev = !!process.env['SLICC_EXT_DEV'];

/** The production esbuild defaults the standalone IIFE bundles share. */
const PROD_IIFE_DEFAULTS = {
  bundle: true,
  format: 'iife',
  target: 'esnext',
  minify: true,
  define: {
    __DEV__: 'false',
    __SLICC_EXT_DEV__: JSON.stringify(isExtDev),
    global: 'globalThis',
  },
} as const;

/**
 * Replace pi-coding-agent's Node-only modules (session-manager.js, config.js)
 * with browser-safe stubs — same rationale as the webapp config's twin.
 */
function stubPiNodeInternalsPlugin() {
  return {
    name: 'stub-pi-node-internals',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      const normalizedImporter = importer?.replace(/\\/g, '/');
      if (normalizedImporter?.includes('@earendil-works/pi-coding-agent')) {
        if (source.endsWith('/session-manager.js')) {
          return resolve(Dirname, '../webapp/src/stubs/pi-session-manager-stub.ts');
        }
        if (source.endsWith('/config.js') || source === '../config.js') {
          return resolve(Dirname, '../webapp/src/stubs/pi-config-stub.ts');
        }
      }
    },
  };
}

/**
 * Virtual no-op entry for Rolldown's mandatory `input`. The thin
 * extension's real bundles (service worker, content script, etc.) are
 * produced by `closeBundle` esbuild plugins, so the Rollup pipeline
 * has nothing to do. Rolldown still rejects an empty `input`, so we
 * feed it a single virtual module and drop the resulting chunk from
 * the bundle before it lands on disk.
 */
const NOOP_VIRTUAL_ID = 'virtual:thin-extension-noop';
function noopRollupInputPlugin() {
  return {
    name: 'thin-extension-noop-input',
    resolveId(source: string) {
      if (source === NOOP_VIRTUAL_ID) return source;
      return null;
    },
    load(id: string) {
      if (id === NOOP_VIRTUAL_ID) return 'export {};';
      return null;
    },
    generateBundle(_options: unknown, bundle: Record<string, { fileName?: string }>) {
      for (const key of Object.keys(bundle)) {
        const fileName = bundle[key]?.fileName ?? key;
        if (fileName.includes('__noop')) delete bundle[key];
      }
    },
  };
}

/**
 * MV3 service workers are classic scripts, not ES modules. Bundle the
 * service worker as one self-contained file so Chrome never sees
 * Rollup-generated shared-chunk imports.
 */
function buildExtensionServiceWorkerPlugin(mode: string) {
  return {
    name: 'build-extension-service-worker',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        entryPoints: [resolve(Dirname, 'src/service-worker.ts')],
        bundle: true,
        outfile: resolve(outDir, 'service-worker.js'),
        format: 'iife',
        target: 'esnext',
        minify: true,
        alias: {
          // Workspace package — resolve to source so the IIFE bundle does
          // not require `packages/shared-ts/dist/` to exist at build time.
          '@slicc/shared-ts': resolve(repoRoot, 'packages/shared-ts/src/index.ts'),
        },
        define: {
          __DEV__: JSON.stringify(mode !== 'production'),
          __SLICC_EXT_DEV__: JSON.stringify(isExtDev),
          global: 'globalThis',
        },
      });
    },
  };
}

/** Build preview-sw as a self-contained IIFE (Rollup would code-split it). */
function buildPreviewSwPlugin() {
  return {
    name: 'build-preview-sw',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        entryPoints: [resolve(Dirname, '../webapp/src/ui/preview-sw.ts')],
        outfile: resolve(outDir, 'preview-sw.js'),
      });
    },
  };
}

/**
 * esbuild plugin: load `*.svg?raw` imports as text — matches Vite's `?raw`
 * loader so the launcher's inline mono-logo SVGs bundle correctly.
 */
function rawSvgEsbuildPlugin(): import('esbuild').Plugin {
  return {
    name: 'raw-svg',
    setup(build) {
      build.onResolve({ filter: /\.svg\?raw$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace('?raw', '')),
        namespace: 'raw-svg',
      }));
      build.onLoad({ filter: /.*/, namespace: 'raw-svg' }, async (args) => {
        const { readFile } = await import('fs/promises');
        return { contents: await readFile(args.path, 'utf8'), loader: 'text' };
      });
    },
  };
}

/**
 * Build the side-panel host as ESM. The panel mounts a UI-only cherry follower
 * iframe and runs the tri-state controller (booting → ready → disconnected)
 * via a chrome-panel Port to the service worker.
 */
function buildSidePanelPlugin() {
  return {
    name: 'build-sidepanel',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        format: 'esm', // sidepanel.html loads it as type="module"
        entryPoints: [resolve(Dirname, 'src/sidepanel-entry.ts')],
        outfile: resolve(outDir, 'sidepanel.js'),
        alias: {
          '@ai-ecoverse/cherry': resolve(repoRoot, 'packages/cherry/src/index.ts'),
          '@slicc/shared-ts': resolve(repoRoot, 'packages/shared-ts/src/index.ts'),
        },
        external: ['html2canvas-pro'],
        plugins: [rawSvgEsbuildPlugin()],
        define: { ...PROD_IIFE_DEFAULTS.define, __SLICC_EXT_DEV__: JSON.stringify(isExtDev) },
      });
    },
  };
}

/**
 * The Mount Secrets options page (secrets.html) loads
 * dist/extension/secrets.js as a classic script — bundle the TypeScript
 * entry to a single self-contained IIFE.
 */
function buildSecretsPagePlugin() {
  return {
    name: 'build-secrets-page',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        entryPoints: [resolve(Dirname, 'src/secrets-entry.ts')],
        outfile: resolve(outDir, 'secrets.js'),
        // Same alias as the SW build above — standalone esbuild doesn't
        // inherit Vite's resolve.alias, so without this the
        // `@slicc/shared-ts` import in secrets-entry.ts fails to resolve.
        alias: {
          '@slicc/shared-ts': resolve(repoRoot, 'packages/shared-ts/src/index.ts'),
        },
      });
    },
  };
}

/** `<slicc-editor>` + lucide-icons IIFE bundles for sprinkle iframes. */
function buildSliccEditorPlugin() {
  return {
    name: 'build-slicc-editor',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        entryPoints: [resolve(Dirname, '../webapp/src/ui/slicc-editor-entry.ts')],
        outfile: resolve(outDir, 'slicc-editor.js'),
      });
      // Also build lucide-icons.js for sprinkles
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        entryPoints: [resolve(Dirname, '../webapp/src/ui/lucide-icons.ts')],
        outfile: resolve(outDir, 'lucide-icons.js'),
      });
    },
  };
}

/**
 * The realm `sandbox.html` iframe runs outside the TS module graph and has
 * no `globalThis.Buffer` of its own. Bundle the webapp's `buffer@6.0.3`
 * polyfill as a standalone IIFE so the iframe can pull it in via
 * `<script src="buffer-polyfill.js">` before the realm bootstrap executes.
 * Keeps Buffer parity with the standalone worker float
 * (`js-realm-shared.ts` imports the same polyfill at module load).
 */
function buildBufferPolyfillPlugin() {
  return {
    name: 'build-buffer-polyfill',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        entryPoints: [resolve(Dirname, '../webapp/src/shims/buffer-polyfill.ts')],
        outfile: resolve(outDir, 'buffer-polyfill.js'),
      });
    },
  };
}

/**
 * The realm `sandbox.html` iframe's `crypto.createHash` / `zlib` shims depend
 * on pure-JS hash + compression libraries (`js-md5` / `js-sha1` / `js-sha256`
 * and `pako`). The iframe runs outside the TS module graph, so bundle them as
 * a standalone IIFE published on `globalThis.__sliccRealmVendor` and loaded via
 * `<script src="realm-vendor.js">`. Keeps parity with the standalone worker
 * float (`js-realm-helpers.ts` imports the same libraries at module load).
 */
function buildRealmVendorPlugin() {
  return {
    name: 'build-realm-vendor',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        entryPoints: [resolve(Dirname, '../webapp/src/shims/realm-vendor.ts')],
        outfile: resolve(outDir, 'realm-vendor.js'),
      });
    },
  };
}

/** `<slicc-diff>` IIFE bundle for sprinkle iframes. */
function buildSliccDiffPlugin() {
  return {
    name: 'build-slicc-diff',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        entryPoints: [resolve(Dirname, '../webapp/src/ui/slicc-diff-entry.ts')],
        outfile: resolve(outDir, 'slicc-diff.js'),
        plugins: [
          {
            name: 'resolve-pierre-diffs-internals',
            setup(build) {
              build.onResolve({ filter: /^@pierre\/diffs\/dist\// }, (args) => ({
                path: resolve(repoRoot, 'node_modules', args.path.replace(/\.js$/, '') + '.js'),
              }));
            },
          },
        ],
      });
    },
  };
}

/**
 * Write manifest.json with the root package version (the committed source
 * value is a sentinel and never read at runtime). SLICC_EXT_DEV=1 also
 * strips "key" so Chrome assigns a random ID (avoids stale storage from
 * previous installs), and widens `externally_connectable` so the leader
 * tab served from a localhost vite dev server can open the CDP bridge Port.
 */
function writeExtensionManifest(): void {
  const manifest = JSON.parse(readFileSync(resolve(Dirname, 'manifest.json'), 'utf-8'));
  manifest.version = rootPkg.version;
  if (process.env['SLICC_EXT_DEV']) {
    delete manifest.key;
    if (manifest.externally_connectable?.matches) {
      // Chrome match patterns reject `:*` port wildcards (the generated
      // manifest would fail to load). The committed `http://localhost/*`
      // already matches every localhost port; only the loopback IP host
      // needs adding for the local wrangler dev server.
      manifest.externally_connectable.matches = [
        ...manifest.externally_connectable.matches,
        'http://127.0.0.1/*',
      ];
    }
  }
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

/** Copy the static HTML shells + popup scripts shipped verbatim. */
function copyStaticShellFiles(): void {
  const files = [
    'sandbox.html',
    'sprinkle-sandbox.html',
    'tool-ui-sandbox.html',
    'capture-popup.html',
    'capture-popup.js',
    'picker-popup.html',
    'picker-popup.js',
    'secrets.html',
    'sidepanel.html',
    // secrets.js is built from src/secrets-entry.ts via esbuild — see the
    // 'build-secrets-page' plugin.
  ];
  for (const file of files) {
    copyFileSync(resolve(Dirname, file), resolve(outDir, file));
  }
}

/** Copy a directory's files filtered by extension (best-effort per file). */
function copyAssetDir(srcDir: string, destDir: string, extensions: string[]): void {
  mkdirSync(destDir, { recursive: true });
  for (const file of readdirSync(srcDir)) {
    if (!extensions.some((ext) => file.endsWith(ext))) continue;
    try {
      copyFileSync(resolve(srcDir, file), resolve(destDir, file));
    } catch {
      /* skip */
    }
  }
}

/** Logos (extension icons/header) + fonts (Adobe Clean — local dev only). */
function copyLogoAndFontAssets(): void {
  copyAssetDir(resolve(Dirname, '../assets/logos'), resolve(outDir, 'logos'), ['.png', '.ico']);
  try {
    copyAssetDir(resolve(Dirname, '../assets/fonts'), resolve(outDir, 'fonts'), ['.otf', '.woff2']);
  } catch {
    /* fonts dir doesn't exist — fine, fallback fonts will be used */
  }
}

/** Pyodide + ImageMagick + ffmpeg-core vendors (extension CSP blocks CDNs). */
function copyWasmVendorAssets(): void {
  // Bundle Pyodide for extension (both main page and sandbox CSP block CDN scripts)
  const pyodideSrc = resolve(repoRoot, 'node_modules/pyodide');
  const pyodideDest = resolve(outDir, 'pyodide');
  mkdirSync(pyodideDest, { recursive: true });
  for (const file of [
    'pyodide.asm.js',
    'pyodide.asm.wasm',
    'pyodide.js',
    'pyodide-lock.json',
    'python_stdlib.zip',
  ]) {
    try {
      copyFileSync(resolve(pyodideSrc, file), resolve(pyodideDest, file));
    } catch {
      /* optional file */
    }
  }

  // Bundle ImageMagick WASM for extension (CDN blocked by extension CSP)
  try {
    copyFileSync(
      resolve(repoRoot, 'node_modules/@imagemagick/magick-wasm/dist/magick.wasm'),
      resolve(outDir, 'magick.wasm')
    );
  } catch {
    /* @imagemagick/magick-wasm not installed */
  }

  // Bundle @ffmpeg/core ESM glue (~112 KB) for the extension.
  // Chrome Web Store MV3 review forbids hosting executable JS
  // off-package, so the loader pulls it from `vendor/` via
  // `chrome.runtime.getURL`. The much larger `ffmpeg-core.wasm`
  // continues to stream from the CDN on first run.
  const vendorDest = resolve(outDir, 'vendor');
  mkdirSync(vendorDest, { recursive: true });
  copyFileSync(
    resolve(repoRoot, 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js'),
    resolve(vendorDest, 'ffmpeg-core.js')
  );
}

/** Static asset copying + manifest stamping into dist/extension/. */
function copyExtensionAssetsPlugin() {
  return {
    name: 'copy-extension-assets',
    closeBundle() {
      mkdirSync(outDir, { recursive: true });
      writeExtensionManifest();
      copyStaticShellFiles();
      copyLogoAndFontAssets();
      copyWasmVendorAssets();
    },
  };
}

/**
 * Bundle the @ffmpeg/ffmpeg wrapper worker into a single self-contained ESM
 * file at dist/extension/vendor/ffmpeg-worker.js. The wrapper worker source
 * uses bare ESM imports (./const.js, ./errors.js) which a ?raw blob-URL load
 * cannot resolve at runtime — the worker module then fails to parse
 * silently, the LOAD reply never arrives, and ffmpeg.load() hangs forever.
 * A pre-bundled file at the extension origin sidesteps that entirely:
 * same-scheme import() of the core JS works without CSP / cross-scheme
 * weirdness.
 */
function buildFfmpegWorkerPlugin() {
  return {
    name: 'build-ffmpeg-worker',
    async closeBundle() {
      const esbuild = await import('esbuild');
      const vendorDest = resolve(outDir, 'vendor');
      mkdirSync(vendorDest, { recursive: true });
      await esbuild.build({
        entryPoints: [resolve(repoRoot, 'node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js')],
        bundle: true,
        outfile: resolve(vendorDest, 'ffmpeg-worker.js'),
        format: 'esm',
        target: 'esnext',
        minify: true,
      });
    },
  };
}

// `dev:extension` (npm run dev:extension) sets SLICC_EXT_DEV_WATCH=1 so the
// dev-reload plugin runs after every rebuild AND so the esbuild-managed entry
// points (service-worker, sidepanel-entry, secrets-entry, …) that live outside
// the Rollup module graph still trigger rebuilds. The seam is `this.addWatchFile`
// inside the dev-reload plugin's `buildStart` — `build.watch.include` would NOT
// work because Rollup treats it as a filter on the existing graph rather than
// an additive include. See packages/chrome-extension/CLAUDE.md "Dev Watch".
const isDevWatch = process.env['SLICC_EXT_DEV_WATCH'] === '1';
const devReloadSyncTo = process.env['SLICC_EXT_PATH'] ?? '/tmp/slicc-ext-build';
const devReloadCdpPort = Number(process.env['SLICC_CDP_PORT'] ?? '9333');

export default defineConfig(({ mode }) => ({
  root: repoRoot,
  publicDir: resolve(repoRoot, 'packages/assets'),
  define: {
    __DEV__: JSON.stringify(mode !== 'production'),
    __SLICC_EXT_DEV__: JSON.stringify(isExtDev),
    __SLICC_VERSION__: JSON.stringify(rootPkg.version),
    __SLICC_RELEASED_AT__: JSON.stringify(sliccReleasedAt),
  },
  resolve: {
    // pi-coding-agent ships its own physical copy of pi-ai / pi-agent-core /
    // pi-tui under its nested node_modules even when the versions match the
    // hoisted ones. Without deduping, Rolldown pulls two full pi trees into the
    // extension graph, which overflows the native "rendering chunks" pass and
    // fails the build with no diagnostic. Force a single copy of each.
    // kokoro-js additionally nests its own @huggingface/transformers ^3.x
    // (npm overrides don't reach workspace deps) — dedupe onto the hoisted
    // 4.x so one transformers + one onnxruntime-web version ships.
    dedupe: [
      '@earendil-works/pi-ai',
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-tui',
      '@huggingface/transformers',
    ],
    alias: {
      // Workspace `@slicc/shared-ts` points at source so esbuild/Rolldown for the
      // SW IIFE and the extension's worker entries resolve without requiring
      // `packages/shared-ts/dist/` to exist at build time.
      '@slicc/shared-ts': resolve(repoRoot, 'packages/shared-ts/src/index.ts'),
      // The pinned isomorphic-git package resolves "." to index.cjs, and that
      // CJS entry imports Node crypto. Force the browser-safe ESM entry
      // instead.
      'isomorphic-git': resolve(repoRoot, 'node_modules/isomorphic-git/index.js'),
      'node:zlib': resolve(Dirname, '../webapp/src/shims/empty.ts'),
      'node:module': resolve(Dirname, '../webapp/src/shims/empty.ts'),
      stream: resolve(Dirname, '../webapp/src/shims/stream.ts'),
      http: resolve(Dirname, '../webapp/src/shims/http.ts'),
      https: resolve(Dirname, '../webapp/src/shims/https.ts'),
      http2: resolve(Dirname, '../webapp/src/shims/http2.ts'),
      // Deep import into pi-coding-agent's compaction submodule (see vite.config.ts)
      '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
        repoRoot,
        'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js'
      ),
      '@earendil-works/pi-ai/dist/providers/transform-messages.js': resolve(
        repoRoot,
        'node_modules/@earendil-works/pi-ai/dist/providers/transform-messages.js'
      ),
      '@earendil-works/pi-ai/dist/providers/simple-options.js': resolve(
        repoRoot,
        'node_modules/@earendil-works/pi-ai/dist/providers/simple-options.js'
      ),
    },
  },
  esbuild: {
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: ['@earendil-works/pi-coding-agent'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      // The thin extension ships no HTML/JS entries through Rollup — all
      // bundled outputs (service worker, content script, secrets page,
      // sandbox helpers, preview SW, ffmpeg worker, slicc-editor /
      // slicc-diff IIFEs) are produced by the closeBundle esbuild
      // plugins below. Rolldown requires at least one input, so we
      // route a single virtual entry through `noopRollupInputPlugin()`
      // (defined further down) and drop the resulting chunk from the
      // bundle in `generateBundle` so the output tree stays clean.
      input: { __noop: 'virtual:thin-extension-noop' },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
    // In watch mode, an empty `watch: {}` opts into Rollup's watcher loop.
    // Expanding which files trigger rebuilds is handled by the dev-reload
    // plugin via `this.addWatchFile` (see vite-plugins/dev-reload.ts) —
    // `watch.include` is filter-only, NOT additive, so wiring it here would
    // never pick up the esbuild-managed entries (service-worker, sidepanel,
    // secrets-entry, …) that live outside Rollup's module graph.
    watch: isDevWatch ? {} : undefined,
  },
  plugins: [
    noopRollupInputPlugin(),
    stripBiomeWasmAssetPlugin(),
    stripOrtWasmAssetPlugin(),
    stubPiNodeInternalsPlugin(),
    buildExtensionServiceWorkerPlugin(mode),
    buildPreviewSwPlugin(),
    buildSidePanelPlugin(),
    buildSecretsPagePlugin(),
    buildSliccEditorPlugin(),
    buildSliccDiffPlugin(),
    buildBufferPolyfillPlugin(),
    buildRealmVendorPlugin(),
    copyExtensionAssetsPlugin(),
    buildFfmpegWorkerPlugin(),
    stripFfmpegCoreCdnLiteralPlugin(),
    // Must run AFTER every other closeBundle so the synced tree reflects the
    // complete build (manifest stamp, ffmpeg-core literal strip, etc.).
    // `extraWatchDirs` registers esbuild-input sources with Rollup's watcher
    // via `this.addWatchFile`. With Rollup's `input` empty after the
    // thin-extension strip, the webapp source tree no longer reaches the
    // graph automatically — list it here so edits under packages/webapp/src
    // (consumed by the sidepanel + slicc-editor / slicc-diff IIFEs)
    // still trigger rebuilds.
    ...(isDevWatch
      ? [
          devReloadPlugin({
            outDir,
            syncTo: devReloadSyncTo,
            cdpPort: devReloadCdpPort,
            extraWatchDirs: [resolve(Dirname, 'src'), resolve(Dirname, '../webapp/src')],
          }),
        ]
      : []),
  ],
}));
