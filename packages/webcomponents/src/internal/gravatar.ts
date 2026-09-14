export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface GravatarOptions {
  size?: number;

  fallback?: string;
}

export async function gravatarUrl(
  email: string | null | undefined,
  opts: GravatarOptions = {}
): Promise<string | null> {
  const normalized = (email ?? '').trim().toLowerCase();
  if (normalized === '') return null;
  const hash = await sha256Hex(normalized);
  const size = opts.size ?? 80;
  const fallback = opts.fallback ?? 'mp';
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=${encodeURIComponent(fallback)}`;
}
