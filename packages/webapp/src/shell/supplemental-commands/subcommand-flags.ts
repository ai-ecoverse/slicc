/**
 * Shared known-flag walk for supplemental commands that dispatch on a
 * subcommand verb and own a fixed, small flag vocabulary.
 *
 * A scanner that only looks for its own flags via `args.indexOf('--name')` /
 * `args.includes('--json')` and treats everything else as positional will
 * silently ignore any flag it does not recognise and exit 0. That is worse
 * than not supporting the flag: a probe that exits 0 is indistinguishable
 * from one that honoured it (issue #2166 / #2255).
 *
 * Pair with `isHelpRequest` from `subcommand-help.ts`: pass the same
 * value-taking flag names as `spec.value` here and as `valueFlags` there so
 * a `--help` that is a flag's VALUE is never mistaken for a help request,
 * and an unknown dash token always fails loudly.
 */

export interface ParsedKnownFlags {
  positionals: string[];
  values: Map<string, string>;
  bools: Set<string>;
}

export interface KnownFlagSpec {
  /** Flags that consume `--flag=value` or `--flag value`. */
  value?: readonly string[];
  /** Flags that stand alone (no following token). */
  bool?: readonly string[];
}

/**
 * Walk every token: known value flags consume `--flag=value` or
 * `--flag value`, known boolean flags stand alone, and any other
 * dash-prefixed token is an error. Unlike the leading-flag walks elsewhere
 * in this directory, flags are accepted in any position — the repro in
 * issue #2166 put `--runtime` both before and after the JSON payload.
 *
 * Everything after a `--` terminator is positional, so a payload that
 * genuinely starts with a dash stays reachable. A bare `-` (stdin
 * placeholder) is positional, not a flag.
 *
 * On success returns positionals plus the collected values/bools; on
 * failure returns `{ error }` with a message suitable for stderr
 * (`unknown flag: --x` or `--flag requires a value`).
 */
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
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (valueFlags.has(name)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (value === undefined) return { error: `${name} requires a value` };
      values.set(name, value);
      continue;
    }
    if (boolFlags.has(name)) {
      bools.add(name);
      continue;
    }
    return { error: `unknown flag: ${name}` };
  }
  return { positionals, values, bools };
}
