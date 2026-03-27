import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/**
 * Find the Playwright WebKit binary path.
 *
 * Resolution order:
 * 1. WEBKIT_PATH environment variable (set by Sliccstart)
 * 2. Auto-detect from ~/Library/Caches/ms-playwright/webkit-*\/Playwright.app/Contents/MacOS/Playwright
 */
export function findWebKitExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  // 1. Environment variable (set by Sliccstart)
  const envPath = env['WEBKIT_PATH'];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // 2. Auto-detect from Playwright cache
  const cacheRoot = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  let entries: string[];
  try {
    entries = readdirSync(cacheRoot);
  } catch {
    return null;
  }

  // Find webkit-* directories, sorted newest first
  const webkitDirs = entries
    .filter((e) => e.startsWith('webkit-'))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  for (const dir of webkitDirs) {
    const candidate = join(cacheRoot, dir, 'Playwright.app', 'Contents', 'MacOS', 'Playwright');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Resolve the framework directory from a WebKit binary path.
 * The DYLD_FRAMEWORK_PATH and DYLD_LIBRARY_PATH should point to the
 * directory containing the WebKit frameworks.
 *
 * For Playwright's WebKit: the frameworks live alongside the binary
 * inside the .app bundle, or in the parent Frameworks directory.
 */
export function resolveWebKitFrameworkPath(binaryPath: string): string {
  // For Playwright.app: Contents/MacOS/Playwright → Contents/Frameworks
  const macosDir = dirname(binaryPath);
  const contentsDir = dirname(macosDir);
  const frameworksDir = join(contentsDir, 'Frameworks');
  if (existsSync(frameworksDir)) {
    return frameworksDir;
  }
  // Fallback: same directory as the binary
  return macosDir;
}

export interface WebKitLaunchResult {
  child: ChildProcess;
  /** Writable pipe (fd 3) for sending messages to WebKit */
  writable: NodeJS.WritableStream;
  /** Readable pipe (fd 4) for receiving messages from WebKit */
  readable: NodeJS.ReadableStream;
}

/**
 * Spawn the Playwright WebKit binary with inspector pipe enabled.
 *
 * stdio layout:
 *   0 = stdin  (pipe)
 *   1 = stdout (pipe)
 *   2 = stderr (pipe)
 *   3 = inspector write pipe (parent → WebKit)
 *   4 = inspector read pipe  (WebKit → parent)
 */
export function spawnWebKit(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env
): WebKitLaunchResult {
  const frameworkPath = env['DYLD_FRAMEWORK_PATH'] ?? resolveWebKitFrameworkPath(binaryPath);

  const child = spawn(binaryPath, ['--inspector-pipe', '--no-startup-window'], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    detached: false,
    env: {
      ...env,
      DYLD_FRAMEWORK_PATH: frameworkPath,
      DYLD_LIBRARY_PATH: env['DYLD_LIBRARY_PATH'] ?? frameworkPath,
    },
  });

  // fd 3 = writable (parent writes to WebKit), fd 4 = readable (parent reads from WebKit)
  const writable = child.stdio[3] as NodeJS.WritableStream;
  const readable = child.stdio[4] as NodeJS.ReadableStream;

  if (!writable || !readable) {
    child.kill();
    throw new Error('Failed to create WebKit inspector pipes (stdio[3] or stdio[4] is null)');
  }

  return { child, writable, readable };
}
