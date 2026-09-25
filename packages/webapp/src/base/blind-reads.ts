export type BlindReadKind = 'outside' | 'filtered';

function canonical(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export class BlindReadLog {
  private readonly kinds = new Map<string, BlindReadKind>();
  private readonly unreported = new Set<string>();

  constructor(readonly visiblePaths: readonly string[]) {}

  record(path: string, kind: BlindReadKind): void {
    const key = canonical(path);
    if (this.kinds.has(key)) return;
    this.kinds.set(key, kind);
    this.unreported.add(key);
  }

  outsidePaths(): string[] {
    return [...this.kinds].filter(([, kind]) => kind === 'outside').map(([path]) => path);
  }

  takeNote(): string | undefined {
    if (this.unreported.size === 0) return undefined;
    const outside: string[] = [];
    const filtered: string[] = [];
    for (const path of this.unreported) {
      (this.kinds.get(path) === 'filtered' ? filtered : outside).push(path);
    }
    this.unreported.clear();
    return formatBlindReadNote(this.visiblePaths, outside, filtered);
  }
}

export const BLIND_READ_RULE =
  '"No such file or directory" there means UNKNOWN, not absent: never record such a path as missing, and never refute a stored claim about it.';

export function formatBlindReadNote(
  visiblePaths: readonly string[],
  outside: readonly string[],
  filtered: readonly string[]
): string {
  const roots = visiblePaths.length > 0 ? visiblePaths.join(', ') : '(none)';
  const parts: string[] = [];
  if (outside.length > 0) {
    parts.push(
      `[not visible from this pass] ${outside.join(', ')} — outside visiblePaths (${roots}). ${BLIND_READ_RULE}`
    );
  }
  if (filtered.length > 0) {
    parts.push(
      `[filtered listing] ${filtered.join(', ')} lists only entries leading to visiblePaths (${roots}); anything else there is hidden, not absent.`
    );
  }
  return parts.join('\n');
}

const ABSENCE_MARKERS =
  /\bnot:|\bENOENT\b|no such file|\bnot found\b|\bdoes(?:n't| not) exist|\bno longer exists?\b|\bnever existed\b|\bnon-?existent\b|\bmissing\b|\babsent\b|\bremoved\b|\bdeleted\b|\bgone\b|\bnot (?:present|there|installed|seeded|shipped|in this copy)\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface BlindNegativeClaim {
  line: string;
  path: string;
}

export function findBlindNegativeClaim(
  current: string,
  next: string,
  blindPaths: readonly string[]
): BlindNegativeClaim | null {
  if (blindPaths.length === 0) return null;
  const paths = blindPaths.map(canonical).filter((path) => path.length > 1);
  if (paths.length === 0) return null;
  const existing = new Set(current.split('\n').map((line) => line.trim()));
  for (const raw of next.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || existing.has(line)) continue;
    for (const path of paths) {
      if (!line.includes(path)) continue;
      const notBefore = new RegExp(`\\bnot\\s+[\`"'(]*${escapeRegExp(path)}`, 'i');
      if (ABSENCE_MARKERS.test(line) || notBefore.test(line)) return { line, path };
    }
  }
  return null;
}
