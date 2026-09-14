export const IN_SCOPE_BRANCH_PREFIX = 'automation/';

export const DEFAULT_SELF_LOGIN = 'github-actions[bot]';

export const TRUSTED_REVIEWER_BOTS = [
  'github-actions[bot]',
  'chatgpt-codex-connector[bot]',
  'copilot-pull-request-reviewer[bot]',
];

export const TRUSTED_AUTHOR_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

export function isTrustedAuthor(item) {
  if (TRUSTED_REVIEWER_BOTS.includes(String(item?.author ?? ''))) return true;
  const association = item?.authorAssociation == null ? '' : String(item.authorAssociation);
  return TRUSTED_AUTHOR_ASSOCIATIONS.includes(association.toUpperCase());
}

export function buildResponseMarker(sha, watermark = 'none') {
  return `<!-- review-response:${sha}:${watermark || 'none'} -->`;
}

export const SUMMARY_MARKER = '<!-- review-response-summary -->';

const RESPONSE_MARKER_RE = /<!--\s*review-response:([0-9a-f]{7,40})(?::([^\s>]+))?\s*-->/gi;
const SUMMARY_MARKER_RE = /<!--\s*review-response-summary\s*-->/i;

const BOOKKEEPING_MARKER_RE = /<!--\s*(pr-fix-skip|backlog-skip|review-response)\b/i;

const NO_OP_BODY_PATTERNS = [
  {
    label: 'Copilot could-not-review notice',

    re: /unable to review this pull request/i,
  },
  {
    label: 'semantic-release publication notice',
    re: /This PR is included in version/i,
  },
];

function hasResponseMarker(body) {
  RESPONSE_MARKER_RE.lastIndex = 0;
  return RESPONSE_MARKER_RE.test(String(body ?? ''));
}

function hasAnySelfMarker(body) {
  const text = String(body ?? '');
  return hasResponseMarker(text) || SUMMARY_MARKER_RE.test(text);
}

export function isSelfOutput(item, selfLogin = DEFAULT_SELF_LOGIN) {
  if (hasAnySelfMarker(item?.body)) return true;
  if (String(item?.author ?? '') !== selfLogin) return false;
  return item?.kind === 'inline' && item?.inReplyToId != null;
}

export function parseRespondedShas(issueComments = []) {
  const shas = new Set();
  for (const comment of Array.isArray(issueComments) ? issueComments : []) {
    for (const { sha } of parseResponseMarkers(comment?.body)) shas.add(sha);
  }
  return shas;
}

function parseResponseMarkers(body) {
  const found = [];

  RESPONSE_MARKER_RE.lastIndex = 0;
  for (const [, sha, watermark] of String(body ?? '').matchAll(RESPONSE_MARKER_RE)) {
    found.push({
      sha: sha.toLowerCase(),
      watermark: watermark && watermark.toLowerCase() !== 'none' ? watermark : null,
    });
  }
  return found;
}

export function lastResponseWatermark(issueComments = [], selfLogin = DEFAULT_SELF_LOGIN) {
  let highest = null;
  for (const comment of Array.isArray(issueComments) ? issueComments : []) {
    if (String(comment?.user?.login ?? comment?.author ?? '') !== selfLogin) continue;
    const postedAt = comment?.created_at ?? comment?.createdAt ?? null;
    for (const { watermark } of parseResponseMarkers(comment?.body)) {
      const stamp = watermark ?? postedAt;
      if (stamp && (highest === null || String(stamp) > highest)) highest = String(stamp);
    }
  }
  return highest;
}

export function feedbackWatermark(items = []) {
  const newest = (Array.isArray(items) ? items : [])
    .map((item) => item?.createdAt)
    .filter(Boolean)
    .map(String)
    .sort()
    .pop();
  return newest ?? 'none';
}

export function lastResponseAt(issueComments = [], selfLogin = DEFAULT_SELF_LOGIN) {
  const stamps = (Array.isArray(issueComments) ? issueComments : [])
    .filter(
      (comment) =>
        String(comment?.user?.login ?? comment?.author ?? '') === selfLogin &&
        hasResponseMarker(comment?.body)
    )
    .map((comment) => comment?.created_at ?? comment?.createdAt ?? null)
    .filter(Boolean)
    .map(String)
    .sort();
  return stamps.pop() ?? null;
}

function toItem(raw, kind) {
  const body = String(raw?.body ?? '').trim();
  const state = raw?.state == null ? undefined : String(raw.state).toUpperCase();

  if (!body) return null;
  const createdAt = raw?.created_at ?? raw?.createdAt ?? raw?.submitted_at ?? raw?.submittedAt;

  const line = raw?.line ?? raw?.original_line ?? null;
  const item = {
    id: raw?.id ?? null,
    kind,
    author: String(raw?.user?.login ?? raw?.author ?? ''),
    createdAt: createdAt ? String(createdAt) : null,
    body,
  };

  const association = raw?.author_association ?? raw?.authorAssociation;
  if (association != null) item.authorAssociation = String(association).toUpperCase();
  if (raw?.path != null) item.path = String(raw.path);
  if (line != null) item.line = Number(line);
  if (raw?.in_reply_to_id != null) item.inReplyToId = Number(raw.in_reply_to_id);
  if (state) item.state = state;
  if (raw?.html_url) item.url = String(raw.html_url);
  return item;
}

export function normalizeFeedback(input = {}) {
  return partitionFeedback(input).feedback;
}

export function dropReason(item, selfLogin = DEFAULT_SELF_LOGIN) {
  if (isSelfOutput(item, selfLogin)) return "the responder's own output";
  const body = String(item?.body ?? '');
  const marker = BOOKKEEPING_MARKER_RE.exec(body);
  if (marker) return `bookkeeping comment from our own automation (${marker[1]})`;
  for (const { label, re } of NO_OP_BODY_PATTERNS) {
    if (re.test(body)) return label;
  }

  if (!isTrustedAuthor(item)) {
    return `untrusted-author (association=${item?.authorAssociation ?? 'none'})`;
  }
  return null;
}

export function partitionFeedback({
  reviews = [],
  reviewComments = [],
  issueComments = [],
  selfLogin = DEFAULT_SELF_LOGIN,
} = {}) {
  const collected = [
    ...(Array.isArray(reviews) ? reviews : []).map((raw) => toItem(raw, 'review')),
    ...(Array.isArray(reviewComments) ? reviewComments : []).map((raw) => toItem(raw, 'inline')),
    ...(Array.isArray(issueComments) ? issueComments : []).map((raw) => toItem(raw, 'top-level')),
  ]
    .filter((item) => item !== null)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));

  const feedback = [];
  const dropped = [];
  for (const item of collected) {
    const reason = dropReason(item, selfLogin);
    if (reason) dropped.push({ item, reason });
    else feedback.push(item);
  }
  return { feedback, dropped };
}

function newerThan(items, since) {
  if (!since) return items;
  return items.filter((item) => String(item.createdAt ?? '') > String(since));
}

export function decideResponse(input = {}) {
  const {
    state,
    isDraft = false,
    headRefName = '',
    headRepoFullName = null,
    repoFullName = '',
    feedback = [],
    lastRespondedSha = null,
    headSha = '',

    respondedWatermark: since = null,
    selfLogin = DEFAULT_SELF_LOGIN,
  } = input;
  const skip = (reason) => ({ shouldRespond: false, reason, items: [] });

  if (state !== 'open') {
    return skip(`PR is not open (state="${state ?? 'unknown'}").`);
  }
  if (isDraft) {
    return skip('PR is a draft — its author is still working on it.');
  }

  if (headRepoFullName !== repoFullName) {
    return skip(
      `Head branch lives in ${headRepoFullName ?? 'a deleted fork'}, not ${repoFullName || 'this repository'} — the responder only acts on same-repo branches.`
    );
  }
  if (!String(headRefName).startsWith(IN_SCOPE_BRANCH_PREFIX)) {
    return skip(
      `Head branch "${headRefName}" is not an ${IN_SCOPE_BRANCH_PREFIX}* branch — v1 only answers reviews on our own agents' PRs.`
    );
  }

  const respondableFeedback = (Array.isArray(feedback) ? feedback : []).filter(
    (item) => !dropReason(item, selfLogin)
  );
  if (respondableFeedback.length === 0) {
    return skip('No review feedback from anyone other than us.');
  }

  const unseen = newerThan(respondableFeedback, since);

  if (lastRespondedSha && headSha && lastRespondedSha.toLowerCase() === headSha.toLowerCase()) {
    if (unseen.length === 0) {
      return skip(
        `Already responded at head SHA ${headSha.slice(0, 7)}, covering everything up to${since ? ` ${since}` : ' now'}, and nothing newer has arrived.`
      );
    }
    return {
      shouldRespond: true,
      reason: `Already responded at head SHA ${headSha.slice(0, 7)}, but ${unseen.length} newer comment(s) arrived since — answering those.`,
      items: unseen,
    };
  }

  if (unseen.length === 0) {
    return skip(
      `All ${respondableFeedback.length} feedback item(s) predate our last response, which covered everything up to${since ? ` ${since}` : ' now'}, and the branch has moved since — nothing unanswered.`
    );
  }

  return {
    shouldRespond: true,
    reason: since
      ? `${unseen.length} feedback item(s) are newer than the ${since} watermark our last response recorded.`
      : `${unseen.length} feedback item(s) and no response from us yet.`,
    items: unseen,
  };
}

export function formatDrops(dropped = []) {
  const byReason = new Map();
  for (const { item, reason } of Array.isArray(dropped) ? dropped : []) {
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(item);
  }
  return [...byReason.entries()]
    .map(([reason, items]) => {
      const authors = [...new Set(items.map((item) => item.author).filter(Boolean))].join(', ');
      return `   ignored ${items.length} × ${reason}${authors ? ` (${authors})` : ''}`;
    })
    .join('\n');
}

export function formatFeedbackDigest(items = [], maxBodyChars = 160) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const where = item.path ? ` ${item.path}${item.line ? `:${item.line}` : ''}` : '';
      const state = item.state ? ` [${item.state}]` : '';
      const body = String(item.body ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxBodyChars);
      return `• ${item.author} (${item.kind}${state})${where} — ${body}`;
    })
    .join('\n');
}
