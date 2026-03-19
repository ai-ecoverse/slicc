export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CliRuntimeFlags {
  dev: boolean;
  serveOnly: boolean;
  cdpPort: number;
  /** Whether --cdp-port was explicitly specified */
  explicitCdpPort: boolean;
  electron: boolean;
  electronApp: string | null;
  kill: boolean;
  lead: boolean;
  leadWorkerBaseUrl: string | null;
  profile: string | null;
  join: boolean;
  joinUrl: string | null;
  logLevel: LogLevel;
  logDir: string | null;
  /** Initial prompt to auto-submit when the UI loads */
  prompt: string | null;
}

export const DEFAULT_CLI_CDP_PORT = 9222;
export const DEFAULT_ELECTRON_ATTACH_CDP_PORT = 9223;

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
}

const VALID_LOG_LEVELS: Set<LogLevel> = new Set(['debug', 'info', 'warn', 'error']);

export function parseCliRuntimeFlags(argv: string[]): CliRuntimeFlags {
  let dev = false;
  let serveOnly = false;
  let cdpPort = DEFAULT_CLI_CDP_PORT;
  let explicitCdpPort = false;
  let electron = false;
  let electronApp: string | null = null;
  let kill = false;
  let lead = false;
  let leadWorkerBaseUrl: string | null = null;
  let profile: string | null = null;
  let join = false;
  let joinUrl: string | null = null;
  let logLevel: LogLevel = 'info';
  let logDir: string | null = null;
  let prompt: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === '--dev') {
      dev = true;
      continue;
    }
    if (arg === '--serve-only') {
      serveOnly = true;
      continue;
    }
    if (arg.startsWith('--cdp-port=')) {
      const value = Number.parseInt(arg.slice('--cdp-port='.length), 10);
      if (Number.isFinite(value) && value > 0) {
        cdpPort = value;
        explicitCdpPort = true;
      }
      continue;
    }
    if (arg.startsWith('--log-level=')) {
      const value = arg.slice('--log-level='.length) as LogLevel;
      if (VALID_LOG_LEVELS.has(value)) {
        logLevel = value;
      }
      continue;
    }
    if (arg.startsWith('--log-dir=')) {
      logDir = arg.slice('--log-dir='.length) || null;
      continue;
    }
    if (arg.startsWith('--prompt=')) {
      prompt = arg.slice('--prompt='.length) || null;
      continue;
    }
    if (arg === '--prompt') {
      const nextArg = argv[index + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        prompt = nextArg;
        index += 1;
      }
      continue;
    }
    if (arg === '--electron') {
      electron = true;
      const nextArg = argv[index + 1];
      if (nextArg && !nextArg.startsWith('--') && !electronApp) {
        electronApp = nextArg.trim() || null;
        index += 1;
      }
      continue;
    }
    if (arg === '--kill') {
      kill = true;
      continue;
    }
    if (arg === '--profile') {
      const nextArg = argv[index + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        profile = nextArg.trim() || null;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length).trim() || null;
      continue;
    }
    if (arg === '--lead') {
      lead = true;
      const nextArg = argv[index + 1];
      if (nextArg && !nextArg.startsWith('--') && looksLikeUrl(nextArg)) {
        leadWorkerBaseUrl = nextArg.trim() || null;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--lead=')) {
      lead = true;
      leadWorkerBaseUrl = arg.slice('--lead='.length).trim() || null;
      continue;
    }
    if (arg === '--join') {
      join = true;
      const nextArg = argv[index + 1];
      if (nextArg && !nextArg.startsWith('--') && looksLikeUrl(nextArg)) {
        joinUrl = nextArg.trim() || null;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--join=')) {
      join = true;
      joinUrl = arg.slice('--join='.length).trim() || null;
      continue;
    }
    if (arg === '--electron-app') {
      electron = true;
      const nextArg = argv[index + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        electronApp = nextArg.trim() || null;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--electron-app=')) {
      electron = true;
      electronApp = arg.slice('--electron-app='.length).trim() || null;
      continue;
    }
    if (electron && !arg.startsWith('--') && !electronApp) {
      electronApp = arg.trim() || null;
    }
  }

  if (electron && !explicitCdpPort) {
    cdpPort = DEFAULT_ELECTRON_ATTACH_CDP_PORT;
  }

  return {
    dev,
    serveOnly,
    cdpPort,
    explicitCdpPort,
    electron,
    electronApp,
    kill,
    lead,
    leadWorkerBaseUrl,
    profile,
    join,
    joinUrl,
    logLevel,
    logDir,
    prompt,
  };
}