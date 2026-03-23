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
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  root: '.',
  publicDir: 'packages/assets/public',
  define: {
    __DEV__: JSON.stringify(mode !== 'production'),
  },
  resolve: {
    alias: {
      'node:zlib': resolve(__dirname, 'packages/webapp/src/shims/empty.ts'),
      'node:module': resolve(__dirname, 'packages/webapp/src/shims/empty.ts'),
      'stream': resolve(__dirname, 'packages/webapp/src/shims/stream.ts'),
      'http': resolve(__dirname, 'packages/webapp/src/shims/http.ts'),
      'https': resolve(__dirname, 'packages/webapp/src/shims/https.ts'),
      'http2': resolve(__dirname, 'packages/webapp/src/shims/http2.ts'),
      // Deep import into pi-coding-agent's compaction submodule (see vite.config.ts)
      '@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
        __dirname,
        'node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js',
      ),
      '@mariozechner/pi-ai/dist/utils/overflow.js': resolve(
        __dirname,
        'node_modules/@mariozechner/pi-ai/dist/utils/overflow.js',
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
    outDir: 'dist/extension',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'packages/webapp/index.html'),
        offscreen: resolve(__dirname, 'packages/chrome-extension/offscreen.html'),
        'service-worker': resolve(__dirname, 'packages/chrome-extension/src/service-worker.ts'),
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
      name: 'build-preview-sw',
      async closeBundle() {
        // Build preview-sw as a self-contained IIFE via esbuild.
        // Rollup would code-split LightningFS into a shared chunk, which SWs can't import.
        const esbuild = await import('esbuild');
        await esbuild.build({
          entryPoints: [resolve(__dirname, 'packages/webapp/src/ui/preview-sw.ts')],
          bundle: true,
          outfile: resolve(__dirname, 'dist/extension/preview-sw.js'),
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
        const outDir = resolve(__dirname, 'dist/extension');
        mkdirSync(outDir, { recursive: true });
        // Copy manifest — strip "key" field in dev builds so Chrome assigns a random ID
        // (avoids stale storage from previous installs). Set SLICC_EXT_DEV=1 to enable.
        const manifestSrc = resolve(__dirname, 'packages/chrome-extension/manifest.json');
        const manifestDest = resolve(outDir, 'manifest.json');
        if (process.env['SLICC_EXT_DEV']) {
          const manifest = JSON.parse(readFileSync(manifestSrc, 'utf-8'));
          delete manifest.key;
          writeFileSync(manifestDest, JSON.stringify(manifest, null, 2));
        } else {
          copyFileSync(manifestSrc, manifestDest);
        }
        copyFileSync(resolve(__dirname, 'packages/chrome-extension/sandbox.html'), resolve(outDir, 'sandbox.html'));
        copyFileSync(resolve(__dirname, 'packages/chrome-extension/sprinkle-sandbox.html'), resolve(outDir, 'sprinkle-sandbox.html'));
        copyFileSync(resolve(__dirname, 'packages/chrome-extension/tool-ui-sandbox.html'), resolve(outDir, 'tool-ui-sandbox.html'));
        copyFileSync(resolve(__dirname, 'packages/chrome-extension/voice-popup.html'), resolve(outDir, 'voice-popup.html'));
        copyFileSync(resolve(__dirname, 'packages/chrome-extension/voice-popup.js'), resolve(outDir, 'voice-popup.js'));

        // Copy logo files for extension icons and header
        const logosSrc = resolve(__dirname, 'packages/assets/logos');
        const logosDest = resolve(outDir, 'logos');
        mkdirSync(logosDest, { recursive: true });
        for (const file of readdirSync(logosSrc)) {
          if (file.endsWith('.png') || file.endsWith('.ico')) {
            try { copyFileSync(resolve(logosSrc, file), resolve(logosDest, file)); } catch { /* skip */ }
          }
        }

        // Copy fonts if present (Adobe Clean — local dev only, gitignored)
        const fontsSrc = resolve(__dirname, 'packages/assets/public/fonts');
        const fontsDest = resolve(outDir, 'fonts');
        try {
          mkdirSync(fontsDest, { recursive: true });
          for (const file of readdirSync(fontsSrc)) {
            if (file.endsWith('.otf') || file.endsWith('.woff2')) {
              try { copyFileSync(resolve(fontsSrc, file), resolve(fontsDest, file)); } catch { /* skip */ }
            }
          }
        } catch { /* fonts dir doesn't exist — fine, fallback fonts will be used */ }

        // Bundle Pyodide for extension (both main page and sandbox CSP block CDN scripts)
        const pyodideSrc = resolve(__dirname, 'node_modules/pyodide');
        const pyodideDest = resolve(outDir, 'pyodide');
        mkdirSync(pyodideDest, { recursive: true });
        for (const file of ['pyodide.asm.js', 'pyodide.asm.wasm', 'pyodide.js', 'pyodide-lock.json', 'python_stdlib.zip']) {
          try { copyFileSync(resolve(pyodideSrc, file), resolve(pyodideDest, file)); } catch { /* optional file */ }
        }

        // Bundle ImageMagick WASM for extension (CDN blocked by extension CSP)
        try {
          copyFileSync(
            resolve(__dirname, 'node_modules/@imagemagick/magick-wasm/dist/magick.wasm'),
            resolve(outDir, 'magick.wasm'),
          );
        } catch { /* @imagemagick/magick-wasm not installed */ }

        copyFileSync(resolve(outDir, 'packages/webapp/index.html'), resolve(outDir, 'index.html'));
        copyFileSync(resolve(outDir, 'packages/chrome-extension/offscreen.html'), resolve(outDir, 'offscreen.html'));
      },
    },
  ],
}));
