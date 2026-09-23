/**
 * `util.parseArgs` for the realm, following Node's semantics
 * (lib/internal/util/parse_args): long options with `=` or a following
 * value, short options and groups (`-abc`, `-ofile`), `--` as terminator,
 * `multiple`, `default`, `allowNegative` (`--no-x`), `tokens`, and the strict
 * mode errors (unknown option, missing or ambiguous value, stray positional).
 */

type OptionValue = string | boolean;

export interface ParseArgsOptionConfig {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
  default?: OptionValue | OptionValue[];
}

export interface ParseArgsConfig {
  args?: string[];
  options?: { [long: string]: ParseArgsOptionConfig };
  strict?: boolean;
  allowPositionals?: boolean;
  allowNegative?: boolean;
  tokens?: boolean;
}

export type ParseArgsToken =
  | {
      kind: 'option';
      name: string;
      rawName: string;
      index: number;
      value: string | undefined;
      inlineValue: boolean | undefined;
    }
  | { kind: 'positional'; index: number; value: string }
  | { kind: 'option-terminator'; index: number };

export interface ParseArgsResult {
  values: { [name: string]: OptionValue | OptionValue[] | undefined };
  positionals: string[];
  tokens?: ParseArgsToken[];
}

function parseArgsError(code: string, message: string): TypeError {
  return Object.assign(new TypeError(message), { code });
}

const isLong = (arg: string): boolean => arg.startsWith('--') && arg.length > 2;
const isShort = (arg: string): boolean => /^-[^-]/.test(arg);

/** Expand `-abc` to `-a -b -c`; a string option mid-group takes the rest (`-abfFILE`). */
function expandShortGroup(
  arg: string,
  options: NonNullable<ParseArgsConfig['options']>,
  longForShort: (short: string) => string
): string[] {
  const out: string[] = [];
  for (let i = 1; i < arg.length; i++) {
    const long = longForShort(arg[i]);
    if (options[long]?.type !== 'string' || i === arg.length - 1) {
      out.push(`-${arg[i]}`);
    } else {
      out.push(`-${arg.slice(i)}`);
      break;
    }
  }
  return out;
}

/** Split argv into Node's token stream. */
function tokenize(
  args: string[],
  options: NonNullable<ParseArgsConfig['options']>,
  longForShort: (short: string) => string
): ParseArgsToken[] {
  const tokens: ParseArgsToken[] = [];
  const queue = [...args];
  let index = -1;
  let groupCount = 0;
  const option = (
    name: string,
    rawName: string,
    value: string | undefined,
    inlineValue: boolean | undefined
  ): ParseArgsToken => ({ kind: 'option', name, rawName, index, value, inlineValue });
  const takesValue = (name: string): boolean => options[name]?.type === 'string';

  while (queue.length > 0) {
    const arg = queue.shift() as string;
    const next = queue[0];
    if (groupCount > 0) groupCount--;
    else index++;

    if (arg === '--') {
      tokens.push({ kind: 'option-terminator', index });
      for (const rest of queue) tokens.push({ kind: 'positional', index: ++index, value: rest });
      break;
    }
    if (isShort(arg) && arg.length === 2) {
      const name = longForShort(arg[1]);
      if (takesValue(name) && next !== undefined) {
        queue.shift();
        tokens.push(option(name, arg, next, false));
        index++;
      } else {
        tokens.push(option(name, arg, undefined, undefined));
      }
      continue;
    }
    if (isShort(arg)) {
      const name = longForShort(arg[1]);
      if (takesValue(name)) {
        tokens.push(option(name, `-${arg[1]}`, arg.slice(2), true));
      } else {
        const expanded = expandShortGroup(arg, options, longForShort);
        queue.unshift(...expanded);
        groupCount = expanded.length;
      }
      continue;
    }
    if (isLong(arg)) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        tokens.push(option(arg.slice(2, eq), arg.slice(0, eq), arg.slice(eq + 1), true));
        continue;
      }
      const name = arg.slice(2);
      if (takesValue(name) && next !== undefined) {
        queue.shift();
        tokens.push(option(name, arg, next, false));
        index++;
      } else {
        tokens.push(option(name, arg, undefined, undefined));
      }
      continue;
    }
    tokens.push({ kind: 'positional', index, value: arg });
  }
  return tokens;
}

type OptionToken = Extract<ParseArgsToken, { kind: 'option' }>;

function checkStrictOption(token: OptionToken, config: ParseArgsOptionConfig | undefined): void {
  const shortAndLong = config?.short ? `'-${config.short}, --${token.name}'` : `'--${token.name}'`;
  if (!config) {
    throw parseArgsError(
      'ERR_PARSE_ARGS_UNKNOWN_OPTION',
      `Unknown option '${token.rawName}'${token.rawName.startsWith('--') ? '' : ". To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"-\"'"}`
    );
  }
  if (config.type === 'string' && typeof token.value !== 'string') {
    throw parseArgsError(
      'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
      `Option ${shortAndLong.replace(/'$/, " <value>'")} argument missing`
    );
  }
  if (config.type === 'boolean' && token.value !== undefined) {
    throw parseArgsError(
      'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
      `Option ${shortAndLong} does not take an argument`
    );
  }
  // Option-like, as in Node: a lone '-' (stdin) is a fine value.
  const optionLike = token.value !== undefined && token.value.length > 1 && token.value[0] === '-';
  if (config.type === 'string' && token.inlineValue === false && optionLike) {
    throw parseArgsError(
      'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
      `Option '${token.rawName}' argument is ambiguous.\nDid you forget to specify the option argument for '${token.rawName}'?\nTo specify an option argument starting with a dash use '${token.rawName.startsWith('--') ? `${token.rawName}=-XYZ` : `--${token.name}=-XYZ' or '${token.rawName}-XYZ`}'.`
    );
  }
}

function store(
  values: ParseArgsResult['values'],
  name: string,
  value: OptionValue,
  multiple: boolean
): void {
  if (!multiple) {
    values[name] = value;
    return;
  }
  const prior = values[name];
  values[name] = Array.isArray(prior) ? [...prior, value] : [value];
}

/**
 * `--no-x` under `allowNegative` sets `x` to false (any `x` in non-strict
 * mode; strict mode accepts it only for a declared boolean `x`).
 */
function resolveNegation(
  name: string,
  options: NonNullable<ParseArgsConfig['options']>,
  allowNegative: boolean
): { name: string; negated: boolean } {
  const base = name.slice(3);
  if (allowNegative && name.startsWith('no-')) {
    return { name: base, negated: true };
  }
  return { name, negated: false };
}

/** Validate one option token (strict mode) and store its value. */
function applyOption(
  values: ParseArgsResult['values'],
  token: OptionToken,
  options: NonNullable<ParseArgsConfig['options']>,
  strict: boolean,
  allowNegative: boolean
): void {
  const { name, negated } = resolveNegation(token.name, options, allowNegative);
  // Node reports the negated option under its own name (rawName keeps --no-x).
  token.name = name;
  const optionConfig = options[name];
  if (strict) {
    // Node: a negation is only known for a declared boolean.
    const known = negated && optionConfig?.type !== 'boolean' ? undefined : optionConfig;
    checkStrictOption(token, known);
  }
  const value: OptionValue = negated ? false : (token.value ?? true);
  store(values, name, value, optionConfig?.multiple === true);
}

export function nodeParseArgs(
  config: ParseArgsConfig = {},
  defaultArgs: () => string[] = () => []
): ParseArgsResult {
  const args = config.args ?? defaultArgs();
  const options = config.options ?? {};
  const strict = config.strict ?? true;
  const allowPositionals = config.allowPositionals ?? !strict;
  const allowNegative = config.allowNegative ?? false;
  const longForShort = (short: string): string =>
    Object.keys(options).find((long) => options[long].short === short) ?? short;

  const values: ParseArgsResult['values'] = Object.create(null);
  const positionals: string[] = [];
  const tokens = tokenize(args, options, longForShort);

  for (const token of tokens) {
    if (token.kind === 'positional') {
      if (strict && !allowPositionals) {
        throw parseArgsError(
          'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
          `Unexpected argument '${token.value}'. This command does not take positional arguments`
        );
      }
      positionals.push(token.value);
      continue;
    }
    if (token.kind === 'option') applyOption(values, token, options, strict, allowNegative);
  }

  for (const [long, optionConfig] of Object.entries(options)) {
    if (optionConfig.default !== undefined && values[long] === undefined) {
      values[long] = optionConfig.default;
    }
  }
  return config.tokens ? { values, positionals, tokens } : { values, positionals };
}
