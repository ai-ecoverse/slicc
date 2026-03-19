import { resolve } from 'path';

export type ServerRuntimeKind = 'node' | 'swift';

export interface ServerRuntimeSelection {
  requestedRuntime: ServerRuntimeKind;
  selectedRuntime: ServerRuntimeKind;
  fallbackReason: string | null;
  swiftBinaryPath: string | null;
}

export interface ServerRuntimeSpawnConfig extends ServerRuntimeSelection {
  command: string;
  args: string[];
}

export interface BuildServerRuntimeSpawnOptions {
  projectRoot: string;
  dev: boolean;
  cdpPort: number;
  platform?: NodeJS.Platform;
  nodePath?: string;
  env?: Record<string, string | undefined>;
  preferredRuntime?: string | null;
  swiftBinaryPath?: string | null;
}

export const DEFAULT_SERVER_RUNTIME: ServerRuntimeKind = 'node';
export const SERVER_RUNTIME_ENV = 'SLICC_SERVER_RUNTIME';
export const SWIFT_SERVER_PATH_ENV = 'SLICC_SWIFT_SERVER_PATH';

export function parseServerRuntimePreference(value: string | null | undefined): ServerRuntimeKind {
  return value?.trim().toLowerCase() === 'swift' ? 'swift' : DEFAULT_SERVER_RUNTIME;
}

export function resolveSwiftServerBinaryPath(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configuredPath = env[SWIFT_SERVER_PATH_ENV]?.trim();
  if (!configuredPath) return null;
  return resolve(projectRoot, configuredPath);
}

export function resolveServerRuntimeSelection(options: BuildServerRuntimeSpawnOptions): ServerRuntimeSelection {
  const env = options.env ?? process.env;
  const requestedRuntime = parseServerRuntimePreference(options.preferredRuntime ?? env[SERVER_RUNTIME_ENV]);
  const swiftBinaryPath = options.swiftBinaryPath?.trim()
    ? resolve(options.projectRoot, options.swiftBinaryPath)
    : resolveSwiftServerBinaryPath(options.projectRoot, env);

  if (requestedRuntime === 'swift') {
    if (options.dev) {
      return {
        requestedRuntime,
        selectedRuntime: 'node',
        fallbackReason: 'Swift runtime is not wired into the Vite dev flow yet.',
        swiftBinaryPath,
      };
    }

    if (!swiftBinaryPath) {
      return {
        requestedRuntime,
        selectedRuntime: 'node',
        fallbackReason: `Swift runtime requested but ${SWIFT_SERVER_PATH_ENV} is not configured.`,
        swiftBinaryPath: null,
      };
    }
  }

  return {
    requestedRuntime,
    selectedRuntime: requestedRuntime,
    fallbackReason: null,
    swiftBinaryPath,
  };
}

function buildNodeServerRuntimeSpawnConfig(options: BuildServerRuntimeSpawnOptions): ServerRuntimeSpawnConfig {
  const platform = options.platform ?? process.platform;
  if (options.dev) {
    return {
      requestedRuntime: 'node',
      selectedRuntime: 'node',
      fallbackReason: null,
      swiftBinaryPath: null,
      command: platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['tsx', 'src/cli/index.ts', '--dev', '--serve-only', `--cdp-port=${options.cdpPort}`],
    };
  }

  return {
    requestedRuntime: 'node',
    selectedRuntime: 'node',
    fallbackReason: null,
    swiftBinaryPath: null,
    command: options.nodePath ?? process.env['npm_node_execpath'] ?? 'node',
    args: [resolve(options.projectRoot, 'dist/cli/index.js'), '--serve-only', `--cdp-port=${options.cdpPort}`],
  };
}

export function buildServerRuntimeSpawnConfig(options: BuildServerRuntimeSpawnOptions): ServerRuntimeSpawnConfig {
  const selection = resolveServerRuntimeSelection(options);

  if (selection.selectedRuntime === 'swift') {
    return {
      ...selection,
      command: selection.swiftBinaryPath!,
      args: ['--serve-only', `--cdp-port=${options.cdpPort}`],
    };
  }

  const nodeConfig = buildNodeServerRuntimeSpawnConfig(options);
  return {
    ...selection,
    command: nodeConfig.command,
    args: nodeConfig.args,
  };
}