export function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        current += input[i];
        i++;
      }
      i++;
    } else if (ch === "'") {
      i++;
      while (i < input.length && input[i] !== "'") {
        current += input[i];
        i++;
      }
      i++;
    } else if (ch === '\\' && i + 1 < input.length && input[i + 1] === ' ') {
      current += ' ';
      i += 2;
    } else if (/\s/.test(ch)) {
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
