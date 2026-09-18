import { accessSync, constants, readdirSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

export interface ElectronFloatFlags {
  cdpPort: number;
  servePort: number;
  targetUrl: string;
}

export interface ElectronServerSpawnConfig {
  command: string;
  args: string[];
}

export interface ElectronAppLaunchSpec {
  command: string;
  args: string[];
  displayName: string;
  resolvedAppPath: string;
  processMatchPatterns: string[];
}

export interface ElectronInspectableTarget {
  id?: string;
  type: string;
  title?: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export const DEFAULT_ELECTRON_SERVE_PORT = 5710;
export const DEFAULT_ELECTRON_SERVE_HOST = 'localhost';
export const DEFAULT_ELECTRON_CDP_PORT = 9223;
export const DEFAULT_ELECTRON_TARGET_URL = 'about:blank';

export const PORT_HASH_RANGE = 40;

export function hashString(str: string, max: number): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash) % max;
}

export async function tryListenOnPort(port: number, host: string): Promise<number> {
  const { createServer } = await import('net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const assignedPort = addr && typeof addr === 'object' ? addr.port : port;
      server.close(() => resolve(assignedPort));
    });
  });
}

export async function isPortAvailable(
  port: number,
  listen: (port: number, host: string) => Promise<number> = tryListenOnPort
): Promise<boolean> {
  try {
    await listen(port, '127.0.0.1');
    try {
      await listen(port, '::1');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function findAvailablePort(
  startPort: number,
  maxAttempts = 100,
  available: (port: number) => Promise<boolean> = isPortAvailable
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await available(port)) {
      return port;
    }
  }
  throw new Error(`Could not find available port starting from ${startPort}`);
}

export async function getElectronAppPort(
  appPath: string,
  basePort: number,
  available: (port: number) => Promise<boolean> = isPortAvailable
): Promise<number> {
  const offset = hashString(appPath, PORT_HASH_RANGE);
  const preferredPort = basePort + offset;

  if (await available(preferredPort)) {
    return preferredPort;
  }

  return findAvailablePort(preferredPort + 1, 100, available);
}

export async function getElectronAppPorts(
  appPath: string
): Promise<{ cdpPort: number; servePort: number }> {
  const cdpPort = await getElectronAppPort(appPath, DEFAULT_ELECTRON_CDP_PORT);
  const servePort = await getElectronAppPort(appPath, DEFAULT_ELECTRON_SERVE_PORT);
  return { cdpPort, servePort };
}

export function getElectronAppDisplayName(appPath: string): string {
  const trimmedPath = appPath.replace(/[\\/]+$/, '');
  const fileName = basename(trimmedPath);

  if (fileName.toLowerCase().endsWith('.app')) {
    return fileName.slice(0, -'.app'.length) || fileName;
  }

  return fileName || trimmedPath;
}

export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findMacOSExecutable(macOSDir: string, expectedName: string): string | null {
  const expectedPath = join(macOSDir, expectedName);
  try {
    const stat = statSync(expectedPath);
    if (stat.isFile()) {
      return expectedPath;
    }
  } catch {}

  const helperPatterns = [/helper/i, /crash/i, /gpu/i, /renderer/i, /plugin/i, /utility/i];
  try {
    const entries = readdirSync(macOSDir);

    if (entries.includes('Electron')) {
      const electronPath = join(macOSDir, 'Electron');
      try {
        const stat = statSync(electronPath);
        if (stat.isFile() && isExecutableFile(electronPath)) {
          return electronPath;
        }
      } catch {}
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry.endsWith('.sh')) continue;
      if (helperPatterns.some((p) => p.test(entry))) continue;

      const entryPath = join(macOSDir, entry);
      try {
        const stat = statSync(entryPath);
        if (stat.isFile() && isExecutableFile(entryPath)) {
          return entryPath;
        }
      } catch {}
    }
  } catch {}

  return null;
}

export function resolveElectronAppExecutablePath(
  appPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const resolvedAppPath = resolve(appPath);

  if (platform === 'darwin' && resolvedAppPath.toLowerCase().endsWith('.app')) {
    const macOSDir = join(resolvedAppPath, 'Contents', 'MacOS');
    const expectedName = getElectronAppDisplayName(resolvedAppPath);
    const expectedPath = join(macOSDir, expectedName);

    return findMacOSExecutable(macOSDir, expectedName) ?? expectedPath;
  }

  return resolvedAppPath;
}

export function buildElectronAppProcessMatchPatterns(
  appPath: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  return Array.from(
    new Set([resolve(appPath), resolveElectronAppExecutablePath(appPath, platform)])
  );
}

export function buildElectronAppLaunchSpec(
  appPath: string,
  options: {
    cdpPort: number;
    platform?: NodeJS.Platform;
  }
): ElectronAppLaunchSpec {
  const platform = options.platform ?? process.platform;
  const resolvedAppPath = resolve(appPath);
  const displayName = getElectronAppDisplayName(resolvedAppPath);
  const executablePath = resolveElectronAppExecutablePath(resolvedAppPath, platform);

  return {
    command: executablePath,
    args: [`--remote-debugging-port=${options.cdpPort}`],
    displayName,
    resolvedAppPath,
    processMatchPatterns: buildElectronAppProcessMatchPatterns(resolvedAppPath, platform),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseElectronFloatFlags(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): ElectronFloatFlags {
  let cdpPort = DEFAULT_ELECTRON_CDP_PORT;
  let targetUrl = DEFAULT_ELECTRON_TARGET_URL;

  for (const arg of argv) {
    if (arg.startsWith('--cdp-port=')) {
      cdpPort = parsePositiveInt(arg.slice('--cdp-port='.length), DEFAULT_ELECTRON_CDP_PORT);
      continue;
    }
    if (arg.startsWith('--target-url=')) {
      const value = arg.slice('--target-url='.length).trim();
      targetUrl = value || DEFAULT_ELECTRON_TARGET_URL;
      continue;
    }
    if (!arg.startsWith('--')) {
      targetUrl = arg.trim() || DEFAULT_ELECTRON_TARGET_URL;
    }
  }

  return {
    cdpPort,
    servePort: parsePositiveInt(env['PORT'], DEFAULT_ELECTRON_SERVE_PORT),
    targetUrl,
  };
}

export function buildElectronServerSpawnConfig(
  projectRoot: string,
  options: {
    cdpPort: number;
    nodePath?: string;
  }
): ElectronServerSpawnConfig {
  return {
    command: options.nodePath ?? process.env['npm_node_execpath'] ?? 'node',
    args: [
      resolve(projectRoot, 'dist/node-server/index.js'),
      '--serve-only',
      `--cdp-port=${options.cdpPort}`,
    ],
  };
}

export const ELECTRON_FLOAT_WINDOW_BOX = {
  width: 1440,
  height: 960,
  minWidth: 1024,
  minHeight: 720,
} as const;

export interface ElectronChildWindowOptions {
  autoHideMenuBar: true;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
}

const WINDOW_OPEN_SIZE_FEATURES = new Set(['width', 'height', 'innerwidth', 'innerheight']);

export function windowOpenFeaturesRequestSize(features: string): boolean {
  for (const entry of features.split(',')) {
    const key = entry.split('=')[0]?.trim().toLowerCase();
    if (key && WINDOW_OPEN_SIZE_FEATURES.has(key)) return true;
  }
  return false;
}

export function buildElectronChildWindowOptions(features: string): ElectronChildWindowOptions {
  if (windowOpenFeaturesRequestSize(features)) return { autoHideMenuBar: true };
  return { autoHideMenuBar: true, ...ELECTRON_FLOAT_WINDOW_BOX };
}

export function getElectronServeOrigin(servePort: number): string {
  return `http://${DEFAULT_ELECTRON_SERVE_HOST}:${servePort}`;
}

export function getElectronOverlayEntryDistPath(projectRoot: string): string {
  return resolve(projectRoot, 'dist/ui/electron-overlay-entry.js');
}

export interface ElectronOverlayInjectionPayload {
  appUrl: string;
  open?: boolean;
  activeTab?: string;

  statusMessage?: string;
}

export function buildElectronOverlayInjectionCall(options: {
  appUrl: string;
  open?: boolean;
  activeTab?: string;

  statusMessage?: string;
}): string {
  const payload: ElectronOverlayInjectionPayload = {
    appUrl: options.appUrl,
  };

  if (typeof options.open === 'boolean') {
    payload.open = options.open;
  }
  if (options.activeTab) {
    payload.activeTab = options.activeTab;
  }
  if (options.statusMessage !== undefined) {
    payload.statusMessage = options.statusMessage;
  }

  const call = `window.__SLICC_ELECTRON_OVERLAY__?.inject(${JSON.stringify(payload)});`;
  return `if(document.body){${call}}else{document.addEventListener('DOMContentLoaded',function(){${call}});}`;
}

export function buildElectronOverlayBootstrapScript(options: {
  bundleSource: string;
  appUrl: string;
  open?: boolean;
  activeTab?: string;
  statusMessage?: string;
}): string {
  return `${options.bundleSource}\n${buildElectronOverlayInjectionCall(options)}`;
}

export function shouldInjectElectronOverlayTarget(target: ElectronInspectableTarget): boolean {
  if (target.type !== 'page' || !target.webSocketDebuggerUrl) return false;

  const url = target.url.trim();
  if (!url) return false;
  if (url.startsWith('devtools://')) return false;
  if (url.startsWith('chrome://')) return false;
  if (url.startsWith('chrome-extension://')) return false;

  return true;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function scoreOverlayTarget(target: ElectronInspectableTarget): number {
  let score = 0;
  const title = target.title ?? '';
  const url = target.url;

  score += Math.min(title.length, 120);

  if (url.includes('isMinimized=') || url.includes('deepLink=')) {
    score -= 200;
  }

  const hashLength = url.includes('#') ? url.length - url.indexOf('#') : 0;
  score -= Math.min(hashLength, 100);

  return score;
}

export function selectBestOverlayTargets(
  targets: ElectronInspectableTarget[]
): ElectronInspectableTarget[] {
  const injectable = targets.filter(shouldInjectElectronOverlayTarget);

  const byOrigin = new Map<string, ElectronInspectableTarget[]>();
  for (const target of injectable) {
    const origin = safeOrigin(target.url);
    const group = byOrigin.get(origin);
    if (group) {
      group.push(target);
    } else {
      byOrigin.set(origin, [target]);
    }
  }

  const result: ElectronInspectableTarget[] = [];
  for (const group of byOrigin.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    group.sort((a, b) => scoreOverlayTarget(b) - scoreOverlayTarget(a));
    result.push(group[0]);
  }

  return result;
}
