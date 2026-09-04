/**
 * `patch` argv grammar.
 *
 * Split out from `run.ts` so the flag surface can be unit-tested without a
 * filesystem, the way `pdftotext/run.ts` exposes `parsePdftotextArgs`.
 */

export const PATCH_USAGE =
  'usage: patch [-p NUM] [-R] [-F NUM] [-s] [--dry-run] [-i PATCHFILE] [FILE [PATCHFILE]]';

export interface PatchArgs {
  /**
   * `-p NUM`, or null when the flag was omitted. Null means "auto": try the
   * name as written, then strip one leading component at a time and use the
   * first candidate that exists — see `resolveTarget` in `run.ts`.
   */
  strip: number | null;
  reverse: boolean;
  dryRun: boolean;
  /** `-F NUM` — context lines the applier may ignore. GNU's default is 2. */
  fuzz: number;
  /** `-s` — suppress the per-file / per-hunk progress chatter. */
  silent: boolean;
  /** `-i FILE`, or the second operand: where to read the patch from. */
  patchFile?: string;
  /** First operand: patch this file regardless of the names in the diff. */
  originalFile?: string;
  mode: 'apply' | 'help' | 'version';
}

export class PatchUsageError extends Error {}

/** Long flags that take a value, in either `--flag=v` or `--flag v` spelling. */
const VALUE_LONG_FLAGS = new Set(['--strip', '--fuzz', '--input']);

/** Rewrite `--flag value` to `--flag=value` so one parser handles both forms. */
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

/** Value attached to a short flag (`-p1`, `-F3`, `-ipatch.diff`). */
function attachedValue(arg: string, prefix: string): string | null {
  return arg.startsWith(prefix) && arg.length > prefix.length ? arg.slice(prefix.length) : null;
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

/** Short flags with an attached or following value. Returns the new index. */
function applyValueShortFlag(args: string[], index: number, out: PatchArgs): number | null {
  const arg = args[index];
  const attached = [
    [
      '-p',
      (value: string) => {
        out.strip = parseCount(value, '-p');
      },
    ],
    [
      '-F',
      (value: string) => {
        out.fuzz = parseCount(value, '-F');
      },
    ],
    [
      '-i',
      (value: string) => {
        out.patchFile = value;
      },
    ],
  ] as const;
  for (const [prefix, assign] of attached) {
    const value = attachedValue(arg, prefix);
    if (value !== null) {
      assign(value);
      return index;
    }
    if (arg === prefix) {
      assign(requireValue(args, index + 1, prefix));
      return index + 1;
    }
  }
  return null;
}

/**
 * Parse `patch`'s argv. Unknown flags are a usage error rather than a
 * positional operand — silently patching the wrong file because `--froward`
 * was read as a file name is the failure mode worth ruling out.
 */
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
    const consumed = applyValueShortFlag(args, index, out);
    if (consumed !== null) {
      index = consumed;
      continue;
    }
    switch (arg) {
      case '-h':
        out.mode = 'help';
        return out;
      case '-R':
        out.reverse = true;
        break;
      case '-s':
        out.silent = true;
        break;
      default:
        throw new PatchUsageError(`unrecognized option '${arg}'`);
    }
  }

  if (operands.length > 2) throw new PatchUsageError(`extra operand '${operands[2]}'`);
  if (operands[0] !== undefined) out.originalFile = operands[0];
  if (operands[1] !== undefined) out.patchFile = operands[1];
  return out;
}
