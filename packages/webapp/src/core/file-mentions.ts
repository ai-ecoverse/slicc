/**
 * Finding file names in prose.
 *
 * Agents name files constantly and almost never as full paths — "I'll rewrite
 * the watcher in `check.js`", "see bb.jsh", "packages/webapp/src/main.ts:42".
 * Those names are the most clickable thing in a transcript and today they are
 * inert text.
 *
 * This module does the first half of making them live: it extracts CANDIDATES.
 * It deliberately cannot tell you whether a candidate exists — that answer lives
 * in the VFS and arrives asynchronously (see `file-mention-resolver.ts`). The
 * split matters because the two halves have opposite failure costs: a missed
 * candidate is a link the user never gets, while a false candidate is free as
 * long as nothing downstream renders it until the VFS confirms it. So the
 * heuristic here leans permissive, and verification is what makes it safe.
 *
 * What it will NOT emit, because these produce false positives that verification
 * would have to chase down:
 *
 *  - Sentence-ending words: "done." and "e.g." are not files.
 *  - Version numbers and decimals: `1.2.3`, `3.14`, `v2.0`.
 *  - Domains and URLs: `example.com`, `https://…` — those are already links.
 *  - Ellipses and repeated dots.
 */

/** A file name found in prose, with the span it occupies in the source text. */
export interface FileMentionCandidate {
  /** The matched text exactly as it appeared. */
  raw: string;
  /** The path with any trailing `:line[:col]` suffix removed. */
  path: string;
  /** 1-based line number from a `path:42` suffix, when present. */
  line?: number;
  /** Start offset in the source string (inclusive). */
  start: number;
  /** End offset in the source string (exclusive). */
  end: number;
}

/**
 * Extensions that read as English words and appear at the end of sentences far
 * more often than they appear as files. `.so` and `.in` are real extensions but
 * "and so." / "built.in" cost more than they return.
 */
const WORDY_EXTENSIONS = new Set([
  'so',
  'in',
  'at',
  'is',
  'it',
  'as',
  'be',
  'do',
  'go',
  'me',
  'my',
  'no',
  'of',
  'on',
  'or',
  'to',
  'up',
  'us',
  'we',
  'am',
  'an',
  'by',
  'if',
  'ok',
]);

/**
 * Hosts whose "extension" is a TLD. A bare `example.com` is a link, not a file;
 * a path-shaped `docs.google.com/foo` is still not a file.
 *
 * `.sh` is pointedly ABSENT despite being a TLD: shell scripts are named that
 * way constantly and `sh.ly`-style domains are vanishingly rare in a transcript.
 * When a TLD doubles as a real extension, the extension wins.
 */
const TLD_LIKE = new Set([
  'com',
  'org',
  'net',
  'io',
  'dev',
  'ai',
  'app',
  'co',
  'gov',
  'edu',
  'ly',
  'tv',
  'xyz',
  'cloud',
  'computer',
  'software',
]);

/**
 * Names with no extension that are unambiguously files when they appear alone.
 * Without this list a bare `Makefile` or `Dockerfile` mention is unlinkable,
 * since every other rule keys off a dot.
 */
const EXTENSIONLESS_FILENAMES = new Set([
  'Makefile',
  'Dockerfile',
  'Justfile',
  'Rakefile',
  'Gemfile',
  'Procfile',
  'Brewfile',
  'Vagrantfile',
  'CODEOWNERS',
  'LICENSE',
  'README',
  'CHANGELOG',
  'AGENTS',
]);

/**
 * The candidate shape: an optional directory run, then a base name, then either
 * a dotted extension or nothing, then an optional `:line:col`.
 *
 * Kept readable rather than clever — every class here is doing one job:
 *   - `[\w.-]+\/` repeated  → optional leading directories (`packages/webapp/`)
 *   - `[\w.-]+`             → the base name
 *   - `\.[A-Za-z0-9]{1,12}` → the extension (bounded: `.js`, `.jsh`, `.backup`)
 *   - `(?::\d+){0,2}`       → `:42` / `:42:7` line-column suffixes
 */
const MENTION_RE =
  /(?:^|[\s(['"`<>,;=|])((?:~\/|\.{1,2}\/|\/)?(?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z0-9]{1,12})((?::\d+){0,2})/g;

/** Bare `Makefile`-style names, matched separately since they carry no dot. */
const EXTENSIONLESS_RE = new RegExp(
  `(?:^|[\\s(['"\`<>,;=|])((?:~\\/|\\.{1,2}\\/|\\/)?(?:[\\w.-]+\\/)*(?:${[...EXTENSIONLESS_FILENAMES].join('|')}))\\b`,
  'g'
);

/** Trailing punctuation that belongs to the sentence, not to the file name. */
const TRAILING_PUNCT = /[.,;:!?)\]}'"`>]+$/;

/**
 * Reject a candidate that is really a version, a decimal, a domain, or a word
 * that ended a sentence.
 */
function isPlausibleFile(path: string): boolean {
  // A path segment means someone typed a path — that is strong enough evidence
  // on its own, so the word/version filters below only police bare names.
  const hasDirectory = path.includes('/');

  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return hasDirectory || EXTENSIONLESS_FILENAMES.has(base);

  const stem = base.slice(0, dot);
  const ext = base.slice(dot + 1).toLowerCase();

  if (ext.length === 0) return false;
  // `1.2.3`, `3.14`, `v2.0` — an all-digit extension is a number, not a file.
  if (/^\d+$/.test(ext)) return false;
  // A stem that is nothing but digits/dots is a version string: `1.2.3`.
  if (/^[\d.]+$/.test(stem) && !hasDirectory) return false;

  if (hasDirectory) return true;

  if (WORDY_EXTENSIONS.has(ext)) return false;
  if (TLD_LIKE.has(ext)) return false;
  // `foo..bar` / ellipses.
  if (base.includes('..')) return false;

  return true;
}

/**
 * Extract every plausible file mention from `text`, in order of appearance and
 * without overlaps.
 *
 * The returned spans are offsets into `text`, so a caller can splice links in
 * without re-searching. Nothing here touches the DOM or the VFS — pass the
 * results to a resolver to find out which ones are real.
 */
export function findFileMentions(text: string): FileMentionCandidate[] {
  const found: FileMentionCandidate[] = [];
  const claimed: Array<[number, number]> = [];

  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  const collect = (re: RegExp, withLineSuffix: boolean): void => {
    re.lastIndex = 0;
    let match: RegExpExecArray | null = re.exec(text);
    while (match !== null) {
      const whole = match[0];
      const captured = match[1] ?? '';
      const suffix = withLineSuffix ? (match[2] ?? '') : '';
      // The pattern eats one leading delimiter so it can anchor on a boundary;
      // the candidate itself starts after it.
      const lead = whole.length - captured.length - suffix.length;
      const start = match.index + lead;

      let path = captured;
      // Strip sentence punctuation the regex swept up: "edit main.ts," → main.ts
      const trimmed = path.replace(TRAILING_PUNCT, '');
      if (trimmed.length > 0) path = trimmed;

      const end = start + path.length + suffix.length;

      if (path.length > 0 && isPlausibleFile(path) && !overlaps(start, end)) {
        const lineMatch = /^:(\d+)/.exec(suffix);
        found.push({
          raw: text.slice(start, end),
          path,
          ...(lineMatch ? { line: Number(lineMatch[1]) } : {}),
          start,
          end,
        });
        claimed.push([start, end]);
      }
      // Step back one char so `a.ts b.ts` doesn't lose `b.ts` to the delimiter
      // the first match consumed.
      re.lastIndex = Math.max(re.lastIndex - 1, match.index + 1);
      match = re.exec(text);
    }
  };

  collect(MENTION_RE, true);
  collect(EXTENSIONLESS_RE, false);

  return found.sort((a, b) => a.start - b.start);
}
