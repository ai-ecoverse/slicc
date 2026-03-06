/**
 * Vite config for the Chrome extension build.
 *
 * Produces dist/extension/ with:
 * - index.html (side panel UI — bundled from src/ui/main.ts)
 * - service-worker.js (built from src/extension/service-worker.ts)
 * - sandbox.html, manifest.json (copied from project root)
 */

import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  root: '.',
  define: {
    __DEV__: JSON.stringify(mode !== 'production'),
  },
  resolve: {
    alias: {
      'node:zlib': resolve(__dirname, 'src/shims/empty.ts'),
      'node:module': resolve(__dirname, 'src/shims/empty.ts'),
      'stream': resolve(__dirname, 'src/shims/stream.ts'),
      'http': resolve(__dirname, 'src/shims/http.ts'),
      'https': resolve(__dirname, 'src/shims/https.ts'),
      'http2': resolve(__dirname, 'src/shims/http2.ts'),
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
        index: resolve(__dirname, 'index.html'),
        'service-worker': resolve(__dirname, 'src/extension/service-worker.ts'),
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
          entryPoints: [resolve(__dirname, 'src/ui/preview-sw.ts')],
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
        copyFileSync(resolve(__dirname, 'manifest.json'), resolve(outDir, 'manifest.json'));
        copyFileSync(resolve(__dirname, 'sandbox.html'), resolve(outDir, 'sandbox.html'));

        // Bundle Pyodide for extension (both main page and sandbox CSP block CDN scripts)
        const pyodideSrc = resolve(__dirname, 'node_modules/pyodide');
        const pyodideDest = resolve(outDir, 'pyodide');
        mkdirSync(pyodideDest, { recursive: true });
        for (const file of ['pyodide.asm.js', 'pyodide.asm.wasm', 'pyodide.js', 'pyodide-lock.json', 'python_stdlib.zip']) {
          try { copyFileSync(resolve(pyodideSrc, file), resolve(pyodideDest, file)); } catch { /* optional file */ }
        }
      },
    },
  ],
}));
