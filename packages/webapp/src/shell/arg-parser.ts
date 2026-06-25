/**
 * Shared command argument parser.
 *
 * A small typed wrapper over `mri` that adds the three things `mri` lacks but
 * CLI surfaces in this repo need: a `--` terminator that yields the trailing
 * tokens separately, `stopEarly` (parse only the leading flags, leave the rest
 * positional — used for `git <global-flags> <subcommand> …`), and
 * value-shadowing (a value-taking flag consumes its next token even when that
 * token looks like a flag, e.g. `commit -m --help` → message is `--help`).
 *
 * It is intentionally generic so other shells (git, USB/HID/Serial, …) share
 * one walk instead of hand-rolling flag tables.
 */

import mri from 'mri';

export interface ArgSpec {
  /** Flags that consume a value (parsed as strings, never number-coerced). */
  string?: readonly string[];
  /** Flags parsed as booleans (`--flag` / `--no-flag`). */
  boolean?: readonly string[];
  /** Alias map; a single key may map to one or more alternate names. */
  alias?: Readonly<Record<string, string | readonly string[]>>;
  /** Default values; their `typeof` casts the parsed result (mri semantics). */
  default?: Readonly<Record<string, unknown>>;
  /** Stop flag parsing at the first positional; the rest stay positional. */
  stopEarly?: boolean;
  /** Split on a `--` terminator and expose the trailing tokens separately. */
  '--'?: boolean;
}

export interface ParsedArgs {
  /** Positional (non-flag) arguments. */
  _: string[];
  /** Alias of `_` for readability at call sites. */
  positionals: string[];
  /** Parsed flags (including alias duplicates), minus positionals. */
  flags: Record<string, unknown>;
  /** Tokens after a `--` terminator (empty unless `spec['--']` is set). */
  doubleDashRest: string[];
}

/** Collect every flag name that consumes a value, expanding alias groups. */
function valueTakingNames(spec: ArgSpec): Set<string> {
  const names = new Set<string>(spec.string ?? []);
  const aliases = spec.alias ?? {};
  for (const [key, val] of Object.entries(aliases)) {
    const group = [key, ...(Array.isArray(val) ? val : [val])];
    if (group.some((n) => names.has(n))) {
      for (const n of group) names.add(n);
    }
  }
  return names;
}

const FLAG_RE = /^(--?)([^=]+)(=.*)?$/;

/** Index of the first positional, skipping value-taking flags' value slots. */
function stopEarlyBoundary(seg: readonly string[], valueNames: Set<string>): number {
  let i = 0;
  for (; i < seg.length; i++) {
    const token = seg[i];
    if (!token.startsWith('-') || token === '-') break;
    const m = FLAG_RE.exec(token);
    if (m && !m[3] && valueNames.has(m[2]) && i + 1 < seg.length) i++;
  }
  return i;
}

/**
 * Join a bare value-taking flag with its following token (`-m --help` →
 * `-m=--help`) so `mri` keeps the flag-looking value instead of starting a new
 * flag. Inline-`=` forms and combined short groups are left untouched.
 */
function shadowValues(seg: readonly string[], valueNames: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < seg.length; i++) {
    const token = seg[i];
    const m = FLAG_RE.exec(token);
    if (m && !m[3] && valueNames.has(m[2]) && i + 1 < seg.length) {
      out.push(`${token}=${seg[i + 1]}`);
      i++;
    } else {
      out.push(token);
    }
  }
  return out;
}

/**
 * Parse `argv` against `spec`. See the module comment for the behaviors added
 * on top of `mri`.
 */
export function parseArgs(argv: readonly string[], spec: ArgSpec = {}): ParsedArgs {
  let head: readonly string[] = argv;
  let doubleDashRest: string[] = [];
  if (spec['--']) {
    const idx = argv.indexOf('--');
    if (idx !== -1) {
      head = argv.slice(0, idx);
      doubleDashRest = argv.slice(idx + 1);
    }
  }

  const valueNames = valueTakingNames(spec);

  let flagSeg: readonly string[] = head;
  let tailPositionals: string[] = [];
  if (spec.stopEarly) {
    const boundary = stopEarlyBoundary(head, valueNames);
    flagSeg = head.slice(0, boundary);
    tailPositionals = head.slice(boundary);
  }

  const parsed = mri(shadowValues(flagSeg, valueNames), {
    string: spec.string ? [...spec.string] : undefined,
    boolean: spec.boolean ? [...spec.boolean] : undefined,
    alias: spec.alias as mri.Options['alias'],
    default: spec.default as mri.Options['default'],
  });

  const { _, ...flags } = parsed;
  const positionals = spec.stopEarly ? tailPositionals : (_ as string[]);

  return { _: positionals, positionals, flags, doubleDashRest };
}
