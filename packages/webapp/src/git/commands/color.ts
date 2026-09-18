import { allGitValueFlagNames } from './shared.js';

export type GitColorWhen = 'always' | 'never' | 'auto';

const NEVER_WORDS = new Set(['never', 'false', '0', 'off', 'no']);
const ALWAYS_WORDS = new Set(['always', 'true', '1', 'on', 'yes']);
const FLAG_RE = /^(--?)([^=]+)(=.*)?$/;
const VALUE_FLAG_NAMES = allGitValueFlagNames();

export function parseColorWhen(value: unknown): GitColorWhen | undefined {
  if (value === false) return 'never';
  if (value === true) return 'always';
  if (typeof value === 'number') {
    if (value === 0) return 'never';
    if (value === 1) return 'always';
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const v = value.toLowerCase();
  if (v === 'never' || v === 'false' || v === '0' || v === 'off' || v === 'no') return 'never';
  if (v === 'always' || v === 'true' || v === '1' || v === 'on' || v === 'yes') return 'always';
  if (v === 'auto') return 'auto';
  return undefined;
}

export function colorWhenFromArgs(args: readonly string[]): GitColorWhen | undefined {
  let when: GitColorWhen | undefined;
  const terminator = args.indexOf('--');
  const head = terminator === -1 ? args : args.slice(0, terminator);
  for (let i = 0; i < head.length; i++) {
    if (isValueOfPrecedingFlag(head, i)) continue;
    const tok = head[i];
    if (tok === '--no-color') {
      when = 'never';
      continue;
    }
    if (tok === '--color') {
      when = 'always';
      continue;
    }
    if (tok.startsWith('--color=')) {
      when = parseColorWhen(tok.slice('--color='.length)) ?? when;
    }
  }
  return when;
}

export function normalizeGitColorArgs(args: readonly string[]): string[] {
  const terminator = args.indexOf('--');
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (terminator !== -1 && i >= terminator) {
      out.push(...args.slice(i));
      break;
    }
    const tok = args[i];
    if (isValueOfPrecedingFlag(args, i, terminator)) {
      out.push(tok);
      continue;
    }
    if (tok.startsWith('--color=')) {
      const rewritten = rewriteColorWhen(tok.slice('--color='.length));
      if (rewritten) out.push(rewritten);
      continue;
    }
    out.push(tok);
  }
  return out;
}

function isValueOfPrecedingFlag(args: readonly string[], index: number, terminator = -1): boolean {
  if (index === 0) return false;
  if (terminator !== -1 && index - 1 >= terminator) return false;
  const prev = args[index - 1];
  const m = FLAG_RE.exec(prev);
  if (!m || m[3]) return false;
  return VALUE_FLAG_NAMES.has(m[2]);
}

function rewriteColorWhen(raw: string): '--color' | '--no-color' | undefined {
  const when = raw.toLowerCase();
  if (NEVER_WORDS.has(when)) return '--no-color';
  if (ALWAYS_WORDS.has(when)) return '--color';
  return undefined;
}

export interface ResolveGitColorOpts {
  cliWhen?: GitColorWhen;

  colorUi?: string;

  noColorEnv: boolean;

  stdoutIsTTY: boolean;

  term?: string;
}

export function resolveGitColor(opts: ResolveGitColorOpts): boolean {
  const auto = opts.stdoutIsTTY && opts.term !== 'dumb';
  const fromWhen = (when: GitColorWhen | undefined): boolean | undefined => {
    if (when === 'always') return true;
    if (when === 'never') return false;
    if (when === 'auto') return auto;
    return undefined;
  };
  const cli = fromWhen(opts.cliWhen);
  if (cli !== undefined) return cli;
  const ui = fromWhen(parseColorWhen(opts.colorUi));
  if (ui !== undefined) return ui;
  if (opts.noColorEnv) return false;
  return auto;
}

export function sgr(enabled: boolean, code: string, text: string): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}
