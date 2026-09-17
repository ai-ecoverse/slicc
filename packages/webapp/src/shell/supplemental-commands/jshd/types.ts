/** Restart policy persisted on a jshd unit record. */
export type JshdRestartPolicy = 'always' | 'on-failure' | 'no';

/** Live / persisted unit state shown by `jshd ls` / `status`. */
export type JshdUnitState = 'starting' | 'running' | 'stopped' | 'errored';

/**
 * Durable unit record at `/workspace/.jshd/<name>.json`.
 *
 * `argv[0]` is the resolved `.jsh` path (or skill-command name as
 * invoked); remaining entries are arguments. Boot restore relaunches
 * every record with `enabled: true`.
 */
export interface JshdUnitRecord {
  name: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  restart: JshdRestartPolicy;
  enabled: boolean;
  createdAt: string;
}

export interface JshdUnitStatus {
  name: string;
  pid: number | null;
  state: JshdUnitState;
  restarts: number;
  uptimeMs: number | null;
  enabled: boolean;
  restart: JshdRestartPolicy;
  argv: readonly string[];
  cwd: string;
  durable: boolean;
  lastExitCode: number | null;
}

export const JSHD_DIR = '/workspace/.jshd';
export const JSHD_LOG_DIR = '/workspace/.jshd/log';

export function unitRecordPath(name: string): string {
  return `${JSHD_DIR}/${name}.json`;
}

export function unitLogPath(name: string): string {
  return `${JSHD_LOG_DIR}/${name}.log`;
}

/** Unit names are path segments under `.jshd/`; `log` is the log directory. */
export const UNIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidUnitName(name: string): boolean {
  return UNIT_NAME_RE.test(name) && name !== 'log';
}

export const CRASH_LOOP_WINDOW_MS = 60_000;
export const CRASH_LOOP_MAX = 8;
export const BACKOFF_INITIAL_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
