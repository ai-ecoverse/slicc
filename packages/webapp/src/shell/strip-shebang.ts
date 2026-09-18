export function stripShebang(source: string, opts?: { keepLine?: boolean }): string {
  if (!source.startsWith('#!')) return source;
  const newline = source.indexOf('\n');
  if (newline === -1) return '';
  const rest = source.slice(newline + 1);
  return opts?.keepLine ? `\n${rest}` : rest;
}
