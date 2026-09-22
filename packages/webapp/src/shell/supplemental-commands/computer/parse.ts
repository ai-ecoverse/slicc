/**
 * Global flags, Anthropic aliases, and xdotool-style verb chaining.
 */

export const VERBS = [
  'ls',
  'add',
  'rm',
  'use',
  'info',
  'screenshot',
  'text',
  'watch',
  'record',
  'mousemove',
  'click',
  'mousedown',
  'mouseup',
  'drag',
  'scroll',
  'key',
  'keydown',
  'keyup',
  'type',
  'wait',
  'exec',
] as const;

export type ComputerVerb = (typeof VERBS)[number];

const VERB_SET = new Set<string>(VERBS);

const ALIAS_TO_VERB: Record<string, ComputerVerb> = {
  left_click: 'click',
  right_click: 'click',
  middle_click: 'click',
  double_click: 'click',
  triple_click: 'click',
  left_click_drag: 'drag',
  mouse_move: 'mousemove',
  screenshot: 'screenshot',
  wait: 'wait',
  key: 'key',
  type: 'type',
  scroll: 'scroll',
};

const REST_VERBS = new Set<ComputerVerb>(['type', 'key', 'exec', 'add']);

const VALUE_FLAGS = new Set([
  '--size',
  '--at',
  '--hold',
  '--repeat',
  '--fps',
  '-n',
  '--name',
  '-c',
  '--computer',
  '--__resolved',
  '-V',
  '--duration',
  '--sim',
  '--display',
]);

export interface ParsedGlobals {
  computer: string | undefined;
  json: boolean;
  native: boolean;
  rest: string[];
}

export interface VerbCall {
  verb: ComputerVerb;
  alias: string;
  args: string[];
}

export function isComputerVerb(token: string): boolean {
  return VERB_SET.has(token) || token in ALIAS_TO_VERB;
}

export function canonicalizeVerb(token: string): ComputerVerb | null {
  if (VERB_SET.has(token)) return token as ComputerVerb;
  return ALIAS_TO_VERB[token] ?? null;
}

/**
 * Pull `-c/--computer`, `--json`, `--native` from anywhere before `--`.
 * Shipped examples such as `computer screenshot -c tab:<id>` put the
 * target after the verb; rest-taking verbs (`type`, `key`, `exec`) must
 * not swallow those tokens as literal input. Verb-local flags (`--size`,
 * `--at`, `--id`) stay in `rest`.
 */
export function parseGlobals(args: readonly string[]): ParsedGlobals {
  const rest: string[] = [];
  let computer: string | undefined;
  let json = false;
  let native = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--') {
      rest.push(...args.slice(i));
      break;
    }
    if (tok === '--json') {
      json = true;
      continue;
    }
    if (tok === '--native') {
      native = true;
      continue;
    }
    if (tok === '-c' || tok === '--computer') {
      computer = args[++i];
      continue;
    }
    rest.push(tok);
  }
  return { computer, json, native, rest };
}

export function chainVerbs(tokens: readonly string[]): VerbCall[] {
  const calls: VerbCall[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === '--') {
      i += 1;
      continue;
    }
    const verb = canonicalizeVerb(tok);
    if (!verb) {
      throw new Error(`unknown verb '${tok}' — see \`computer --help\``);
    }
    i += 1;
    const { args, next } = takeVerbArgs(verb, tokens, i);
    calls.push({ verb, alias: tok, args: injectAliasArgs(tok, verb, args) });
    i = next;
  }
  return calls;
}

function injectAliasArgs(alias: string, verb: ComputerVerb, args: string[]): string[] {
  if (verb !== 'click') return args;
  if (alias === 'left_click') return prependButton(args, '1');
  if (alias === 'middle_click') return prependButton(args, '2');
  if (alias === 'right_click') return prependButton(args, '3');
  if (alias === 'double_click') return [...prependButton(args, '1'), '--repeat', '2'];
  if (alias === 'triple_click') return [...prependButton(args, '1'), '--repeat', '3'];
  return args;
}

function prependButton(args: string[], button: string): string[] {
  if (args[0] === '1' || args[0] === '2' || args[0] === '3') return args;
  return [button, ...args];
}

function takeVerbArgs(
  verb: ComputerVerb,
  tokens: readonly string[],
  start: number
): { args: string[]; next: number } {
  if (REST_VERBS.has(verb)) return takeRestArgs(tokens, start);
  return takeFixedArgs(positionalCount(verb), tokens, start);
}

function takeRestArgs(tokens: readonly string[], start: number): { args: string[]; next: number } {
  const args: string[] = [];
  let i = start;
  let escaped = false;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!escaped && tok === '--') {
      escaped = true;
      i += 1;
      continue;
    }
    if (!escaped && isComputerVerb(tok)) break;
    args.push(tok);
    i += 1;
  }
  return { args, next: i };
}

function isFlagToken(tok: string): boolean {
  return tok.startsWith('--') || tok === '-n' || tok === '-c' || tok === '-V';
}

function appendFlag(tokens: readonly string[], i: number, args: string[]): number {
  const tok = tokens[i];
  args.push(tok);
  i += 1;
  if (VALUE_FLAGS.has(tok) && i < tokens.length) {
    args.push(tokens[i]);
    i += 1;
  }
  return i;
}

function takeFixedArgs(
  argc: number,
  tokens: readonly string[],
  start: number
): { args: string[]; next: number } {
  const args: string[] = [];
  let i = start;
  let taken = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === '--') {
      i += 1;
      continue;
    }
    if (isFlagToken(tok)) {
      i = appendFlag(tokens, i, args);
      continue;
    }
    if (isComputerVerb(tok)) break;
    args.push(tok);
    taken += 1;
    i += 1;
    if (taken >= argc && argc > 0) {
      i = consumeTrailingFlags(tokens, i, args);
      break;
    }
  }
  return { args, next: i };
}

function consumeTrailingFlags(tokens: readonly string[], start: number, args: string[]): number {
  let i = start;
  while (i < tokens.length && isFlagToken(tokens[i])) {
    i = appendFlag(tokens, i, args);
  }
  return i;
}

function positionalCount(verb: ComputerVerb): number {
  switch (verb) {
    case 'mousemove':
      return 2;
    case 'drag':
      return 4;
    case 'scroll':
      return 2;
    case 'click':
    case 'mousedown':
    case 'mouseup':
      return 3;
    case 'wait':
    case 'keydown':
    case 'keyup':
    case 'rm':
    case 'use':
      return 1;
    case 'screenshot':
      return 1;
    case 'record':
      return 1;
    default:
      return 0;
  }
}

export function parseAtFlag(args: readonly string[]): { x: number; y: number } | undefined {
  const idx = args.indexOf('--at');
  if (idx === -1) return undefined;
  const spec = args[idx + 1];
  const m = spec ? /^(-?\d+),(-?\d+)$/u.exec(spec) : null;
  if (!m) throw new Error('--at requires x,y');
  return { x: Number(m[1]), y: Number(m[2]) };
}

export function parseIntFlag(args: readonly string[], name: string): number | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const n = Number.parseInt(args[idx + 1] ?? '', 10);
  if (!Number.isFinite(n)) throw new Error(`${name} requires a number`);
  return n;
}

export function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

export function flagValue(args: readonly string[], names: string[]): string | undefined {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx !== -1) return args[idx + 1];
  }
  return undefined;
}

export function positionals(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (tok.startsWith('--') || tok === '-n' || tok === '-c' || tok === '-V') {
      if (VALUE_FLAGS.has(tok)) i += 1;
      continue;
    }
    out.push(tok);
  }
  return out;
}
