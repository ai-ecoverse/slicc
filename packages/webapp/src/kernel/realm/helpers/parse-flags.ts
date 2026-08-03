export interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
  subcommand: string | null;
  passthrough: string[];
}

/** Parse `process.argv` style flags, skipping the node and script entries. */
export function parseFlags(argv: readonly string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const passthrough: string[] = [];
  const set = (key: string, value: string | boolean): void => {
    if (key in flags) {
      const prev = flags[key];
      if (Array.isArray(prev)) prev.push(String(value));
      else flags[key] = [String(prev), String(value)];
    } else {
      flags[key] = value;
    }
  };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        set(body.slice(0, eq), body.slice(eq + 1));
        i++;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        set(body, next);
        i += 2;
        continue;
      }
      set(body, true);
      i++;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) set(ch, true);
      i++;
      continue;
    }
    positional.push(arg);
    i++;
  }
  const subcommand =
    positional.length > 0 && /^[a-z][\w-]*$/i.test(positional[0]) ? positional[0] : null;
  return { positional, flags, subcommand, passthrough };
}

export function attachArgvParseFlags(argv: string[]): string[] {
  const copy = [...argv];
  Object.defineProperty(copy, 'parseFlags', {
    value: () => parseFlags(copy),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return copy;
}
