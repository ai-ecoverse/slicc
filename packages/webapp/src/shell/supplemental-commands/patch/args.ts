export const PATCH_USAGE =
  'usage: patch [-p NUM] [-R] [-F NUM] [-s] [--dry-run] [-i PATCHFILE] [FILE [PATCHFILE]]';

export interface PatchArgs {
  strip: number | null;
  reverse: boolean;
  dryRun: boolean;

  fuzz: number;

  silent: boolean;

  patchFile?: string;

  originalFile?: string;
  mode: 'apply' | 'help' | 'version';
}

export class PatchUsageError extends Error {}

const VALUE_LONG_FLAGS = new Set(['--strip', '--fuzz', '--input']);

function normalizeLongFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      out.push(...args.slice(index));
      return out;
    }
    if (!VALUE_LONG_FLAGS.has(arg)) {
      out.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) throw new PatchUsageError(`option '${arg}' requires an argument`);
    out.push(`${arg}=${value}`);
    index++;
  }
  return out;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) throw new PatchUsageError(`option '${flag}' requires an argument`);
  return value;
}

function parseCount(raw: string, flag: string): number {
  const value = Number(raw);
  if (raw === '' || !Number.isInteger(value) || value < 0) {
    throw new PatchUsageError(`option '${flag}' expects a non-negative integer, got '${raw}'`);
  }
  return value;
}

function applyLongFlag(arg: string, out: PatchArgs): boolean {
  const separator = arg.indexOf('=');
  const name = separator === -1 ? arg : arg.slice(0, separator);
  const value = separator === -1 ? '' : arg.slice(separator + 1);
  switch (name) {
    case '--help':
      out.mode = 'help';
      return true;
    case '--version':
      out.mode = 'version';
      return true;
    case '--reverse':
      out.reverse = true;
      return true;
    case '--dry-run':
      out.dryRun = true;
      return true;
    case '--silent':
    case '--quiet':
      out.silent = true;
      return true;
    case '--strip':
      out.strip = parseCount(value, '--strip');
      return true;
    case '--fuzz':
      out.fuzz = parseCount(value, '--fuzz');
      return true;
    case '--input':
      out.patchFile = value;
      return true;
    default:
      return false;
  }
}

const VALUE_SHORT_FLAGS: Record<string, ((value: string, out: PatchArgs) => void) | undefined> = {
  p: (value, out) => {
    out.strip = parseCount(value, '-p');
  },
  F: (value, out) => {
    out.fuzz = parseCount(value, '-F');
  },
  i: (value, out) => {
    out.patchFile = value;
  },
};

const BOOL_SHORT_FLAGS: Record<string, ((out: PatchArgs) => void) | undefined> = {
  R: (out) => {
    out.reverse = true;
  },
  s: (out) => {
    out.silent = true;
  },
  h: (out) => {
    out.mode = 'help';
  },
};

function applyShortCluster(
  args: string[],
  index: number,
  out: PatchArgs
): number | { error: string } {
  const cluster = args[index].slice(1);
  for (let position = 0; position < cluster.length; position++) {
    const letter = cluster[position];
    const takesValue = VALUE_SHORT_FLAGS[letter];
    if (takesValue) {
      const rest = cluster.slice(position + 1);
      takesValue(rest === '' ? requireValue(args, index + 1, `-${letter}`) : rest, out);
      return rest === '' ? index + 1 : index;
    }
    const boolFlag = BOOL_SHORT_FLAGS[letter];
    if (!boolFlag) return { error: `unrecognized option '-${letter}'` };
    boolFlag(out);

    if (out.mode !== 'apply') return index;
  }
  return index;
}

export function parsePatchArgs(rawArgs: string[]): PatchArgs {
  const out: PatchArgs = {
    strip: null,
    reverse: false,
    dryRun: false,
    fuzz: 2,
    silent: false,
    mode: 'apply',
  };
  const args = normalizeLongFlags(rawArgs);
  const operands: string[] = [];
  let literal = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!literal && arg === '--') {
      literal = true;
      continue;
    }
    if (literal || arg === '-' || !arg.startsWith('-')) {
      operands.push(arg);
      continue;
    }
    if (arg.startsWith('--')) {
      if (!applyLongFlag(arg, out)) throw new PatchUsageError(`unrecognized option '${arg}'`);
      if (out.mode !== 'apply') return out;
      continue;
    }
    const consumed = applyShortCluster(args, index, out);
    if (typeof consumed !== 'number') throw new PatchUsageError(consumed.error);
    if (out.mode !== 'apply') return out;
    index = consumed;
  }

  if (operands.length > 2) throw new PatchUsageError(`extra operand '${operands[2]}'`);
  if (operands[0] !== undefined) out.originalFile = operands[0];
  if (operands[1] !== undefined) out.patchFile = operands[1];
  return out;
}
