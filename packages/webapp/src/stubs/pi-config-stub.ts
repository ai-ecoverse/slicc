/**
 * Browser-safe stub for @mariozechner/pi-coding-agent/dist/config.js
 *
 * config.js uses fileURLToPath(import.meta.url) at the top level which
 * crashes in the browser. The webapp never calls any of these functions;
 * they're only pulled in as transitive dependencies of session-manager.js.
 *
 * See: packages/webapp/vite.config.ts (stub-pi-node-internals plugin)
 */

export const VERSION = '0.0.0-browser-stub';
export const APP_NAME = 'pi';
export const CONFIG_DIR_NAME = '.pi';
export const ENV_AGENT_DIR = 'PI_CODING_AGENT_DIR';
export const isBunBinary = false;
export const isBunRuntime = false;

export function detectInstallMethod(): string {
  return 'browser';
}

export function getUpdateInstruction(): string {
  return 'Not available in browser';
}

export function getPackageDir(): never {
  throw new Error('getPackageDir is not available in the browser');
}

export function getThemesDir(): never {
  throw new Error('getThemesDir is not available in the browser');
}

export function getExportTemplateDir(): never {
  throw new Error('getExportTemplateDir is not available in the browser');
}

export function getPackageJsonPath(): never {
  throw new Error('getPackageJsonPath is not available in the browser');
}

export function getReadmePath(): never {
  throw new Error('getReadmePath is not available in the browser');
}

export function getDocsPath(): never {
  throw new Error('getDocsPath is not available in the browser');
}

export function getExamplesPath(): never {
  throw new Error('getExamplesPath is not available in the browser');
}

export function getChangelogPath(): never {
  throw new Error('getChangelogPath is not available in the browser');
}

export function getShareViewerUrl(): string {
  return '';
}

export function getAgentDir(): never {
  throw new Error('getAgentDir is not available in the browser');
}

export function getCustomThemesDir(): never {
  throw new Error('getCustomThemesDir is not available in the browser');
}

export function getModelsPath(): never {
  throw new Error('getModelsPath is not available in the browser');
}

export function getAuthPath(): never {
  throw new Error('getAuthPath is not available in the browser');
}

export function getSettingsPath(): never {
  throw new Error('getSettingsPath is not available in the browser');
}

export function getToolsDir(): never {
  throw new Error('getToolsDir is not available in the browser');
}

export function getBinDir(): never {
  throw new Error('getBinDir is not available in the browser');
}

export function getPromptsDir(): never {
  throw new Error('getPromptsDir is not available in the browser');
}

export function getSessionsDir(): never {
  throw new Error('getSessionsDir is not available in the browser');
}

export function getDebugLogPath(): never {
  throw new Error('getDebugLogPath is not available in the browser');
}
