/**
 * Finding GitHub issue and pull request references in prose, and working out
 * which repository they belong to.
 *
 * Agents write `#123`, `PR 42`, `issue #7`, or — rarely — `owner/repo#123`.
 * Only the last one names its repository. The rest are like a file name with
 * no directory, and the fix is the same one `core/tool-call-paths.ts` uses for
 * files: the turn has usually ALREADY named the repository somewhere — a
 * `gh pr view -R owner/repo`, a `git clone https://github.com/owner/repo`, a
 * GitHub URL in an earlier message, the `origin` remote of the repo it was
 * working in. {@link githubRepoHints} harvests those, and a bare reference is
 * only linked when a repository was found; otherwise it stays text.
 */

/** Whether a reference is known to be an issue, a pull request, or either. */
export type GithubRefKind = 'issue' | 'pull' | 'unknown';

/** A fully-qualified reference. */
export interface GithubRef {
  owner: string;
  repo: string;
  number: number;
  kind: GithubRefKind;
}

/** A reference found in prose; `owner`/`repo` only when the text named them. */
export interface GithubMention {
  start: number;
  end: number;
  raw: string;
  number: number;
  kind: GithubRefKind;
  owner?: string;
  repo?: string;
}

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const REPO = '[A-Za-z0-9._-]{1,100}';

/**
 * Path segments under github.com that are site pages, not owners. A URL like
 * `github.com/settings/tokens` must not become a `settings/tokens` hint.
 */
const RESERVED_OWNERS = new Set([
  'about',
  'apps',
  'collections',
  'customer-stories',
  'enterprise',
  'events',
  'explore',
  'features',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'organizations',
  'pricing',
  'pulls',
  'issues',
  'search',
  'security',
  'settings',
  'sponsors',
  'topics',
  'trending',
]);

function isRepoName(owner: string, repo: string): boolean {
  return !RESERVED_OWNERS.has(owner.toLowerCase()) && repo !== '.' && repo !== '..';
}

function normalizeRepo(repo: string): string {
  return repo.replace(/\.git$/i, '');
}

/** `https://github.com/o/r/pull/12` → the reference it names, or `null`. */
export function parseGithubUrl(url: string): GithubRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return null;
  const match = new RegExp(`^/(${OWNER})/(${REPO})/(issues|pull)/(\\d{1,7})(?:/|$)`).exec(
    parsed.pathname
  );
  if (!match) return null;
  const [, owner = '', repo = '', segment, number = '0'] = match;
  if (!isRepoName(owner, repo)) return null;
  return {
    owner,
    repo: normalizeRepo(repo),
    number: Number(number),
    kind: segment === 'pull' ? 'pull' : 'issue',
  };
}

/**
 * The page for a reference. An unknown kind uses `/issues/`, which GitHub
 * redirects to `/pull/` when the number is a pull request.
 */
export function githubRefUrl(ref: GithubRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/${ref.kind === 'pull' ? 'pull' : 'issues'}/${ref.number}`;
}

/**
 * GitHub's rendered social card for a reference — the same image the page's
 * `og:image` names — derived without fetching the page. The leading path
 * segment is a cache key GitHub ignores for rendering.
 */
export function githubCardImage(ref: GithubRef): string {
  return `https://opengraph.githubassets.com/slicc/${ref.owner}/${ref.repo}/${ref.kind === 'pull' ? 'pull' : 'issues'}/${ref.number}`;
}

/** `PR #12`, `Issue #12`, or `#12`. */
export function githubRefLabel(ref: Pick<GithubRef, 'kind' | 'number'>): string {
  if (ref.kind === 'pull') return `PR #${ref.number}`;
  if (ref.kind === 'issue') return `Issue #${ref.number}`;
  return `#${ref.number}`;
}

// Leading boundaries are CONSUMED as group 1 rather than written as a
// lookbehind (Safari < 16.4 rejects lookbehind at parse time, taking the whole
// module down); the match start is advanced past the group.
const QUALIFIED_RE = new RegExp(`(^|[^\\w/.-])(${OWNER})/(${REPO})#(\\d{1,7})\\b`, 'g');
const WORDED_RE = /\b(PRs?|pull requests?|issues?)\s+#?(\d{1,7})\b/gi;
// Not after a word character (`abc#1`), `&` (an entity), `/` (a URL fragment)
// or another `#` (`##1` is a heading).
const BARE_RE = /(^|[^\w&/#])#(\d{1,6})\b/g;

function kindOfWord(word: string): GithubRefKind {
  return /^p/i.test(word) ? 'pull' : 'issue';
}

/**
 * Every issue/PR reference in `text`, in order, without overlaps. Qualified
 * references win over worded ones, which win over bare `#123`.
 */
export function findGithubMentions(text: string): GithubMention[] {
  const found: GithubMention[] = [];
  const taken = (start: number, end: number): boolean =>
    found.some((m) => start < m.end && end > m.start);

  for (const match of text.matchAll(QUALIFIED_RE)) {
    const [whole, lead = '', owner = '', repo = '', number = '0'] = match;
    const start = (match.index ?? 0) + lead.length;
    const raw = whole.slice(lead.length);
    if (!isRepoName(owner, repo)) continue;
    found.push({
      start,
      end: start + raw.length,
      raw,
      number: Number(number),
      kind: 'unknown',
      owner,
      repo: normalizeRepo(repo),
    });
  }
  for (const match of text.matchAll(WORDED_RE)) {
    const [raw, word = '', number = '0'] = match;
    const start = match.index ?? 0;
    if (taken(start, start + raw.length)) continue;
    found.push({
      start,
      end: start + raw.length,
      raw,
      number: Number(number),
      kind: kindOfWord(word),
    });
  }
  for (const match of text.matchAll(BARE_RE)) {
    const [whole, lead = '', number = '0'] = match;
    const start = (match.index ?? 0) + lead.length;
    const raw = whole.slice(lead.length);
    if (taken(start, start + raw.length)) continue;
    found.push({ start, end: start + raw.length, raw, number: Number(number), kind: 'unknown' });
  }
  return found.sort((a, b) => a.start - b.start);
}

const URL_REPO_RE = new RegExp(
  `github\\.com[/:](${OWNER})/(${REPO}?)(?:\\.git)?(?=$|[/\\s#?"'\`)\\]>,;])`,
  'g'
);
const FLAG_REPO_RE = new RegExp(`(?:^|\\s)(?:-R|--repo)(?:\\s+|=)(${OWNER})/(${REPO})`, 'g');
const GH_REPO_CMD_RE = new RegExp(
  `\\bgh\\s+repo\\s+(?:clone|view|fork|sync)\\s+(${OWNER})/(${REPO})`,
  'g'
);

/**
 * Every `owner/repo` a piece of text names, in order of appearance, deduped.
 * Sources: GitHub URLs (https and ssh remotes), `gh … -R/--repo owner/repo`,
 * `gh repo clone|view|fork owner/repo`, and qualified `owner/repo#12`.
 */
export function githubRepoHints(text: string): string[] {
  const hits: Array<{ index: number; slug: string }> = [];
  // [pattern, owner group, repo group]. A qualified `owner/repo#12` names its
  // repository as surely as a URL does, so a later bare `#13` can lean on it.
  const sources: Array<[RegExp, number, number]> = [
    [URL_REPO_RE, 1, 2],
    [FLAG_REPO_RE, 1, 2],
    [GH_REPO_CMD_RE, 1, 2],
    [QUALIFIED_RE, 2, 3],
  ];
  for (const [re, ownerGroup, repoGroup] of sources) {
    for (const match of text.matchAll(re)) {
      const owner = match[ownerGroup] ?? '';
      const repo = normalizeRepo(match[repoGroup] ?? '');
      if (!owner || !repo || !isRepoName(owner, repo)) continue;
      hits.push({ index: match.index ?? 0, slug: `${owner}/${repo}` });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { slug } of hits) {
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slug);
  }
  return out;
}

/**
 * The reference a mention means, given the repositories the turn named
 * (oldest first). The text's own `owner/repo` wins; otherwise the MOST RECENT
 * hint does, for the same reason a later tool call wins for file paths. With
 * no repository at all, the mention cannot be linked.
 */
export function resolveGithubMention(
  mention: GithubMention,
  repoHints: readonly string[]
): GithubRef | null {
  if (mention.owner && mention.repo) {
    return { owner: mention.owner, repo: mention.repo, number: mention.number, kind: mention.kind };
  }
  const slug = repoHints[repoHints.length - 1];
  if (!slug) return null;
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) return null;
  return { owner, repo, number: mention.number, kind: mention.kind };
}
