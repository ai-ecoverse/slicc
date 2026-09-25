export type GithubRefKind = 'issue' | 'pull' | 'unknown';

export interface GithubRef {
  owner: string;
  repo: string;
  number: number;
  kind: GithubRefKind;
}

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

export function githubRefUrl(ref: GithubRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/${ref.kind === 'pull' ? 'pull' : 'issues'}/${ref.number}`;
}

function cardImage(path: string): string {
  return `https://opengraph.githubassets.com/slicc/${path}`;
}

export function githubCardImage(ref: GithubRef): string {
  return cardImage(
    `${ref.owner}/${ref.repo}/${ref.kind === 'pull' ? 'pull' : 'issues'}/${ref.number}`
  );
}

export function githubRefLabel(ref: Pick<GithubRef, 'kind' | 'number'>): string {
  if (ref.kind === 'pull') return `PR #${ref.number}`;
  if (ref.kind === 'issue') return `Issue #${ref.number}`;
  return `#${ref.number}`;
}

export type GithubCardKind =
  | 'repo'
  | 'issue'
  | 'pull'
  | 'discussion'
  | 'commit'
  | 'release'
  | 'project';

export interface GithubCard {
  kind: GithubCardKind;

  title: string;

  image: string;

  badge: string;
}

export function githubRefCard(ref: GithubRef): GithubCard {
  return {
    kind: ref.kind === 'pull' ? 'pull' : 'issue',
    title: `${ref.owner}/${ref.repo}#${ref.number}`,
    image: githubCardImage(ref),
    badge: githubRefLabel(ref),
  };
}

function readable(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const ACCOUNT_PAGE_RE = new RegExp(
  `^/(orgs|users)/(${OWNER})/(projects|discussions)/(\\d{1,7})(?:/|$)`
);

const REPO_PAGE_RE = new RegExp(`^/(${OWNER})/(${REPO})(?:/(.*))?$`);

const REPO_DISCUSSION_RE = /^discussions\/(\d{1,7})(?:\/|$)/;
const REPO_COMMIT_RE = /^commit\/([0-9a-fA-F]{7,40})(?:\/|$)/;
const REPO_RELEASE_RE = /^releases\/tag\/([^/?#]{1,128})(?:\/|$)/;

const REPO_RESOURCE_RE = /^(?:raw|releases\/download)\//;

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

  return { kind: 'repo', title: slug, image: cardImage(slug), badge: 'Repository' };
}

export function githubCardFor(url: string): GithubCard | null {
  const ref = parseGithubUrl(url);
  if (ref) return githubRefCard(ref);

  const parsed = githubUrl(url);
  if (!parsed) return null;

  const account = ACCOUNT_PAGE_RE.exec(parsed.pathname);
  if (account) {
    const [, prefix = '', owner = '', page = '', number = '0'] = account;

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

const QUALIFIED_RE = new RegExp(`(^|[^\\w/.-])(${OWNER})/(${REPO})#(\\d{1,7})\\b`, 'g');
const WORDED_RE = /\b(PRs?|pull requests?|issues?)\s+#?(\d{1,7})\b/gi;

const BARE_RE = /(^|[^\w&/#])#(\d{1,6})\b/g;

function kindOfWord(word: string): GithubRefKind {
  return /^p/i.test(word) ? 'pull' : 'issue';
}

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

export function githubRepoHints(text: string): string[] {
  const hits: Array<{ index: number; slug: string }> = [];

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
