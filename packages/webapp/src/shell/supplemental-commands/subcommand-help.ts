/**
 * Shared `--help` handling for supplemental commands that dispatch on a
 * subcommand verb (`playwright-cli open`, `v86 stop`, `layout reset`, ...).
 *
 * A verb dispatcher that only checks `args[0] === '--help'` answers
 * `cmd --help` but routes `cmd <verb> --help` straight into the verb's
 * handler. When that handler defaults a missing argument, asking for help
 * *performs the action* — `playwright-cli record --help` opened a tab and
 * started a HAR recording, `v86 stop --help` powered off the VM.
 *
 * The rule for every verb dispatcher: call {@link isHelpRequest} on the
 * verb's arguments and return help BEFORE touching the handler. The
 * `subcommand-help.test.ts` suite enforces this against every registered
 * verb, so a new verb cannot reintroduce the bug.
 */

/**
 * True when `args` asks for help: `--help` or `-h` appearing before an
 * explicit `--` end-of-options separator.
 *
 * The `--` escape matters for verbs whose payload is free text — `v86 type
 * -- --help` types the literal string into the guest instead of printing
 * usage.
 *
 * `valueFlags` names the flags that consume the following token, so their
 * VALUE is never mistaken for a help request: with
 * `valueFlags: ['-append']`, `v86 start -append --help` boots with that
 * kernel cmdline instead of printing usage. When the command also rejects
 * unknown flags via `parseKnownFlags` from `subcommand-flags.ts`, pass the
 * same names as that helper's `spec.value` so help-shadowing and flag
 * parsing stay in agreement. Commands parsed by the shared `arg-parser` do
 * not need this — parse first and read `flags.help`, which already applies
 * the parser's value-shadowing rules.
 */
export function isHelpRequest(
  args: readonly string[],
  options: { valueFlags?: readonly string[] } = {}
): boolean {
  const valueFlags = new Set(options.valueFlags ?? []);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return false;
    if (arg === '--help' || arg === '-h') return true;
    if (valueFlags.has(arg)) i++;
  }
  return false;
}

/**
 * Drop the first `--` end-of-options separator so handlers that scan raw
 * tokens do not treat it as a value. Everything after it is preserved.
 */
export function stripOptionTerminator(args: readonly string[]): string[] {
  const idx = args.indexOf('--');
  return idx === -1 ? [...args] : [...args.slice(0, idx), ...args.slice(idx + 1)];
}

/**
 * Pull the entry for `sub` out of a command's full help text.
 *
 * Entries are lines indented by exactly two spaces; their wrapped
 * continuation lines are indented deeper. `prefix` drops a repeated command
 * name (`  v86 start ...` → `start ...`), and a `a|b` head matches either
 * alias. A verb documented by several lines (`v86 serve`, `sprinkle route`)
 * returns all of them.
 *
 * Returns `null` when the verb is undocumented, so callers can fall back to
 * the full help text.
 */
export function extractSubcommandHelp(
  helpText: string,
  sub: string,
  options: { prefix?: string } = {}
): string | null {
  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (const line of helpText.split('\n')) {
    // `\w` heads only — an indented prose bullet (`  - ...`) is not an entry.
    const entry = /^ {2}(\w.*)$/.exec(line);
    if (entry) {
      current = null;
      let head = entry[1].split(/\s+/);
      if (options.prefix && head[0] === options.prefix) head = head.slice(1);
      if (head[0]?.split('|').includes(sub)) {
        current = [line];
        blocks.push(current);
      }
      continue;
    }
    // Deeper-indented follow-on lines belong to the entry above them; a
    // blank line or an unindented heading ends the block.
    if (current && /^ {3,}\S/.test(line)) current.push(line);
    else current = null;
  }

  if (blocks.length === 0) return null;
  return blocks.map((block) => block.join('\n')).join('\n');
}

/**
 * Standard help payload for `<command> <sub> --help`: the extracted entry
 * when the verb is documented, the whole help text otherwise.
 */
export function subcommandHelpText(
  command: string,
  sub: string,
  helpText: string,
  options: { prefix?: string } = {}
): string {
  const entry = extractSubcommandHelp(helpText, sub, options);
  if (!entry) return helpText.endsWith('\n') ? helpText : `${helpText}\n`;
  return `usage: ${command} ${sub}\n\n${entry}\n`;
}
