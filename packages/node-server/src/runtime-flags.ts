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
  /** Download the released Go `slicc` follower CLI and exit */
  installCli: boolean;
  /** Target directory for --install-cli (default: OS-idiomatic, see install-cli.ts) */
  installDir: string | null;
  /**
   * Mount table: OS-folder → SLICC-target mappings served over the local
   * host-FS bridge (`/api/hostfs`) and auto-mounted by the webapp at boot,
   * with no picker and no Chrome permission prompt. Filled by repeatable
   * `--mount=<os-path>:<slicc-path>` / `--mount <os-path>:<slicc-path>`
   * flags. Picker-initiated (`mount <path>`) FS-Access mounts are
   * unaffected and keep asking for permission.
   */
  mounts: HostMountMapping[];
}

/** One `--mount` entry: an absolute OS folder mapped to a VFS target. */
export interface HostMountMapping {
  hostPath: string;
  path: string;
}

export const DEFAULT_CLI_CDP_PORT = 9222;
export const DEFAULT_ELECTRON_ATTACH_CDP_PORT = 9223;

/** `.`/`..` segments or empty (`//`) segments make raw != canonical. */
function hasDotOrEmptySegments(path: string): boolean {
  return path
    .split(/[/\\]/)
    .slice(1)
    .some((segment) => segment === '' || segment === '.' || segment === '..');
}

/**
 * Normalize an absolute POSIX path. Dot/empty segments are rejected rather
 * than resolved so the accepted value IS its canonical form — the webapp,
 * the /api/hostfs mount key, and VirtualFS.normalizePath all agree on it.
 */
function normalizeAbsolutePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return null;
  const stripped = trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  if (!stripped || (stripped.length > 1 && hasDotOrEmptySegments(stripped))) return null;
  return stripped;
}

/**
 * Normalize the OS side of a mapping: POSIX absolute, or a Windows drive
 * path (`C:\…` / `C:/…`) — node-server ships on Windows too.
 */
function normalizeHostPath(value: string): string | null {
  const trimmed = value.trim();
  if (/^[A-Za-z]:[/\\]/.test(trimmed)) {
    const stripped = trimmed.replace(/[/\\]+$/, '');
    // Keep the root slash on a bare drive (`C:\`).
    if (/^[A-Za-z]:$/.test(stripped)) return trimmed.slice(0, 3);
    return hasDotOrEmptySegments(stripped.slice(2)) ? null : stripped;
  }
  return normalizeAbsolutePath(trimmed);
}

/**
 * Parse a `--mount` value of the form `<os-path>:<slicc-path>`. The split is
 * on the LAST `:` whose remainder is an absolute path, so OS paths containing
 * `:` still parse. A leading `~/` on the OS side expands against `homeDir`.
 * Returns null (never a partial mapping) for anything else, so a stray
 * `--mount=` or a one-sided value never lands in the table.
 */
export function parseMountTableMapping(
  value: string,
  homeDir: string = process.env['HOME'] ?? ''
): HostMountMapping | null {
  const trimmed = value.trim();
  const sep = trimmed.lastIndexOf(':');
  if (sep <= 0) return null;
  let hostRaw = trimmed.slice(0, sep).trim();
  const targetRaw = trimmed.slice(sep + 1).trim();
  if (hostRaw === '~' || hostRaw.startsWith('~/')) {
    if (!homeDir) return null;
    hostRaw = homeDir + hostRaw.slice(1);
  }
  const hostPath = normalizeHostPath(hostRaw);
  const path = normalizeAbsolutePath(targetRaw);
  if (!hostPath || !path || path === '/') return null;
  return { hostPath, path };
}

function addMountTablePath(flags: CliRuntimeFlags, value: string): void {
  const mapping = parseMountTableMapping(value);
  if (mapping && !flags.mounts.some((m) => m.path === mapping.path)) {
    flags.mounts.push(mapping);
  }
}

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
    installCli: false,
    installDir: null,
    mounts: [],
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
  if (arg === '--install-cli') {
    flags.installCli = true;
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
  if (arg.startsWith('--install-dir=')) {
    flags.installDir = arg.slice('--install-dir='.length).trim() || null;
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
  if (arg.startsWith('--mount=')) {
    addMountTablePath(flags, arg.slice('--mount='.length));
    return true;
  }
  if (arg.startsWith('--electron-app=')) {
    flags.electron = true;
    flags.electronApp = arg.slice('--electron-app='.length).trim() || null;
    return true;
  }
  return false;
}

/** `--prompt`/`--env-file`/`--profile`/`--install-dir`/`--mount` followed by a value token. Returns tokens consumed. */
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
  } else if (arg === '--install-dir') {
    flags.installDir = next.trim() || null;
  } else if (arg === '--mount') {
    addMountTablePath(flags, next);
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
  if (
    arg === '--prompt' ||
    arg === '--env-file' ||
    arg === '--profile' ||
    arg === '--install-dir' ||
    arg === '--mount'
  ) {
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
