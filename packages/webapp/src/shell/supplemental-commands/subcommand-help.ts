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

export function stripOptionTerminator(args: readonly string[]): string[] {
  const idx = args.indexOf('--');
  return idx === -1 ? [...args] : [...args.slice(0, idx), ...args.slice(idx + 1)];
}

export function extractSubcommandHelp(
  helpText: string,
  sub: string,
  options: { prefix?: string } = {}
): string | null {
  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (const line of helpText.split('\n')) {
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

    if (current && /^ {3,}\S/.test(line)) current.push(line);
    else current = null;
  }

  if (blocks.length === 0) return null;
  return blocks.map((block) => block.join('\n')).join('\n');
}

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
