import { isValidUnitName, type JshdRestartPolicy, type JshdUnitRecord } from './types.js';

export type StartParseResult =
  | { ok: true; record: Omit<JshdUnitRecord, 'createdAt'> }
  | { ok: false; error: string };

const VALUE_FLAGS = new Set(['-n', '--name', '--restart', '--cwd', '--env']);
const BOOL_FLAGS = new Set(['--enable']);
const RESTART_VALUES = new Set<JshdRestartPolicy>(['always', 'on-failure', 'no']);

/**
 * Parse `jshd start` flags. `--env` is repeatable; everything after the
 * script token is unit argv. `--` ends option parsing so a script whose
 * name starts with a dash stays reachable.
 */
interface StartDraft {
  name?: string;
  restart: JshdRestartPolicy;
  enabled: boolean;
  cwd: string;
  env: Record<string, string>;
  positionals: string[];
}

export function parseStartArgs(
  args: readonly string[],
  defaults: { cwd: string; env: ReadonlyMap<string, string> }
): StartParseResult {
  const draft: StartDraft = {
    restart: 'always',
    enabled: false,
    cwd: defaults.cwd,
    env: {},
    positionals: [],
  };
  const scanned = scanStartTokens(args, defaults.cwd, draft);
  if (!scanned.ok) return scanned;
  if (draft.positionals.length === 0) {
    return { ok: false, error: 'missing script.jsh or skill-command' };
  }
  const script = draft.positionals[0];
  const resolvedName = draft.name ?? defaultNameFromScript(script);
  if (!isValidUnitName(resolvedName)) {
    return {
      ok: false,
      error: `invalid unit name '${resolvedName}' (use letters, digits, '.', '_' or '-')`,
    };
  }
  return {
    ok: true,
    record: {
      name: resolvedName,
      argv: [script, ...draft.positionals.slice(1)],
      cwd: draft.cwd,
      env: draft.env,
      restart: draft.restart,
      enabled: draft.enabled,
    },
  };
}

function scanStartTokens(
  args: readonly string[],
  defaultCwd: string,
  draft: StartDraft
): { ok: true } | { ok: false; error: string } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      draft.positionals.push(...args.slice(i + 1));
      return { ok: true };
    }
    if (draft.positionals.length > 0 || isPositionalToken(arg)) {
      draft.positionals.push(arg);
      continue;
    }
    const applied = applyStartFlag(arg, args, i, defaultCwd, draft);
    if (!applied.ok) return applied;
    i = applied.index;
  }
  return { ok: true };
}

function isPositionalToken(arg: string): boolean {
  return arg === '-' || !arg.startsWith('-') || /^-[\d.]+$/.test(arg);
}

function applyStartFlag(
  arg: string,
  args: readonly string[],
  index: number,
  defaultCwd: string,
  draft: StartDraft
): { ok: true; index: number } | { ok: false; error: string } {
  const eq = arg.indexOf('=');
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  if (BOOL_FLAGS.has(flag)) {
    if (eq !== -1) return { ok: false, error: `${flag} does not take a value` };
    draft.enabled = true;
    return { ok: true, index };
  }
  if (!VALUE_FLAGS.has(flag)) return { ok: false, error: `unknown flag: ${flag}` };
  const value = eq === -1 ? args[index + 1] : arg.slice(eq + 1);
  if (value === undefined) return { ok: false, error: `${flag} requires a value` };
  const error = setStartValue(flag, value, defaultCwd, draft);
  if (error) return { ok: false, error };
  return { ok: true, index: eq === -1 ? index + 1 : index };
}

function setStartValue(
  flag: string,
  value: string,
  defaultCwd: string,
  draft: StartDraft
): string | null {
  if (flag === '-n' || flag === '--name') {
    draft.name = value;
    return null;
  }
  if (flag === '--restart') {
    if (!RESTART_VALUES.has(value as JshdRestartPolicy)) {
      return `--restart must be always, on-failure, or no`;
    }
    draft.restart = value as JshdRestartPolicy;
    return null;
  }
  if (flag === '--cwd') {
    draft.cwd = value.startsWith('/') ? value : joinPath(defaultCwd, value);
    return null;
  }
  const eqIdx = value.indexOf('=');
  if (eqIdx <= 0) return `--env requires K=V`;
  draft.env[value.slice(0, eqIdx)] = value.slice(eqIdx + 1);
  return null;
}

export function defaultNameFromScript(script: string): string {
  const base = script.split('/').pop() ?? script;
  const stripped = base.replace(/\.jsh$/i, '').replace(/^[^A-Za-z0-9]+/, '');
  return stripped || 'unit';
}

function joinPath(base: string, rel: string): string {
  if (base === '/') return `/${rel}`;
  return `${base.replace(/\/+$/, '')}/${rel}`;
}
