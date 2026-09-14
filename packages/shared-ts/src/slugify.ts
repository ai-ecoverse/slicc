export interface SlugifyOptions {
  maxLen?: number;

  fallback?: string;

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
