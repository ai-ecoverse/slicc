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
  substrate: boolean;
}

export const DEFAULT_CLI_CDP_PORT = 9222;
export const DEFAULT_ELECTRON_ATTACH_CDP_PORT = 9223;

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
}

const VALID_LOG_LEVELS: Set<LogLevel> = new Set(['debug', 'info', 'warn', 'error']);

function validateMutualExclusions(substrate: boolean, hosted: boolean): void {
  if (substrate && hosted) {
    throw new Error('--substrate cannot be combined with --hosted');
  }
}

function defaultFlags(): CliRuntimeFlags {
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
    substrate: false,
  };
}

/** Bare boolean switches: exact arg → field setter. */
const BOOLEAN_FLAGS: Record<string, (f: CliRuntimeFlags) => void> = {
  version: (f) => {
    f.version = true;
  },
  '--version': (f) => {
    f.version = true;
  },
  '-v': (f) => {
    f.version = true;
  },
  '--serve-only': (f) => {
    f.serveOnly = true;
  },
  '--hosted': (f) => {
    f.hosted = true;
  },
  '--substrate': (f) => {
    f.substrate = true;
  },
  '--kill': (f) => {
    f.kill = true;
  },
};

/**
 * `--key value` flags (space-separated). The handler applies the value and
 * returns `true` iff it consumed the following argv token, so the caller can
 * advance the index. Each sets its boolean eagerly (matching the legacy
 * behavior) before deciding whether the next token is a usable value.
 */
const NEXT_ARG_FLAGS: Record<string, (f: CliRuntimeFlags, nextArg: string | undefined) => boolean> =
  {
    '--prompt': (f, n) => {
      if (n && !n.startsWith('--')) {
        f.prompt = n;
        return true;
      }
      return false;
    },
    '--env-file': (f, n) => {
      if (n && !n.startsWith('--')) {
        f.envFile = n;
        return true;
      }
      return false;
    },
    '--profile': (f, n) => {
      if (n && !n.startsWith('--')) {
        f.profile = n.trim() || null;
        return true;
      }
      return false;
    },
    '--electron': (f, n) => {
      f.electron = true;
      if (n && !n.startsWith('--') && !f.electronApp) {
        f.electronApp = n.trim() || null;
        return true;
      }
      return false;
    },
    '--electron-app': (f, n) => {
      f.electron = true;
      if (n && !n.startsWith('--')) {
        f.electronApp = n.trim() || null;
        return true;
      }
      return false;
    },
    '--lead': (f, n) => {
      f.lead = true;
      if (n && !n.startsWith('--') && looksLikeUrl(n)) {
        f.leadWorkerBaseUrl = n.trim() || null;
        return true;
      }
      return false;
    },
    '--join': (f, n) => {
      f.join = true;
      if (n && !n.startsWith('--') && looksLikeUrl(n)) {
        f.joinUrl = n.trim() || null;
        return true;
      }
      return false;
    },
  };

/** `--key=value` flags: prefix → apply the substring after the `=`. */
const VALUE_FLAGS: ReadonlyArray<{
  prefix: string;
  apply: (f: CliRuntimeFlags, value: string) => void;
}> = [
  {
    prefix: '--cdp-port=',
    apply: (f, v) => {
      const value = Number.parseInt(v, 10);
      if (Number.isFinite(value) && value > 0) {
        f.cdpPort = value;
        f.explicitCdpPort = true;
      }
    },
  },
  {
    prefix: '--log-level=',
    apply: (f, v) => {
      if (VALID_LOG_LEVELS.has(v as LogLevel)) f.logLevel = v as LogLevel;
    },
  },
  {
    prefix: '--log-dir=',
    apply: (f, v) => {
      f.logDir = v || null;
    },
  },
  {
    prefix: '--prompt=',
    apply: (f, v) => {
      f.prompt = v || null;
    },
  },
  {
    prefix: '--env-file=',
    apply: (f, v) => {
      f.envFile = v || null;
    },
  },
  {
    prefix: '--profile=',
    apply: (f, v) => {
      f.profile = v.trim() || null;
    },
  },
  {
    prefix: '--lead=',
    apply: (f, v) => {
      f.lead = true;
      f.leadWorkerBaseUrl = v.trim() || null;
    },
  },
  {
    prefix: '--join=',
    apply: (f, v) => {
      f.join = true;
      f.joinUrl = v.trim() || null;
    },
  },
  {
    prefix: '--electron-app=',
    apply: (f, v) => {
      f.electron = true;
      f.electronApp = v.trim() || null;
    },
  },
];

/**
 * Apply a single argv token to `flags`. Returns the number of EXTRA tokens
 * consumed (0, or 1 for a `--key value` flag that swallowed its value), so the
 * caller advances the loop index accordingly. Dispatch via lookup tables keeps
 * each path flat — the old ~24-branch if-chain is now data, not control flow.
 */
function applyArg(flags: CliRuntimeFlags, arg: string, nextArg: string | undefined): number {
  const boolHandler = BOOLEAN_FLAGS[arg];
  if (boolHandler) {
    boolHandler(flags);
    return 0;
  }
  const nextHandler = NEXT_ARG_FLAGS[arg];
  if (nextHandler) {
    return nextHandler(flags, nextArg) ? 1 : 0;
  }
  const valueFlag = VALUE_FLAGS.find((v) => arg.startsWith(v.prefix));
  if (valueFlag) {
    valueFlag.apply(flags, arg.slice(valueFlag.prefix.length));
    return 0;
  }
  // Bare positional after `--electron` (e.g. `--electron /Applications/Slack.app`).
  if (flags.electron && !arg.startsWith('--') && !flags.electronApp) {
    flags.electronApp = arg.trim() || null;
  }
  return 0;
}

export function parseCliRuntimeFlags(argv: string[]): CliRuntimeFlags {
  const flags = defaultFlags();

  for (let index = 0; index < argv.length; index += 1) {
    index += applyArg(flags, argv[index]!, argv[index + 1]);
  }

  if (flags.electron && !flags.explicitCdpPort) {
    flags.cdpPort = DEFAULT_ELECTRON_ATTACH_CDP_PORT;
  }

  validateMutualExclusions(flags.substrate, flags.hosted);

  return flags;
}
