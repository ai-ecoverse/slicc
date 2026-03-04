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
          // service-worker must be at root level, not in assets/
          if (chunkInfo.name === 'service-worker') return 'service-worker.js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
  plugins: [
    {
      name: 'copy-extension-assets',
      closeBundle() {
        const outDir = resolve(__dirname, 'dist/extension');
        mkdirSync(outDir, { recursive: true });
        copyFileSync(resolve(__dirname, 'manifest.json'), resolve(outDir, 'manifest.json'));
        copyFileSync(resolve(__dirname, 'sandbox.html'), resolve(outDir, 'sandbox.html'));
      },
    },
  ],
}));
