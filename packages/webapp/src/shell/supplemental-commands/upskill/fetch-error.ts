export function describeFetchError(err: unknown, url: string): string {
  const base = err instanceof Error ? err.message : String(err);
  let host: string | undefined;
  try {
    host = new URL(url).host;
  } catch {
    return base;
  }
  if (!host || base.includes(host)) return base;
  return `${base} (host: ${host} — network or CORS error)`;
}
