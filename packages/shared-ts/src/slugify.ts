/**
 * Lower-case, dash-separated, ASCII-only slug of a display name.
 *
 * One home for the recipe that used to be copy-pasted eight times in
 * `@slicc/webapp` (#2904). Callers keep their own `maxLen` / `fallback`
 * and any suffix (`-scoop`, `custom-${id}`).
 */

export interface SlugifyOptions {
  /** Cap the slug at this many characters after hyphen-trim. */
  maxLen?: number;
  /** Returned when the input slugs to empty. Default: `''`. */
  fallback?: string;
  /**
   * Strip combining marks via NFKD so `Café` → `cafe` rather than `caf`.
   * Default: `true`.
   */
  normalize?: boolean;
}

export function slugify(
  text: string,
  { maxLen, fallback = '', normalize = true }: SlugifyOptions = {}
): string {
  let s = text.toLowerCase();
  if (normalize) s = s.normalize('NFKD').replace(/\p{M}+/gu, '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (maxLen) s = s.slice(0, maxLen);
  return s || fallback;
}
