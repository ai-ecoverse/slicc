/**
 * Strip a leading `#!...` shebang line from a JS/TS source string.
 *
 * Only the FIRST line is touched, and only when it starts with `#!`.
 * Returns the input unchanged if no shebang is present. A file that is
 * nothing but a shebang collapses to the empty string.
 *
 * The newline itself is removed so the source still starts on line 1 in
 * principle; stack traces shift by one line, which mirrors the trade-off
 * Node makes for the same reason. Keep this helper pure so it can be
 * called from every host that evaluates raw JS source (commands + the
 * ipk module loader) without duplication.
 */
export function stripShebang(source: string): string {
  if (!source.startsWith('#!')) return source;
  const newline = source.indexOf('\n');
  return newline === -1 ? '' : source.slice(newline + 1);
}
