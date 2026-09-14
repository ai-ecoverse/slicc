export interface FileMentionCandidate {
  raw: string;

  path: string;

  line?: number;

  start: number;

  end: number;
}

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

const MENTION_RE =
  /(?:^|[\s(['"`<>,;=|])((?:~\/|\.{1,2}\/|\/)?(?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z0-9]{1,12})((?::\d+){0,2})/g;

const EXTENSIONLESS_RE = new RegExp(
  `(?:^|[\\s(['"\`<>,;=|])((?:~\\/|\\.{1,2}\\/|\\/)?(?:[\\w.-]+\\/)*(?:${[...EXTENSIONLESS_FILENAMES].join('|')}))\\b`,
  'g'
);

const TRAILING_PUNCT = /[.,;:!?)\]}'"`>]+$/;

function isPlausibleFile(path: string): boolean {
  const hasDirectory = path.includes('/');

  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return hasDirectory || EXTENSIONLESS_FILENAMES.has(base);

  const stem = base.slice(0, dot);
  const ext = base.slice(dot + 1).toLowerCase();

  if (ext.length === 0) return false;

  if (/^\d+$/.test(ext)) return false;

  if (/^[\d.]+$/.test(stem) && !hasDirectory) return false;

  if (hasDirectory) return true;

  if (WORDY_EXTENSIONS.has(ext)) return false;
  if (TLD_LIKE.has(ext)) return false;

  if (base.includes('..')) return false;

  return true;
}

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

      const lead = whole.length - captured.length - suffix.length;
      const start = match.index + lead;

      let path = captured;

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

      re.lastIndex = Math.max(re.lastIndex - 1, match.index + 1);
      match = re.exec(text);
    }
  };

  collect(MENTION_RE, true);
  collect(EXTENSIONLESS_RE, false);

  return found.sort((a, b) => a.start - b.start);
}
