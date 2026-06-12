/**
 * Vite config for the Chrome extension build.
 *
 * Produces dist/extension/ with:
 * - index.html (side panel UI — bundled from packages/webapp/src/ui/main.ts)
 * - service-worker.js (built from packages/chrome-extension/src/service-worker.ts)
 * - offscreen.html + offscreen entry (built from packages/chrome-extension/src/offscreen.ts)
 * - sandbox.html, manifest.json (copied from packages/chrome-extension/)
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { stripBiomeWasmAssetPlugin } from '../webapp/vite-plugins/strip-biome-wasm-asset';
import { stripOrtWasmAssetPlugin } from '../webapp/vite-plugins/strip-ort-wasm-asset';

const Dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(Dirname, '../..');
const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as {
  version: string;
};
const sliccReleasedAt = process.env['SLICC_RELEASED_AT'] ?? null;

export default defineConfig(({ mode }) => ({
  root: repoRoot,
  publicDir: resolve(repoRoot, 'packages/assets'),
  define: {
    __DEV__: JSON.stringify(mode !== 'production'),
    __SLICC_VERSION__: JSON.stringify(rootPkg.version),
    __SLICC_RELEASED_AT__: JSON.stringify(sliccReleasedAt),
  },
  resolve: {
    // pi-coding-agent ships its own physical copy of pi-ai / pi-agent-core /
    // pi-tui under its nested node_modules even when the versions match the
    // hoisted ones. Without deduping, Rolldown pulls two full pi trees into the
    // extension graph, which overflows the native "rendering chunks" pass and
    // fails the build with no diagnostic. Force a single copy of each.
    dedupe: ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-tui'],
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
    outDir: resolve(repoRoot, 'dist/extension'),
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        index: resolve(Dirname, '../webapp/index.html'),
        offscreen: resolve(Dirname, 'offscreen.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  plugins: [
    stripBiomeWasmAssetPlugin(),
    stripOrtWasmAssetPlugin(),
    {
      name: 'stub-pi-node-internals',
      enforce: 'pre' as const,
      resolveId(source, importer) {
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
    },
    {
      name: 'build-extension-service-worker',
      async closeBundle() {
        // MV3 service workers are classic scripts, not ES modules.
        // Bundle the service worker as one self-contained file so Chrome
        // never sees Rollup-generated shared-chunk imports.
        const esbuild = await import('esbuild');
        await esbuild.build({
          entryPoints: [resolve(Dirname, 'src/service-worker.ts')],
          bundle: true,
          outfile: resolve(repoRoot, 'dist/extension/service-worker.js'),
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
            global: 'globalThis',
          },
        });
      },
    },
    {
      name: 'build-preview-sw',
      async closeBundle() {
        // Build preview-sw as a self-contained IIFE via esbuild.
        // Rollup would code-split LightningFS into a shared chunk, which SWs can't import.
        const esbuild = await import('esbuild');
        await esbuild.build({
          entryPoints: [resolve(Dirname, '../webapp/src/ui/preview-sw.ts')],
          bundle: true,
          outfile: resolve(repoRoot, 'dist/extension/preview-sw.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
        });
      },
    },
    {
      name: 'build-secrets-page',
      async closeBundle() {
        // The Mount Secrets options page (secrets.html) loads
        // dist/extension/secrets.js as a classic script. Bundle the
        // TypeScript entry to a single self-contained IIFE so it
        // works without ES-module imports.
        const esbuild = await import('esbuild');
        await esbuild.build({
          entryPoints: [resolve(Dirname, 'src/secrets-entry.ts')],
          bundle: true,
          outfile: resolve(repoRoot, 'dist/extension/secrets.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
          // Same alias as the SW build above — standalone esbuild doesn't
          // inherit Vite's resolve.alias, so without this the
          // `@slicc/shared-ts` import in secrets-entry.ts fails to resolve.
          alias: {
            '@slicc/shared-ts': resolve(repoRoot, 'packages/shared-ts/src/index.ts'),
          },
        });
      },
    },
    {
      name: 'build-slicc-editor',
      async closeBundle() {
        const esbuild = await import('esbuild');
        await esbuild.build({
          entryPoints: [resolve(Dirname, '../webapp/src/ui/slicc-editor-entry.ts')],
          bundle: true,
          outfile: resolve(repoRoot, 'dist/extension/slicc-editor.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
        });
        // Also build lucide-icons.js for sprinkles
        await esbuild.build({
          entryPoints: [resolve(Dirname, '../webapp/src/ui/lucide-icons.ts')],
          bundle: true,
          outfile: resolve(repoRoot, 'dist/extension/lucide-icons.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
        });
      },
    },
    {
      name: 'build-slicc-diff',
      async closeBundle() {
        const esbuild = await import('esbuild');
        await esbuild.build({
          entryPoints: [resolve(Dirname, '../webapp/src/ui/slicc-diff-entry.ts')],
          bundle: true,
          outfile: resolve(repoRoot, 'dist/extension/slicc-diff.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
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
    },
    {
      name: 'copy-extension-assets',
      closeBundle() {
        const outDir = resolve(repoRoot, 'dist/extension');
        mkdirSync(outDir, { recursive: true });
        // Always override manifest.version from root package.json — the
        // committed source value is a sentinel and never read at runtime.
        // SLICC_EXT_DEV=1 also strips "key" so Chrome assigns a random ID
        // (avoids stale storage from previous installs).
        const manifestSrc = resolve(Dirname, 'manifest.json');
        const manifestDest = resolve(outDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestSrc, 'utf-8'));
        manifest.version = rootPkg.version;
        if (process.env['SLICC_EXT_DEV']) {
          delete manifest.key;
        }
        writeFileSync(manifestDest, JSON.stringify(manifest, null, 2));
        copyFileSync(resolve(Dirname, 'sandbox.html'), resolve(outDir, 'sandbox.html'));
        copyFileSync(
          resolve(Dirname, 'sprinkle-sandbox.html'),
          resolve(outDir, 'sprinkle-sandbox.html')
        );
        copyFileSync(
          resolve(Dirname, 'tool-ui-sandbox.html'),
          resolve(outDir, 'tool-ui-sandbox.html')
        );
        copyFileSync(resolve(Dirname, 'voice-popup.html'), resolve(outDir, 'voice-popup.html'));
        copyFileSync(resolve(Dirname, 'voice-popup.js'), resolve(outDir, 'voice-popup.js'));
        copyFileSync(resolve(Dirname, 'capture-popup.html'), resolve(outDir, 'capture-popup.html'));
        copyFileSync(resolve(Dirname, 'capture-popup.js'), resolve(outDir, 'capture-popup.js'));
        copyFileSync(resolve(Dirname, 'picker-popup.html'), resolve(outDir, 'picker-popup.html'));
        copyFileSync(resolve(Dirname, 'picker-popup.js'), resolve(outDir, 'picker-popup.js'));
        copyFileSync(resolve(Dirname, 'secrets.html'), resolve(outDir, 'secrets.html'));
        // secrets.js is built from src/secrets-entry.ts via esbuild below;
        // see the 'build-secrets-page' plugin.

        // Copy logo files for extension icons and header
        const logosSrc = resolve(Dirname, '../assets/logos');
        const logosDest = resolve(outDir, 'logos');
        mkdirSync(logosDest, { recursive: true });
        for (const file of readdirSync(logosSrc)) {
          if (file.endsWith('.png') || file.endsWith('.ico')) {
            try {
              copyFileSync(resolve(logosSrc, file), resolve(logosDest, file));
            } catch {
              /* skip */
            }
          }
        }

        // Copy fonts if present (Adobe Clean — local dev only, gitignored)
        const fontsSrc = resolve(Dirname, '../assets/fonts');
        const fontsDest = resolve(outDir, 'fonts');
        try {
          mkdirSync(fontsDest, { recursive: true });
          for (const file of readdirSync(fontsSrc)) {
            if (file.endsWith('.otf') || file.endsWith('.woff2')) {
              try {
                copyFileSync(resolve(fontsSrc, file), resolve(fontsDest, file));
              } catch {
                /* skip */
              }
            }
          }
        } catch {
          /* fonts dir doesn't exist — fine, fallback fonts will be used */
        }

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

        copyFileSync(resolve(outDir, 'packages/webapp/index.html'), resolve(outDir, 'index.html'));
        copyFileSync(
          resolve(outDir, 'packages/chrome-extension/offscreen.html'),
          resolve(outDir, 'offscreen.html')
        );
      },
    },
    {
      // Bundle the @ffmpeg/ffmpeg wrapper worker into a single
      // self-contained ESM file at dist/extension/vendor/ffmpeg-worker.js.
      // The wrapper worker source uses bare ESM imports (./const.js,
      // ./errors.js) which a ?raw blob-URL load cannot resolve at
      // runtime — the worker module then fails to parse silently, the
      // LOAD reply never arrives, and ffmpeg.load() hangs forever.
      // A pre-bundled file at the extension origin sidesteps that
      // entirely: same-scheme import() of the core JS works without
      // CSP / cross-scheme weirdness.
      name: 'build-ffmpeg-worker',
      async closeBundle() {
        const esbuild = await import('esbuild');
        const vendorDest = resolve(repoRoot, 'dist/extension/vendor');
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
    },
    {
      // Chrome Web Store MV3 reviewers string-match full CDN URLs in
      // built JS. The `@ffmpeg/ffmpeg` package's `dist/esm/const.js`
      // exports `CORE_URL` as a literal
      // `https://unpkg.com/@ffmpeg/core@<ver>/dist/umd/ffmpeg-core.js`,
      // which Vite/Rolldown bundles into the output even though our
      // loader always passes its own `coreURL` explicitly. The
      // override at runtime is not enough — the literal cannot
      // survive in built JS. Sweep `dist/extension/` after the
      // bundle is written and blank out any surviving full-path
      // unpkg `@ffmpeg/core` URLs.
      name: 'strip-ffmpeg-core-cdn-literal',
      enforce: 'post' as const,
      closeBundle() {
        const outDir = resolve(repoRoot, 'dist/extension');
        const literalRe = /https:\/\/unpkg\.com\/@ffmpeg\/core@[^"'`\s]*?\/ffmpeg-core\.js/g;
        let rewrittenCount = 0;
        const walk = (dir: string): void => {
          let entries: ReturnType<typeof readdirSync>;
          try {
            entries = readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const full = resolve(dir, entry.name);
            if (entry.isDirectory()) {
              walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
              const code = readFileSync(full, 'utf-8');
              if (!literalRe.test(code)) continue;
              literalRe.lastIndex = 0;
              writeFileSync(full, code.replace(literalRe, ''));
              rewrittenCount++;
            }
          }
        };
        walk(outDir);
        if (rewrittenCount > 0) {
          console.log(
            `[strip-ffmpeg-core-cdn-literal] sanitized ${rewrittenCount} file(s) in dist/extension/`
          );
        }
      },
    },
  ],
}));
