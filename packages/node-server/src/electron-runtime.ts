import { basename, join, resolve } from 'path';
import { accessSync, constants, readdirSync, statSync } from 'fs';

export interface ElectronFloatFlags {
  dev: boolean;
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
  type: string;
  title?: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export const DEFAULT_ELECTRON_SERVE_PORT = 5710;
export const DEFAULT_ELECTRON_SERVE_HOST = 'localhost';
export const DEFAULT_ELECTRON_CDP_PORT = 9223;
export const DEFAULT_ELECTRON_TARGET_URL = 'about:blank';
export const DEFAULT_ELECTRON_OVERLAY_TAB = 'chat';
export const ELECTRON_OVERLAY_APP_PATH = '/electron';

// Port allocation constants
export const PORT_HASH_RANGE = 40;

/**
 * Simple string hash function that returns a value between 0 and max-1.
 * Exported for testing.
 */
export function hashString(str: string, max: number): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash) % max;
}

/**
 * Try to listen on a specific port and host, returning the assigned port.
 */
async function tryListenOnPort(port: number, host: string): Promise<number> {
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

/**
 * Check if a port is available on both IPv4 (127.0.0.1) and IPv6 (::1).
 * On macOS, `localhost` resolves to `::1`, so we need to check both.
 */
async function isPortAvailable(port: number): Promise<boolean> {
  try {
    await tryListenOnPort(port, '127.0.0.1');
    try {
      await tryListenOnPort(port, '::1');
    } catch (err: unknown) {
      // ::1 may not be available on some systems — only fail on EADDRINUSE
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an available port starting from the given port.
 */
async function findAvailablePort(startPort: number, maxAttempts = 100): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Could not find available port starting from ${startPort}`);
}

/**
 * Get a port for an Electron app based on its path.
 * Uses hash-based offset from base port, with fallback to next available port
 * starting from the preferred port (to stay in the app's "slot" range).
 */
export async function getElectronAppPort(appPath: string, basePort: number): Promise<number> {
  const offset = hashString(appPath, PORT_HASH_RANGE);
  const preferredPort = basePort + offset;

  if (await isPortAvailable(preferredPort)) {
    return preferredPort;
  }

  // Fallback: find next available port starting from preferred (stay in slot range)
  return findAvailablePort(preferredPort + 1);
}

/**
 * Get both CDP and serve ports for an Electron app.
 */
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

export function resolveElectronAppExecutablePath(
  appPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const resolvedAppPath = resolve(appPath);

  if (platform === 'darwin' && resolvedAppPath.toLowerCase().endsWith('.app')) {
    const macOSDir = join(resolvedAppPath, 'Contents', 'MacOS');

    // First try the expected name (app name without .app)
    const expectedName = getElectronAppDisplayName(resolvedAppPath);
    const expectedPath = join(macOSDir, expectedName);
    try {
      const stat = statSync(expectedPath);
      if (stat.isFile()) {
        return expectedPath;
      }
    } catch {
      // Expected path doesn't exist, scan the directory
    }

    // Scan MacOS directory for the main executable
    // Many Electron apps use "Electron" as the executable name
    // Prefer known main executable names, filter out helper processes
    const helperPatterns = [/helper/i, /crash/i, /gpu/i, /renderer/i, /plugin/i, /utility/i];
    try {
      const entries = readdirSync(macOSDir);

      // Helper to check if a file is executable
      const isExecutable = (path: string): boolean => {
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      };

      // First pass: look for "Electron" executable (common in Electron apps)
      if (entries.includes('Electron')) {
        const electronPath = join(macOSDir, 'Electron');
        try {
          const stat = statSync(electronPath);
          if (stat.isFile() && isExecutable(electronPath)) {
            return electronPath;
          }
        } catch {
          // Continue to next fallback
        }
      }

      // Second pass: find first non-helper executable with execute permission
      for (const entry of entries) {
        // Skip hidden files, scripts, and helper executables
        if (entry.startsWith('.') || entry.endsWith('.sh')) continue;
        if (helperPatterns.some((p) => p.test(entry))) continue;

        const entryPath = join(macOSDir, entry);
        try {
          const stat = statSync(entryPath);
          if (stat.isFile() && isExecutable(entryPath)) {
            return entryPath;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Can't read directory, fall back to expected path
    }

    // Fall back to expected path even if it doesn't exist
    // (error will be caught later)
    return expectedPath;
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
  let dev = false;
  let cdpPort = DEFAULT_ELECTRON_CDP_PORT;
  let targetUrl = DEFAULT_ELECTRON_TARGET_URL;

  for (const arg of argv) {
    if (arg === '--dev') {
      dev = true;
      continue;
    }
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
    dev,
    cdpPort,
    servePort: parsePositiveInt(env['PORT'], DEFAULT_ELECTRON_SERVE_PORT),
    targetUrl,
  };
}

export function buildElectronServerSpawnConfig(
  projectRoot: string,
  options: {
    dev: boolean;
    cdpPort: number;
    platform?: NodeJS.Platform;
    nodePath?: string;
  }
): ElectronServerSpawnConfig {
  if (options.dev) {
    return {
      command: (options.platform ?? process.platform) === 'win32' ? 'npx.cmd' : 'npx',
      args: [
        'tsx',
        'packages/node-server/src/index.ts',
        '--dev',
        '--serve-only',
        `--cdp-port=${options.cdpPort}`,
      ],
    };
  }

  return {
    command: options.nodePath ?? process.env['npm_node_execpath'] ?? 'node',
    args: [
      resolve(projectRoot, 'dist/node-server/index.js'),
      '--serve-only',
      `--cdp-port=${options.cdpPort}`,
    ],
  };
}

export function getElectronServeOrigin(servePort: number): string {
  return `http://${DEFAULT_ELECTRON_SERVE_HOST}:${servePort}`;
}

export function buildElectronOverlayAppUrl(
  serveOrigin: string,
  activeTab = DEFAULT_ELECTRON_OVERLAY_TAB
): string {
  const url = new URL(ELECTRON_OVERLAY_APP_PATH, serveOrigin);
  if (activeTab && activeTab !== DEFAULT_ELECTRON_OVERLAY_TAB) {
    url.searchParams.set('tab', activeTab);
  }
  return url.toString();
}

export function buildElectronOverlayEntryUrl(serveOrigin: string): string {
  return new URL('/electron-overlay-entry.js', serveOrigin).toString();
}

export function getElectronOverlayEntryDistPath(projectRoot: string): string {
  return resolve(projectRoot, 'dist/ui/electron-overlay-entry.js');
}

export function buildElectronOverlayInjectionCall(options: {
  appUrl: string;
  open?: boolean;
  activeTab?: string;
}): string {
  const payload: Record<string, unknown> = {
    appUrl: options.appUrl,
  };

  if (typeof options.open === 'boolean') {
    payload['open'] = options.open;
  }
  if (options.activeTab) {
    payload['activeTab'] = options.activeTab;
  }

  // Wait for document.body before injecting — Runtime.evaluate and
  // addScriptToEvaluateOnNewDocument can fire before the DOM is ready.
  const call = `window.__SLICC_ELECTRON_OVERLAY__?.inject(${JSON.stringify(payload)});`;
  return `if(document.body){${call}}else{document.addEventListener('DOMContentLoaded',function(){${call}});}`;
}

export function buildElectronOverlayBootstrapScript(options: {
  bundleSource: string;
  appUrl: string;
  open?: boolean;
  activeTab?: string;
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

/**
 * Extract the origin from a URL, or return the URL as-is for non-standard schemes.
 */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Score a target for "primary window" ranking within a group of same-origin pages.
 * Higher score = more likely the main content window.
 */
function scoreOverlayTarget(target: ElectronInspectableTarget): number {
  let score = 0;
  const title = target.title ?? '';
  const url = target.url;

  // Longer, more descriptive titles indicate content windows (e.g.
  // "Calendar | Adobe | Microsoft Teams" vs generic "Microsoft Teams")
  score += Math.min(title.length, 120);

  // Penalize URLs with hash fragments that suggest hidden/auxiliary windows
  // (e.g. Teams uses #deepLink=default&isMinimized=false for background windows)
  if (url.includes('isMinimized=') || url.includes('deepLink=')) {
    score -= 200;
  }

  // Prefer clean URLs without large hash fragments (shell pages often have them)
  const hashLength = url.includes('#') ? url.length - url.indexOf('#') : 0;
  score -= Math.min(hashLength, 100);

  return score;
}

/**
 * From a list of injectable targets, select the best target per origin.
 * Multi-window apps (like Teams) expose several page targets for the same origin;
 * we only want to inject the overlay into the primary content window.
 */
export function selectBestOverlayTargets(
  targets: ElectronInspectableTarget[]
): ElectronInspectableTarget[] {
  const injectable = targets.filter(shouldInjectElectronOverlayTarget);

  // Group by origin
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

  // Pick the best target from each origin group
  const result: ElectronInspectableTarget[] = [];
  for (const group of byOrigin.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    // Sort by score descending and pick the winner
    group.sort((a, b) => scoreOverlayTarget(b) - scoreOverlayTarget(a));
    result.push(group[0]);
  }

  return result;
}
