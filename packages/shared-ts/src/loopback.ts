export function isLoopbackHostname(hostname: string): boolean {
  if (!hostname) return false;

  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (host === 'localhost') return true;
  if (host === '::1') return true;

  if (/^127(\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

export function isLoopbackOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}
