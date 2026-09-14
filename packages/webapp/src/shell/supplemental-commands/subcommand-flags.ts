export interface ParsedKnownFlags {
  positionals: string[];
  values: Map<string, string>;
  bools: Set<string>;
}

export interface KnownFlagSpec {
  value?: readonly string[];

  bool?: readonly string[];
}

function consumeValueFlag(
  arg: string,
  i: number,
  args: readonly string[],
  name: string,
  boolFlags: Set<string>,
  values: Map<string, string>
): { nextIndex: number } | { error: string } {
  const eq = arg.indexOf('=');
  const value = eq === -1 ? args[i + 1] : arg.slice(eq + 1);
  if (value === undefined) return { error: `${name} requires a value` };

  if (eq === -1 && boolFlags.has(value)) {
    return { nextIndex: i };
  }
  values.set(name, value);
  return { nextIndex: eq === -1 ? i + 1 : i };
}

export function parseKnownFlags(
  args: readonly string[],
  spec: KnownFlagSpec = {}
): ParsedKnownFlags | { error: string } {
  const valueFlags = new Set(spec.value ?? []);
  const boolFlags = new Set(spec.bool ?? []);
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const bools = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-' || isNumericLiteral(arg)) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (valueFlags.has(name)) {
      const consumed = consumeValueFlag(arg, i, args, name, boolFlags, values);
      if ('error' in consumed) return consumed;
      i = consumed.nextIndex;
      continue;
    }

    if (eq === -1 && boolFlags.has(name)) {
      bools.add(name);
      continue;
    }
    return { error: `unknown flag: ${name}` };
  }
  return { positionals, values, bools };
}

function isNumericLiteral(arg: string): boolean {
  if (arg.startsWith('--')) return false;
  return Number.isFinite(Number(arg));
}
