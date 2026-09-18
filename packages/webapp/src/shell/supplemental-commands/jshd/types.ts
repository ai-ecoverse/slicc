export type JshdRestartPolicy = 'always' | 'on-failure' | 'no';

export type JshdUnitState = 'starting' | 'running' | 'stopped' | 'errored';

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

export const UNIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidUnitName(name: string): boolean {
  return UNIT_NAME_RE.test(name) && name !== 'log';
}

export function assertValidUnitName(name: string): void {
  if (!isValidUnitName(name)) {
    throw new Error(`invalid unit name '${name}' (use letters, digits, '.', '_' or '-')`);
  }
}

export function unitRecordPath(name: string): string {
  assertValidUnitName(name);
  return `${JSHD_DIR}/${name}.json`;
}

export function unitLogPath(name: string): string {
  assertValidUnitName(name);
  return `${JSHD_LOG_DIR}/${name}.log`;
}

export const CRASH_LOOP_WINDOW_MS = 60_000;
export const CRASH_LOOP_MAX = 8;
export const BACKOFF_INITIAL_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
