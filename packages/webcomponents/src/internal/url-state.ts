export function readUrlState(key: string): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
}

export function writeUrlState(
  key: string,
  value: string | null,
  opts: { push?: boolean } = {}
): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    const current = url.searchParams.get(key);
    if (current === value || (current === null && (value === null || value === ''))) return;
    if (value == null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    if (opts.push) window.history.pushState(window.history.state, '', url);
    else window.history.replaceState(window.history.state, '', url);
  } catch {}
}
