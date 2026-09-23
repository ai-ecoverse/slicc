import { readFileSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import { piAiModelDataGeneratedAt } from './packages/webapp/vite-plugins/pi-ai-model-data';

const webappDir = resolve(__dirname, 'packages/webapp');
const workspaceRoot = __dirname;
const rootPkg = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf-8')) as {
  version: string;
};

const webappPkg = JSON.parse(readFileSync(resolve(webappDir, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
function wasmDepVersion(name: string): string {
  const spec = webappPkg.dependencies?.[name] ?? webappPkg.devDependencies?.[name];
  if (!spec) throw new Error(`webapp package.json is missing a version for ${name}`);
  return spec.replace(/^[\^~]/, '');
}
const wasmVersionDefines = {
  __MAGICK_WASM_VERSION__: JSON.stringify(wasmDepVersion('@imagemagick/magick-wasm')),
  __BIOME_WASM_WEB_VERSION__: JSON.stringify(wasmDepVersion('@biomejs/wasm-web')),
  __BIOME_JS_API_VERSION__: JSON.stringify(wasmDepVersion('@biomejs/js-api')),
  __FFMPEG_CORE_VERSION__: JSON.stringify(wasmDepVersion('@ffmpeg/core')),
  __V86_VERSION__: JSON.stringify(wasmDepVersion('v86')),
};

const isCI = Boolean(process.env['CI']);

const TIMING_OUTPUT_FILE = 'test-timing/vitest.json';

const CI_RETRIES = isCI ? 1 : 0;

const baseCoverageExclude = [
  '**/node_modules/**',
  '**/dist/**',
  '**/tests/**',
  '**/*.d.ts',
  '**/*.config.{ts,js,mjs}',
  '**/types.ts',
  '**/index.html',
  '**/shims/**',
  'packages/*/src/**/*.test.ts',

  'packages/dev-tools/**',
];

export default defineConfig({
  resolve: {
    alias: {
      '@slicc/shared-ts': resolve(workspaceRoot, 'packages/shared-ts/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',

    reporters: isCI ? ['default', 'json'] : ['default'],
    outputFile: { json: TIMING_OUTPUT_FILE },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      exclude: baseCoverageExclude,

      thresholds: {
        lines: 50,
        statements: 50,
        functions: 50,
        branches: 40,
      },
    },
    projects: [
      {
        extends: true,
        define: {
          __DEV__: 'true',
          __SLICC_VERSION__: JSON.stringify(rootPkg.version),
          __SLICC_RELEASED_AT__: 'null',
          __PI_AI_MODELS_GENERATED_AT__: JSON.stringify(piAiModelDataGeneratedAt(workspaceRoot)),
          __SLICC_BUILD_ID__: JSON.stringify('test-build'),
          ...wasmVersionDefines,
          global: 'globalThis',
        },
        resolve: {
          alias: {
            buffer: 'buffer/',

            'isomorphic-git': resolve(workspaceRoot, 'node_modules/isomorphic-git/index.js'),

            '@cantoo/pdf-lib': resolve(workspaceRoot, 'node_modules/@cantoo/pdf-lib/cjs/index.js'),
            'node:zlib': resolve(webappDir, 'src/shims/empty.ts'),
            'node:module': resolve(webappDir, 'src/shims/empty.ts'),
            stream: resolve(webappDir, 'src/shims/stream.ts'),
            http: resolve(webappDir, 'src/shims/http.ts'),
            https: resolve(webappDir, 'src/shims/https.ts'),
            http2: resolve(webappDir, 'src/shims/http2.ts'),
            '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
              workspaceRoot,
              'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js'
            ),
            '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js': resolve(
              workspaceRoot,
              'node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js'
            ),
            '@earendil-works/pi-agent-core/edit-tool': resolve(
              workspaceRoot,
              'node_modules/@earendil-works/pi-agent-core/dist/harness/tools/edit.js?pi-edit-lazy'
            ),
            '@earendil-works/pi-ai/dist/api/transform-messages.js': resolve(
              workspaceRoot,
              'node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js'
            ),
            '@earendil-works/pi-ai/dist/api/simple-options.js': resolve(
              workspaceRoot,
              'node_modules/@earendil-works/pi-ai/dist/api/simple-options.js'
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
          setupFiles: ['packages/webapp/tests/closeevent-polyfill.ts'],

          disableConsoleIntercept: true,
        },
      },
      {
        extends: true,
        test: {
          name: 'node-server',
          include: ['packages/node-server/tests/**/*.test.ts'],
          exclude: ['packages/node-server/tests/integration/**/*.test.ts'],

          retry: CI_RETRIES,
        },
      },
      {
        extends: true,
        test: {
          name: 'shared',
          include: ['packages/shared-ts/tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        define: {
          __DEV__: 'true',

          __SLICC_EXT_DEV__: 'false',

          ...wasmVersionDefines,
          __SLICC_BUILD_ID__: JSON.stringify('test-build'),
        },
        test: {
          name: 'chrome-extension',
          include: ['packages/chrome-extension/tests/**/*.test.ts'],

          retry: CI_RETRIES,
        },
      },
      {
        extends: true,
        test: {
          name: 'cloudflare-worker',
          include: ['packages/cloudflare-worker/tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'cloud-core',
          include: ['packages/cloud-core/tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'cherry',
          environment: 'jsdom',
          include: ['packages/cherry/tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dev-tools',
          include: ['packages/dev-tools/**/*.test.mjs'],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'swift-launcher',
          include: ['packages/swift-launcher/*.test.mjs'],
        },
      },
      {
        extends: true,
        test: {
          name: 'ios-app',
          include: ['packages/ios-app/scripts/*.test.mjs'],
        },
      },
      {
        extends: true,
        test: {
          name: 'claude-hooks',
          include: ['.claude/hooks/**/*.test.mjs'],
        },
      },
      {
        extends: true,
        test: {
          name: 'github-workflow',
          include: ['packages/github-workflow/**/*.test.mjs'],
        },
      },
    ],
  },
});
