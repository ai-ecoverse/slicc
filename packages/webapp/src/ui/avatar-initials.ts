/**
 * Derive up-to-two-character avatar initials from an account label.
 *
 * Account labels arrive in three shapes: a plain name ("Lars Trieloff"),
 * a bare login ("octocat"), or an OAuth display label that embeds an
 * email and a plan suffix ("lars@trieloff.net (Team)"). The plan suffix
 * and the "@" break a naive first/last-word split (it would yield "L("),
 * so we strip a trailing parenthetical first, then treat emails
 * specially: first letter of the local part + first letter of the next
 * local-part segment (split on . _ + -) or, lacking one, the domain —
 * so "lars@trieloff.net" reads as "LT".
 */
export function initialsFromLabel(name: string | undefined | null): string {
  const raw = (name ?? '').trim();
  if (!raw) return '';
  const s = raw.replace(/\s*\([^)]*\)\s*$/, '').trim() || raw;

  const at = s.indexOf('@');
  if (at > 0) {
    const local = s.slice(0, at);
    const domain = s.slice(at + 1);
    const segs = local.split(/[._+-]/).filter(Boolean);
    const first = segs[0]?.[0] ?? local[0] ?? '';
    const second =
      segs.length > 1 ? segs[segs.length - 1][0] : (domain.match(/[a-z0-9]/i)?.[0] ?? '');
    return (first + second).toUpperCase();
  }

  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
