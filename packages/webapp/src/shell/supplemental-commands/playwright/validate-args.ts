/**
 * Per-subcommand argv validation for the playwright-cli command family.
 *
 * The parser (`parseFlags`) knows one flag table for the whole CLI, so a flag
 * that belongs to another verb — `screenshot --output=…`, `eval-file --frame=…`
 * before it was wired — parsed cleanly and was then simply never read by the
 * handler. The command exited 0 having ignored what the caller asked for, which
 * turns a one-line usage error into a wrong answer (issue #2405).
 *
 * The per-command spec is `slicc-commands.json`, the manifest the
 * playwright-cli sync tool already diffs against the official CLI schema, so
 * runtime validation and the sync gate cannot drift apart. A verb with no
 * manifest entry is not validated — an unknown spec must never reject a working
 * invocation.
 *
 * THE WHOLE MODULE is loaded lazily by the dispatcher: the manifest is ~9 kB
 * of table, and neither it nor this code is needed until a playwright-cli
 * command actually runs. Statically imported, both land in the kernel worker's
 * boot-critical graph, which `first-load-budget.json` holds to a ratchet.
 */

import manifest from './slicc-commands.json';

/** One command's argv contract: positional names plus the flags it reads. */
interface CommandSpec {
  args?: string[];
  /** The last positional soaks up the remaining tokens (`eval <expression…>`). */
  variadic?: boolean;
  flags?: Record<string, string>;
}

const COMMAND_SPECS = manifest.commands as unknown as Record<string, CommandSpec>;

/** Flags every verb accepts, whatever the manifest says. */
const UNIVERSAL_FLAGS = new Set(['help', 'h']);

const FLAG_TOKEN_RE = /^(--?)([^=]+)(?:=(.*))?$/s;

/** An element ref as snapshots mint them: `e5` in the main frame, `f1e5` in a child frame. */
const ELEMENT_REF_RE = /^(f[0-9]+)?e[0-9]+$/;

/**
 * Positional slots that hold an element ref. A token in one of them that is not
 * ref-shaped is a caller mix-up, not a lookup that happens to miss — most
 * clearly `screenshot /tmp/shot.png`, where the path silently went nowhere and
 * the image landed at the default path instead.
 */
const REF_ARG_NAMES = new Set(['ref', 'startRef', 'endRef']);

/**
 * Verbs whose ref must come from a MAIN-FRAME snapshot. `screenshot` resolves
 * its clip through a backendNodeId in the page session, which cannot reach a
 * node inside a child frame — a frame-prefixed ref there silently captured the
 * full viewport and exited 0. Interaction verbs (`click`, `fill`, …) route
 * through `evaluateInFrame` and do take `f1e5`.
 */
const MAIN_FRAME_REF_COMMANDS = new Set(['screenshot']);

/** A main-frame ref (`e5`) — no frame prefix. */
const MAIN_FRAME_REF_RE = /^e[0-9]+$/;

/**
 * A negative number (`mousewheel 0 -300`). `mri` already swallows these as
 * flags — a separate bug — but they are plainly not flags the caller invented,
 * so validation leaves the existing "requires <dx> <dy>" error in place instead
 * of reporting `unknown flag "--3"`.
 */
const NEGATIVE_NUMBER_RE = /^-[0-9]+(\.[0-9]+)?$/;

/** The flag names a token introduces, or `null` when it is a positional. */
function flagNamesFromToken(token: string): string[] | null {
  if (!token.startsWith('-') || token === '-' || token === '--') return null;
  if (NEGATIVE_NUMBER_RE.test(token)) return null;
  const match = FLAG_TOKEN_RE.exec(token);
  if (!match) return null;
  const [, dashes, name] = match;
  // A combined short group (`-ab`) is one name per character, as mri reads it.
  if (dashes === '-' && name.length > 1) return [...name];
  return [name];
}

/** The first unsupported flag in `rawArgs`, or `null` when all are declared. */
function unknownFlag(rawArgs: readonly string[], spec: CommandSpec): string | null {
  const allowed = new Set<string>(Object.keys(spec.flags ?? {}));
  const valueTaking = new Set(
    Object.entries(spec.flags ?? {})
      .filter(([, type]) => type !== 'boolean')
      .map(([name]) => name)
  );

  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === '--') break;
    const names = flagNamesFromToken(token);
    if (!names) continue;
    // `--no-iframes` is a flag name in its own right, not a negated boolean.
    const unknown = names.find((n) => !allowed.has(n) && !UNIVERSAL_FLAGS.has(n));
    if (unknown) return unknown;
    // Skip the value slot so `--filename --foo` does not report `--foo`.
    if (names.length === 1 && valueTaking.has(names[0]) && !token.includes('=')) i++;
  }
  return null;
}

/**
 * The first token sitting in a ref slot that is not ref-shaped, or `null`.
 *
 * Skipped for a variadic spec: `upload <ref> <file…>` accepts a bare file list
 * with no ref at all, so its first positional is not reliably a ref.
 */
function malformedRef(
  positional: readonly string[],
  spec: CommandSpec,
  refPattern: RegExp
): string | null {
  if (spec.variadic) return null;
  for (const [index, name] of (spec.args ?? []).entries()) {
    const value = positional[index];
    if (!REF_ARG_NAMES.has(name) || value === undefined) continue;
    if (!refPattern.test(value)) return value;
  }
  return null;
}

/**
 * Validate `rawArgs` against the manifest entry for `sub`.
 *
 * Returns an error string (already newline-terminated, ready for stderr) or
 * `null` when the invocation is well-formed. `positional` is the parsed
 * positional list, which already accounts for value-taking flags consuming
 * their next token.
 */
export function validateSubcommandArgs(
  commandName: string,
  sub: string,
  rawArgs: readonly string[],
  positional: readonly string[]
): string | null {
  const spec = COMMAND_SPECS[sub];
  if (!spec) return null;

  const usage = `Run "${commandName} ${sub} --help" for usage.\n`;

  const flag = unknownFlag(rawArgs, spec);
  if (flag) return `${commandName} ${sub}: unknown flag "--${flag}"\n${usage}`;

  const mainFrameOnly = MAIN_FRAME_REF_COMMANDS.has(sub);
  const badRef = malformedRef(positional, spec, mainFrameOnly ? MAIN_FRAME_REF_RE : ELEMENT_REF_RE);
  if (badRef !== null) {
    // `screenshot /tmp/shot.png` is the reflex that started #2405: the path
    // slot is `--filename`, so point at it rather than only rejecting.
    const filenameHint =
      spec.flags?.['filename'] && /[/.]/.test(badRef)
        ? ` Use --filename=${badRef} to choose where the output is saved.`
        : '';
    const expected = mainFrameOnly
      ? 'expected a main-frame ref like e5; take a snapshot without --frame'
      : 'expected e5 or f1e5';
    return `${commandName} ${sub}: "${badRef}" is not an element ref (${expected}).${filenameHint}\n${usage}`;
  }

  const maxPositional = spec.args?.length ?? 0;
  if (!spec.variadic && positional.length > maxPositional) {
    const extra = positional[maxPositional];
    const takes = maxPositional === 0 ? 'takes no arguments' : `takes ${maxPositional}`;
    return `${commandName} ${sub}: unexpected argument "${extra}" (${sub} ${takes})\n${usage}`;
  }

  return null;
}
