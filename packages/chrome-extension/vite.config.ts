/**
 * Vite config for the Chrome extension build.
 *
 * Produces dist/extension/ with:
 * - index.html (side panel UI — bundled from packages/webapp/src/ui/main.ts)
 * - service-worker.js (built from packages/chrome-extension/src/service-worker.ts)
 * - offscreen.html + offscreen entry (built from packages/chrome-extension/src/offscreen.ts)
 * - sandbox.html, manifest.json (copied from packages/chrome-extension/)
 */

import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

export default defineConfig(({ mode }) => ({
  root: repoRoot,
  publicDir: resolve(repoRoot, 'packages/assets'),
  define: {
    __DEV__: JSON.stringify(mode !== 'production'),
  },
  resolve: {
    alias: {
      'node:zlib': resolve(__dirname, '../webapp/src/shims/empty.ts'),
      'node:module': resolve(__dirname, '../webapp/src/shims/empty.ts'),
      stream: resolve(__dirname, '../webapp/src/shims/stream.ts'),
      http: resolve(__dirname, '../webapp/src/shims/http.ts'),
      https: resolve(__dirname, '../webapp/src/shims/https.ts'),
      http2: resolve(__dirname, '../webapp/src/shims/http2.ts'),
      // Deep import into pi-coding-agent's compaction submodule (see vite.config.ts)
      '@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
        repoRoot,
        'node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js'
      ),
      '@mariozechner/pi-ai/dist/providers/transform-messages.js': resolve(
        repoRoot,
        'node_modules/@mariozechner/pi-ai/dist/providers/transform-messages.js'
      ),
      '@mariozechner/pi-ai/dist/providers/simple-options.js': resolve(
        repoRoot,
        'node_modules/@mariozechner/pi-ai/dist/providers/simple-options.js'
      ),
    },
  },
  esbuild: {
    target: 'esnext',
  },
  optimizeDeps: {
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
        index: resolve(__dirname, '../webapp/index.html'),
        offscreen: resolve(__dirname, 'offscreen.html'),
        'service-worker': resolve(__dirname, 'src/service-worker.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'service-worker') return 'service-worker.js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
  plugins: [
    {
      name: 'stub-pi-session-manager',
      enforce: 'pre' as const,
      resolveId(source, importer) {
        const normalizedImporter = importer?.replace(/\\/g, '/');
        if (
          source.endsWith('/session-manager.js') &&
          normalizedImporter?.includes('@mariozechner/pi-coding-agent')
        ) {
          return resolve(__dirname, '../webapp/src/stubs/pi-session-manager-stub.ts');
        }
      },
    },
    {
      name: 'build-preview-sw',
      async closeBundle() {
        // Build preview-sw as a self-contained IIFE via esbuild.
        // Rollup would code-split LightningFS into a shared chunk, which SWs can't import.
        const esbuild = await import('esbuild');
        await esbuild.build({
          entryPoints: [resolve(__dirname, '../webapp/src/ui/preview-sw.ts')],
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
      name: 'copy-extension-assets',
      closeBundle() {
        const outDir = resolve(repoRoot, 'dist/extension');
        mkdirSync(outDir, { recursive: true });
        copyFileSync(resolve(__dirname, 'manifest.json'), resolve(outDir, 'manifest.json'));
        copyFileSync(resolve(__dirname, 'sandbox.html'), resolve(outDir, 'sandbox.html'));
        copyFileSync(
          resolve(__dirname, 'sprinkle-sandbox.html'),
          resolve(outDir, 'sprinkle-sandbox.html')
        );
        copyFileSync(
          resolve(__dirname, 'tool-ui-sandbox.html'),
          resolve(outDir, 'tool-ui-sandbox.html')
        );
        copyFileSync(resolve(__dirname, 'voice-popup.html'), resolve(outDir, 'voice-popup.html'));
        copyFileSync(resolve(__dirname, 'voice-popup.js'), resolve(outDir, 'voice-popup.js'));

        // Copy logo files for extension icons and header
        const logosSrc = resolve(__dirname, '../assets/logos');
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
        const fontsSrc = resolve(__dirname, '../assets/fonts');
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

        copyFileSync(resolve(outDir, 'packages/webapp/index.html'), resolve(outDir, 'index.html'));
        copyFileSync(
          resolve(outDir, 'packages/chrome-extension/offscreen.html'),
          resolve(outDir, 'offscreen.html')
        );
      },
    },
  ],
}));
