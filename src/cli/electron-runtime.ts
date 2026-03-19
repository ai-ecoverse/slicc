import { basename, join, resolve } from 'path';
import { readdirSync, statSync } from 'fs';

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
  url: string;
  webSocketDebuggerUrl?: string;
}

export const DEFAULT_ELECTRON_SERVE_PORT = 5710;
export const DEFAULT_ELECTRON_SERVE_HOST = 'localhost';
export const DEFAULT_ELECTRON_CDP_PORT = 9223;
export const DEFAULT_ELECTRON_TARGET_URL = 'about:blank';
export const DEFAULT_ELECTRON_OVERLAY_TAB = 'chat';
export const ELECTRON_OVERLAY_APP_PATH = '/electron';

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
  platform: NodeJS.Platform = process.platform,
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
    
    // Scan MacOS directory for executable files
    // Many Electron apps use "Electron" as the executable name
    try {
      const entries = readdirSync(macOSDir);
      for (const entry of entries) {
        const entryPath = join(macOSDir, entry);
        try {
          const stat = statSync(entryPath);
          // Look for executable files (not directories, not helper scripts)
          if (stat.isFile() && !entry.endsWith('.sh') && !entry.startsWith('.')) {
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
  platform: NodeJS.Platform = process.platform,
): string[] {
  return Array.from(
    new Set([
      resolve(appPath),
      resolveElectronAppExecutablePath(appPath, platform),
    ]),
  );
}

export function buildElectronAppLaunchSpec(
  appPath: string,
  options: {
    cdpPort: number;
    platform?: NodeJS.Platform;
  },
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
  env: Record<string, string | undefined> = process.env,
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
  },
): ElectronServerSpawnConfig {
  if (options.dev) {
    return {
      command: (options.platform ?? process.platform) === 'win32' ? 'npx.cmd' : 'npx',
      args: ['tsx', 'src/cli/index.ts', '--dev', '--serve-only', `--cdp-port=${options.cdpPort}`],
    };
  }

  return {
    command: options.nodePath ?? process.env['npm_node_execpath'] ?? 'node',
    args: [resolve(projectRoot, 'dist/cli/index.js'), '--serve-only', `--cdp-port=${options.cdpPort}`],
  };
}

export function getElectronServeOrigin(servePort: number): string {
  return `http://${DEFAULT_ELECTRON_SERVE_HOST}:${servePort}`;
}

export function buildElectronOverlayAppUrl(
  serveOrigin: string,
  activeTab = DEFAULT_ELECTRON_OVERLAY_TAB,
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