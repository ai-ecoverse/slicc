import { sha256Hex } from '@slicc/shared-ts';

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
