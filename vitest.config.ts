import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const webappDir = resolve(__dirname, 'packages/webapp');
const workspaceRoot = __dirname;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        extends: true,
        define: {
          __DEV__: 'true',
          global: 'globalThis',
        },
        resolve: {
          alias: {
            buffer: 'buffer/',
            // isomorphic-git >=1.37.5 exports map points "." to index.cjs which
            // calls require('crypto').createHash — Node-only, breaks in browsers.
            // Force the ESM entry which uses sha.js (pure JS, browser-safe).
            'isomorphic-git': resolve(workspaceRoot, 'node_modules/isomorphic-git/index.js'),
            'node:zlib': resolve(webappDir, 'src/shims/empty.ts'),
            'node:module': resolve(webappDir, 'src/shims/empty.ts'),
            stream: resolve(webappDir, 'src/shims/stream.ts'),
            http: resolve(webappDir, 'src/shims/http.ts'),
            https: resolve(webappDir, 'src/shims/https.ts'),
            http2: resolve(webappDir, 'src/shims/http2.ts'),
            '@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
              workspaceRoot,
              'node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js'
            ),
            '@mariozechner/pi-ai/dist/providers/transform-messages.js': resolve(
              workspaceRoot,
              'node_modules/@mariozechner/pi-ai/dist/providers/transform-messages.js'
            ),
            '@mariozechner/pi-ai/dist/providers/simple-options.js': resolve(
              workspaceRoot,
              'node_modules/@mariozechner/pi-ai/dist/providers/simple-options.js'
            ),
          },
        },
        test: {
          name: 'webapp',
          include: ['packages/webapp/tests/**/*.test.ts'],
          exclude: [
            'packages/webapp/tests/integration/**/*.test.ts',
            'packages/webapp/tests/e2e/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'node-server',
          include: ['packages/node-server/tests/**/*.test.ts'],
          exclude: ['packages/node-server/tests/integration/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'chrome-extension',
          include: ['packages/chrome-extension/tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'cloudflare-worker',
          include: ['packages/cloudflare-worker/tests/**/*.test.ts'],
        },
      },
    ],
  },
});
