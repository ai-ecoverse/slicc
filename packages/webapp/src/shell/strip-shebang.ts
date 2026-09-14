export function stripShebang(source: string): string {
  if (!source.startsWith('#!')) return source;
  const newline = source.indexOf('\n');
  return newline === -1 ? '' : source.slice(newline + 1);
}
