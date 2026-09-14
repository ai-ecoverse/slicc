import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { stripBiomeWasmAssetPlugin } from '../webapp/vite-plugins/strip-biome-wasm-asset';
import { stripOrtWasmAssetPlugin } from '../webapp/vite-plugins/strip-ort-wasm-asset';
import { devReloadPlugin } from './vite-plugins/dev-reload';

const Dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(Dirname, '../..');
const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as {
  version: string;
};
const sliccReleasedAt = process.env['SLICC_RELEASED_AT'] ?? null;
const outDir = resolve(repoRoot, 'dist/extension');

const isExtDev = !!process.env['SLICC_EXT_DEV'];

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

function buildSidePanelPlugin() {
  return {
    name: 'build-sidepanel',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        format: 'esm',
        entryPoints: [resolve(Dirname, 'src/sidepanel-entry.ts')],
        outfile: resolve(outDir, 'sidepanel.js'),
        alias: {
          '@ai-ecoverse/cherry': resolve(repoRoot, 'packages/cherry/src/index.ts'),
          '@slicc/shared-ts': resolve(repoRoot, 'packages/shared-ts/src/index.ts'),
        },
        external: ['html2canvas-pro'],
        define: { ...PROD_IIFE_DEFAULTS.define, __SLICC_EXT_DEV__: JSON.stringify(isExtDev) },
      });
    },
  };
}

function buildSecretsPagePlugin() {
  return {
    name: 'build-secrets-page',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        entryPoints: [resolve(Dirname, 'src/secrets-entry.ts')],
        outfile: resolve(outDir, 'secrets.js'),

        alias: {
          '@slicc/shared-ts': resolve(repoRoot, 'packages/shared-ts/src/index.ts'),
        },
      });
    },
  };
}

function writeExtensionManifest(): void {
  const manifest = JSON.parse(readFileSync(resolve(Dirname, 'manifest.json'), 'utf-8'));
  manifest.version = rootPkg.version;
  if (process.env['SLICC_EXT_DEV']) {
    delete manifest.key;
    if (manifest.externally_connectable?.matches) {
      manifest.externally_connectable.matches = [
        ...manifest.externally_connectable.matches,
        'http://127.0.0.1/*',
      ];
    }
  }
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function copyStaticShellFiles(): void {
  const files = [
    'capture-popup.html',
    'capture-popup.js',
    'picker-popup.html',
    'picker-popup.js',
    'secrets.html',
    'sidepanel.html',
  ];
  for (const file of files) {
    copyFileSync(resolve(Dirname, file), resolve(outDir, file));
  }
}

function copyAssetDir(srcDir: string, destDir: string, extensions: string[]): void {
  mkdirSync(destDir, { recursive: true });
  for (const file of readdirSync(srcDir)) {
    if (!extensions.some((ext) => file.endsWith(ext))) continue;
    try {
      copyFileSync(resolve(srcDir, file), resolve(destDir, file));
    } catch {}
  }
}

function copyLogoAndFontAssets(): void {
  const manifest = JSON.parse(readFileSync(resolve(Dirname, 'manifest.json'), 'utf-8')) as {
    icons?: Record<string, string>;
    action?: { default_icon?: Record<string, string> };
  };
  const referenced = new Set<string>([
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ]);
  const logosSrc = resolve(Dirname, '../assets/logos');
  const logosDest = resolve(outDir, 'logos');
  mkdirSync(logosDest, { recursive: true });
  for (const rel of referenced) {
    const file = rel.replace(/^logos\//, '');
    try {
      copyFileSync(resolve(logosSrc, file), resolve(logosDest, file));
    } catch {}
  }
  try {
    copyAssetDir(resolve(Dirname, '../assets/fonts'), resolve(outDir, 'fonts'), ['.otf', '.woff2']);
  } catch {}
}

function copyExtensionAssetsPlugin() {
  return {
    name: 'copy-extension-assets',
    closeBundle() {
      mkdirSync(outDir, { recursive: true });
      writeExtensionManifest();
      copyStaticShellFiles();
      copyLogoAndFontAssets();
    },
  };
}

const isDevWatch = process.env['SLICC_EXT_DEV_WATCH'] === '1';
const devReloadSyncTo = process.env['SLICC_EXT_PATH'] ?? '/tmp/slicc-ext-build';
const devReloadCdpPort = Number(process.env['SLICC_CDP_PORT'] ?? '9333');

export default defineConfig(({ mode }) => ({
  root: repoRoot,

  publicDir: false,
  define: {
    __DEV__: JSON.stringify(mode !== 'production'),
    __SLICC_EXT_DEV__: JSON.stringify(isExtDev),
    __SLICC_VERSION__: JSON.stringify(rootPkg.version),
    __SLICC_RELEASED_AT__: JSON.stringify(sliccReleasedAt),

    __SLICC_BUILD_ID__: JSON.stringify(`${rootPkg.version}-ext-${Date.now().toString(36)}`),
  },
  resolve: {
    dedupe: [
      '@earendil-works/pi-ai',
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-tui',
      '@huggingface/transformers',
    ],
    alias: {
      '@slicc/shared-ts': resolve(repoRoot, 'packages/shared-ts/src/index.ts'),

      'isomorphic-git': resolve(repoRoot, 'node_modules/isomorphic-git/index.js'),
      'node:zlib': resolve(Dirname, '../webapp/src/shims/empty.ts'),
      'node:module': resolve(Dirname, '../webapp/src/shims/empty.ts'),
      stream: resolve(Dirname, '../webapp/src/shims/stream.ts'),
      http: resolve(Dirname, '../webapp/src/shims/http.ts'),
      https: resolve(Dirname, '../webapp/src/shims/https.ts'),
      http2: resolve(Dirname, '../webapp/src/shims/http2.ts'),

      '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
        repoRoot,
        'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js'
      ),
      '@earendil-works/pi-ai/dist/api/transform-messages.js': resolve(
        repoRoot,
        'node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js'
      ),
      '@earendil-works/pi-ai/dist/api/simple-options.js': resolve(
        repoRoot,
        'node_modules/@earendil-works/pi-ai/dist/api/simple-options.js'
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
      input: { __noop: 'virtual:thin-extension-noop' },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },

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
    copyExtensionAssetsPlugin(),

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
