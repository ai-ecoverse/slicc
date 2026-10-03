/**
 * Gravatar URL helper, shared so any component that wants an email-backed avatar
 * face (`slicc-avatar`, `slicc-send-button`, …) derives the URL the same way.
 *
 * The hash follows the modern Gravatar spec: trim + lowercase the email, then
 * SHA-256 it to a lowercase hex string. The URL is
 * `https://www.gravatar.com/avatar/<hash>` with `?s=<size>&d=<default>`.
 */

import { sha256Hex } from '@slicc/shared-ts';

/** Options for {@link gravatarUrl}. */
export interface GravatarOptions {
  /** Requested square pixel size (`?s=`); default 80. */
  size?: number;
  /**
   * Fallback when the email has no Gravatar (`?d=`); default `mp`
   * (a neutral "mystery person" silhouette). Any Gravatar-supported keyword or
   * an URL-encoded image URL is accepted verbatim.
   */
  fallback?: string;
}

/**
 * Compute the Gravatar avatar URL for an email address. Returns `null` for an
 * empty / whitespace-only email so callers can fall back to their own ground
 * (e.g. the rainbow gradient).
 */
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
