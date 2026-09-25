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
 *
 * The module also derives the SOCIAL CARD GitHub already renders for one of
 * its pages ({@link githubCardFor}) — see the note on {@link githubCardImage}.
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
  'account',
  'apps',
  'codespaces',
  'collections',
  'copilot',
  'customer-stories',
  'dashboard',
  'discussions',
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
  'projects',
  'pulls',
  'issues',
  'search',
  'security',
  'settings',
  'sponsors',
  'stars',
  'topics',
  'trending',
  'users',
  'watching',
]);

function isRepoName(owner: string, repo: string): boolean {
  return !RESERVED_OWNERS.has(owner.toLowerCase()) && repo !== '.' && repo !== '..';
}

function normalizeRepo(repo: string): string {
  return repo.replace(/\.git$/i, '');
}

/** The URL, if it is a github.com page; `null` for anything else. */
function githubUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return null;
  return parsed;
}

/** `https://github.com/o/r/pull/12` → the reference it names, or `null`. */
export function parseGithubUrl(url: string): GithubRef | null {
  const parsed = githubUrl(url);
  if (!parsed) return null;
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
 * GitHub renders a social card for a page at `opengraph.githubassets.com`
 * under the page's OWN path, behind a leading cache-key segment it ignores
 * when rendering. So the card a page's `og:image` names can be addressed from
 * the page's URL alone — no page fetch, and no API token.
 */
function cardImage(path: string): string {
  return `https://opengraph.githubassets.com/slicc/${path}`;
}

/** GitHub's rendered social card for a reference, derived from the reference. */
export function githubCardImage(ref: GithubRef): string {
  return cardImage(
    `${ref.owner}/${ref.repo}/${ref.kind === 'pull' ? 'pull' : 'issues'}/${ref.number}`
  );
}

/** `PR #12`, `Issue #12`, or `#12`. */
export function githubRefLabel(ref: Pick<GithubRef, 'kind' | 'number'>): string {
  if (ref.kind === 'pull') return `PR #${ref.number}`;
  if (ref.kind === 'issue') return `Issue #${ref.number}`;
  return `#${ref.number}`;
}

/** What a github.com URL points at, as far as its social card is concerned. */
export type GithubCardKind =
  | 'repo'
  | 'issue'
  | 'pull'
  | 'discussion'
  | 'commit'
  | 'release'
  | 'project';

/** A GitHub page's own social card, derived from its URL. */
export interface GithubCard {
  kind: GithubCardKind;
  /** Heading, in GitHub's own shorthand (`owner/repo#12`, `owner/repo@abc1234`). */
  title: string;
  /** The rendered card image. */
  image: string;
  /** Short label for the kind (`PR #12`, `Repository`). */
  badge: string;
}

/** The card for an issue or pull request reference. */
export function githubRefCard(ref: GithubRef): GithubCard {
  return {
    kind: ref.kind === 'pull' ? 'pull' : 'issue',
    title: `${ref.owner}/${ref.repo}#${ref.number}`,
    image: githubCardImage(ref),
    badge: githubRefLabel(ref),
  };
}

/** A percent-encoded path segment as prose; an invalid escape stays raw. */
function readable(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Pages owned by an account rather than a repository: project boards
 * (`/orgs/acme/projects/4`, `/users/ada/projects/1`) and org-wide discussions
 * (`/orgs/acme/discussions/7`). `orgs` and `users` are reserved owner names,
 * so these are matched BEFORE the repository shapes below.
 */
const ACCOUNT_PAGE_RE = new RegExp(
  `^/(orgs|users)/(${OWNER})/(projects|discussions)/(\\d{1,7})(?:/|$)`
);

/** A page inside a repository: `/owner/repo` and everything under it. */
const REPO_PAGE_RE = new RegExp(`^/(${OWNER})/(${REPO})(?:/(.*))?$`);

/** The shapes under a repository that have a card of their own. */
const REPO_DISCUSSION_RE = /^discussions\/(\d{1,7})(?:\/|$)/;
const REPO_COMMIT_RE = /^commit\/([0-9a-fA-F]{7,40})(?:\/|$)/;
const REPO_RELEASE_RE = /^releases\/tag\/([^/?#]{1,128})(?:\/|$)/;

/**
 * Routes that serve the file bytes rather than a GitHub HTML page
 * (`/raw/…`, `/releases/download/…`). These have no social card — a link to
 * an image there should preview the image itself, not the repository card a
 * `/blob/…` page would get.
 */
const REPO_RESOURCE_RE = /^(?:raw|releases\/download)\//;

/**
 * The card for a page under `owner/repo`; `rest` is the path below the repo.
 * Issues and pull requests never reach here — {@link parseGithubUrl} claims
 * them first, so their grammar stays in one place. Resource-serving routes
 * return `null` so the caller can fall through to a direct image preview.
 */
function repoPageCard(owner: string, repo: string, rest: string): GithubCard | null {
  if (REPO_RESOURCE_RE.test(rest)) return null;
  const slug = `${owner}/${repo}`;
  const discussion = REPO_DISCUSSION_RE.exec(rest);
  if (discussion) {
    const number = Number(discussion[1] ?? 0);
    return {
      kind: 'discussion',
      title: `${slug}#${number}`,
      image: cardImage(`${slug}/discussions/${number}`),
      badge: `Discussion #${number}`,
    };
  }
  const commit = REPO_COMMIT_RE.exec(rest);
  if (commit) {
    const sha = commit[1] ?? '';
    return {
      kind: 'commit',
      title: `${slug}@${sha.slice(0, 7)}`,
      image: cardImage(`${slug}/commit/${sha}`),
      badge: 'Commit',
    };
  }
  const release = REPO_RELEASE_RE.exec(rest);
  if (release) {
    const tag = release[1] ?? '';
    return {
      kind: 'release',
      title: `${slug}@${readable(tag)}`,
      image: cardImage(`${slug}/releases/tag/${tag}`),
      badge: 'Release',
    };
  }
  // Every other page under a repository — a file, a tree, the actions tab —
  // carries the repository's own card, which is what GitHub serves for them.
  return { kind: 'repo', title: slug, image: cardImage(slug), badge: 'Repository' };
}

/**
 * The social card for a github.com URL, or `null` when the URL names no page
 * with one (a site page, another host, a search). Purely derived: nothing is
 * fetched, so a hover has a rich card before any network work begins — and
 * still has one in a float with no fetch route at all.
 */
export function githubCardFor(url: string): GithubCard | null {
  const ref = parseGithubUrl(url);
  if (ref) return githubRefCard(ref);

  const parsed = githubUrl(url);
  if (!parsed) return null;

  const account = ACCOUNT_PAGE_RE.exec(parsed.pathname);
  if (account) {
    const [, prefix = '', owner = '', page = '', number = '0'] = account;
    // Only an organization has account-wide discussions; `/users/…/discussions`
    // is not a page, and a card for it would 404.
    if (page === 'discussions' && prefix !== 'orgs') return null;
    const project = page === 'projects';
    return {
      kind: project ? 'project' : 'discussion',
      title: `${owner}#${number}`,
      image: cardImage(`${prefix}/${owner}/${page}/${number}`),
      badge: `${project ? 'Project' : 'Discussion'} #${number}`,
    };
  }

  const repo = REPO_PAGE_RE.exec(parsed.pathname);
  if (!repo) return null;
  const [, owner = '', rawRepo = '', rest = ''] = repo;
  if (!isRepoName(owner, rawRepo)) return null;
  return repoPageCard(owner, normalizeRepo(rawRepo), rest);
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
