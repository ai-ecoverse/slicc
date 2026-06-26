export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CliRuntimeFlags {
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
  /** Path to a .env file for secrets */
  envFile: string | null;
  version: boolean;
  hosted: boolean;
}

export const DEFAULT_CLI_CDP_PORT = 9222;
export const DEFAULT_ELECTRON_ATTACH_CDP_PORT = 9223;

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
}

const VALID_LOG_LEVELS: Set<LogLevel> = new Set(['debug', 'info', 'warn', 'error']);

function createDefaultFlags(): CliRuntimeFlags {
  return {
    serveOnly: false,
    cdpPort: DEFAULT_CLI_CDP_PORT,
    explicitCdpPort: false,
    electron: false,
    electronApp: null,
    kill: false,
    lead: false,
    leadWorkerBaseUrl: null,
    profile: null,
    join: false,
    joinUrl: null,
    logLevel: 'info',
    logDir: null,
    prompt: null,
    envFile: null,
    version: false,
    hosted: false,
  };
}

/** Next argv entry, but only when it exists and is not itself a `--` flag. */
function nextValueArg(argv: string[], index: number): string | null {
  const nextArg = argv[index + 1];
  return nextArg && !nextArg.startsWith('--') ? nextArg : null;
}

/** Bare boolean flags that consume no following token. Returns whether handled. */
function applySimpleFlag(flags: CliRuntimeFlags, arg: string): boolean {
  if (arg === 'version' || arg === '--version' || arg === '-v') {
    flags.version = true;
    return true;
  }
  if (arg === '--serve-only') {
    flags.serveOnly = true;
    return true;
  }
  if (arg === '--hosted') {
    flags.hosted = true;
    return true;
  }
  if (arg === '--kill') {
    flags.kill = true;
    return true;
  }
  return false;
}

/** `--flag=value` style flags that consume no following token. Returns whether handled. */
function applyEqualsFlag(flags: CliRuntimeFlags, arg: string): boolean {
  if (arg.startsWith('--cdp-port=')) {
    const value = Number.parseInt(arg.slice('--cdp-port='.length), 10);
    if (Number.isFinite(value) && value > 0) {
      flags.cdpPort = value;
      flags.explicitCdpPort = true;
    }
    return true;
  }
  if (arg.startsWith('--log-level=')) {
    const value = arg.slice('--log-level='.length) as LogLevel;
    if (VALID_LOG_LEVELS.has(value)) {
      flags.logLevel = value;
    }
    return true;
  }
  if (arg.startsWith('--log-dir=')) {
    flags.logDir = arg.slice('--log-dir='.length) || null;
    return true;
  }
  if (arg.startsWith('--prompt=')) {
    flags.prompt = arg.slice('--prompt='.length) || null;
    return true;
  }
  if (arg.startsWith('--env-file=')) {
    flags.envFile = arg.slice('--env-file='.length) || null;
    return true;
  }
  if (arg.startsWith('--profile=')) {
    flags.profile = arg.slice('--profile='.length).trim() || null;
    return true;
  }
  if (arg.startsWith('--lead=')) {
    flags.lead = true;
    flags.leadWorkerBaseUrl = arg.slice('--lead='.length).trim() || null;
    return true;
  }
  if (arg.startsWith('--join=')) {
    flags.join = true;
    flags.joinUrl = arg.slice('--join='.length).trim() || null;
    return true;
  }
  if (arg.startsWith('--electron-app=')) {
    flags.electron = true;
    flags.electronApp = arg.slice('--electron-app='.length).trim() || null;
    return true;
  }
  return false;
}

/** `--prompt`/`--env-file`/`--profile` followed by a value token. Returns tokens consumed. */
function applyPlainValueFlag(
  flags: CliRuntimeFlags,
  argv: string[],
  index: number,
  arg: string
): number {
  const next = nextValueArg(argv, index);
  if (next === null) {
    return 0;
  }
  if (arg === '--prompt') {
    flags.prompt = next;
  } else if (arg === '--env-file') {
    flags.envFile = next;
  } else {
    flags.profile = next.trim() || null;
  }
  return 1;
}

/** `--lead`/`--join` followed by a URL-looking value token. Returns tokens consumed. */
function applyUrlFlag(flags: CliRuntimeFlags, argv: string[], index: number, arg: string): number {
  const isLead = arg === '--lead';
  if (isLead) {
    flags.lead = true;
  } else {
    flags.join = true;
  }
  const next = nextValueArg(argv, index);
  if (next === null || !looksLikeUrl(next)) {
    return 0;
  }
  const value = next.trim() || null;
  if (isLead) {
    flags.leadWorkerBaseUrl = value;
  } else {
    flags.joinUrl = value;
  }
  return 1;
}

/** `--electron`/`--electron-app` followed by an app-path value token. Returns tokens consumed. */
function applyElectronFlag(
  flags: CliRuntimeFlags,
  argv: string[],
  index: number,
  arg: string
): number {
  flags.electron = true;
  const next = nextValueArg(argv, index);
  if (next === null) {
    return 0;
  }
  if (arg === '--electron' && flags.electronApp) {
    return 0;
  }
  flags.electronApp = next.trim() || null;
  return 1;
}

/** Bare positional arg captured as the electron app path when applicable. */
function applyPositional(flags: CliRuntimeFlags, arg: string): void {
  if (flags.electron && !arg.startsWith('--') && !flags.electronApp) {
    flags.electronApp = arg.trim() || null;
  }
}

/** Value-consuming flags plus the positional fallback. Returns extra tokens consumed. */
function applyValueFlag(
  flags: CliRuntimeFlags,
  argv: string[],
  index: number,
  arg: string
): number {
  if (arg === '--prompt' || arg === '--env-file' || arg === '--profile') {
    return applyPlainValueFlag(flags, argv, index, arg);
  }
  if (arg === '--lead' || arg === '--join') {
    return applyUrlFlag(flags, argv, index, arg);
  }
  if (arg === '--electron' || arg === '--electron-app') {
    return applyElectronFlag(flags, argv, index, arg);
  }
  applyPositional(flags, arg);
  return 0;
}

/** Dispatch a single token. Returns the number of additional argv entries consumed. */
function applyToken(flags: CliRuntimeFlags, argv: string[], index: number): number {
  const arg = argv[index]!;
  if (applySimpleFlag(flags, arg)) {
    return 0;
  }
  if (applyEqualsFlag(flags, arg)) {
    return 0;
  }
  return applyValueFlag(flags, argv, index, arg);
}

export function parseCliRuntimeFlags(argv: string[]): CliRuntimeFlags {
  const flags = createDefaultFlags();

  for (let index = 0; index < argv.length; index += 1) {
    index += applyToken(flags, argv, index);
  }

  if (flags.electron && !flags.explicitCdpPort) {
    flags.cdpPort = DEFAULT_ELECTRON_ATTACH_CDP_PORT;
  }

  return flags;
}
