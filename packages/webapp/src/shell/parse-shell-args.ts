/**
 * Parse a shell-like argument string into an array of arguments.
 * Handles double-quoted, single-quoted, and backslash-escaped spaces.
 */
export function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === '"') {
      // Double-quoted string: consume until closing quote
      i++;
      while (i < input.length && input[i] !== '"') {
        current += input[i];
        i++;
      }
      i++; // skip closing quote
    } else if (ch === "'") {
      // Single-quoted string: consume until closing quote
      i++;
      while (i < input.length && input[i] !== "'") {
        current += input[i];
        i++;
      }
      i++; // skip closing quote
    } else if (ch === '\\' && i + 1 < input.length && input[i + 1] === ' ') {
      // Escaped space
      current += ' ';
      i += 2;
    } else if (/\s/.test(ch)) {
      // Whitespace delimiter
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      i++;
    } else {
      current += ch;
      i++;
    }
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}
