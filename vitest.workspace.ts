import { defineWorkspace } from 'vitest/config';
import { resolve } from 'path';

const webappDir = resolve(__dirname, 'packages/webapp');
const workspaceRoot = __dirname;

export default defineWorkspace([
  {
    test: {
      name: 'webapp',
      globals: true,
      environment: 'node',
      include: ['packages/webapp/tests/**/*.test.ts'],
      exclude: [
        'packages/webapp/tests/integration/**/*.test.ts',
        'packages/webapp/tests/e2e/**/*.test.ts',
      ],
    },
    resolve: {
      alias: {
        buffer: 'buffer/',
        'node:zlib': resolve(webappDir, 'src/shims/empty.ts'),
        'node:module': resolve(webappDir, 'src/shims/empty.ts'),
        'stream': resolve(webappDir, 'src/shims/stream.ts'),
        'http': resolve(webappDir, 'src/shims/http.ts'),
        'https': resolve(webappDir, 'src/shims/https.ts'),
        'http2': resolve(webappDir, 'src/shims/http2.ts'),
        '@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
          workspaceRoot,
          'node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js',
        ),
        '@mariozechner/pi-ai/dist/utils/overflow.js': resolve(
          workspaceRoot,
          'node_modules/@mariozechner/pi-ai/dist/utils/overflow.js',
        ),
      },
    },
  },
  {
    test: {
      name: 'node-server',
      globals: true,
      environment: 'node',
      include: ['packages/node-server/tests/**/*.test.ts'],
      exclude: ['packages/node-server/tests/integration/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'chrome-extension',
      globals: true,
      environment: 'node',
      include: ['packages/chrome-extension/tests/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'cloudflare-worker',
      globals: true,
      environment: 'node',
      include: ['packages/cloudflare-worker/tests/**/*.test.ts'],
    },
  },
]);

