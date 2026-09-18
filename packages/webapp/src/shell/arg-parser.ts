import mri from 'mri';

export type ArgFlagScalar = string | number | boolean;

export type ArgFlagValue = ArgFlagScalar | ArgFlagScalar[];

export interface ArgDefaults {
  readonly [name: string]: ArgFlagScalar;
}

export interface ParsedFlags {
  readonly [name: string]: ArgFlagValue | undefined;
}

export interface ArgSpec {
  string?: readonly string[];

  boolean?: readonly string[];

  alias?: Readonly<Record<string, string | readonly string[]>>;

  default?: ArgDefaults;

  stopEarly?: boolean;

  '--'?: boolean;
}

export interface ParsedArgs {
  _: string[];

  positionals: string[];

  flags: ParsedFlags;

  doubleDashRest: string[];
}

export interface FlagArgs {
  positionals: string[];

  flags: Map<string, string>;

  bools: Set<string>;
}

export function parseFlagArgs(args: readonly string[], valueFlags: ReadonlySet<string>): FlagArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok.startsWith('-')) {
      if (valueFlags.has(tok)) flags.set(tok, args[++i] ?? '');
      else bools.add(tok);
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags, bools };
}

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

function unknownBooleanNames(seg: readonly string[], knownNames: Set<string>): string[] {
  const extra: string[] = [];
  for (const token of seg) {
    const m = FLAG_RE.exec(token);
    if (!m || m[3]) continue;
    const name = m[2];
    if (knownNames.has(name)) continue;
    if (m[1] === '-' && name.length > 1) {
      for (const ch of name) {
        if (!knownNames.has(ch)) extra.push(ch);
      }
    } else {
      extra.push(name);
    }
  }
  return extra;
}

function recognizedNames(spec: ArgSpec): Set<string> {
  const names = new Set<string>(spec.string ?? []);
  for (const b of spec.boolean ?? []) {
    names.add(b);
    names.add(`no-${b}`);
  }
  for (const [key, val] of Object.entries(spec.alias ?? {})) {
    names.add(key);
    for (const n of Array.isArray(val) ? val : [val]) names.add(n);
  }
  return names;
}

function stopEarlyBoundary(
  seg: readonly string[],
  valueNames: Set<string>,
  knownNames: Set<string>
): number {
  let i = 0;
  for (; i < seg.length; i++) {
    const token = seg[i];
    if (!token.startsWith('-') || token === '-') break;
    const m = FLAG_RE.exec(token);
    if (!m || !knownNames.has(m[2])) break;
    if (!m[3] && valueNames.has(m[2]) && i + 1 < seg.length) i++;
  }
  return i;
}

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
  const knownNames = recognizedNames(spec);

  let flagSeg: readonly string[] = head;
  let tailPositionals: string[] = [];
  if (spec.stopEarly) {
    const boundary = stopEarlyBoundary(head, valueNames, knownNames);
    flagSeg = head.slice(0, boundary);
    tailPositionals = head.slice(boundary);
  }

  const extraBools = unknownBooleanNames(flagSeg, knownNames);
  const boolean =
    spec.boolean || extraBools.length > 0 ? [...(spec.boolean ?? []), ...extraBools] : undefined;

  const parsed = mri<ParsedFlags>(shadowValues(flagSeg, valueNames), {
    string: spec.string ? [...spec.string] : undefined,
    boolean,
    alias: spec.alias as mri.Options['alias'],
    default: spec.default as mri.Options['default'],
  });

  const { _, ...flags } = parsed;
  const positionals = spec.stopEarly ? tailPositionals : (_ as string[]);

  return { _: positionals, positionals, flags, doubleDashRest };
}
