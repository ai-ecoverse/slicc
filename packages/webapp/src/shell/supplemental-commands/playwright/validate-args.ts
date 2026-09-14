import manifest from './slicc-commands.json';

interface CommandSpec {
  args?: string[];

  variadic?: boolean;
  flags?: Record<string, string>;
}

const COMMAND_SPECS = manifest.commands as unknown as Record<string, CommandSpec>;

const UNIVERSAL_FLAGS = new Set(['help', 'h']);

const FLAG_TOKEN_RE = /^(--?)([^=]+)(?:=(.*))?$/s;

const ELEMENT_REF_RE = /^(f[0-9]+)?e[0-9]+$/;

const REF_ARG_NAMES = new Set(['ref', 'startRef', 'endRef']);

const MAIN_FRAME_REF_COMMANDS = new Set(['screenshot']);

const MAIN_FRAME_REF_RE = /^e[0-9]+$/;

const NEGATIVE_NUMBER_RE = /^-[0-9]+(\.[0-9]+)?$/;

function flagNamesFromToken(token: string): string[] | null {
  if (!token.startsWith('-') || token === '-' || token === '--') return null;
  if (NEGATIVE_NUMBER_RE.test(token)) return null;
  const match = FLAG_TOKEN_RE.exec(token);
  if (!match) return null;
  const [, dashes, name] = match;

  if (dashes === '-' && name.length > 1) return [...name];
  return [name];
}

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

    const unknown = names.find((n) => !allowed.has(n) && !UNIVERSAL_FLAGS.has(n));
    if (unknown) return unknown;

    if (names.length === 1 && valueTaking.has(names[0]) && !token.includes('=')) i++;
  }
  return null;
}

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
