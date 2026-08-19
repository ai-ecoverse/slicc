/*
 * Review Responder — pure logic.
 *
 * Our scheduled agents (boy-scout debt, backlog dispatcher, flake hunter) open
 * `automation/*` PRs that Codex, Copilot and this repo's own
 * `claude-pr-review.yml` then review. Nothing used to pick that feedback up —
 * a human had to open a local session and say "take over PR X and address the
 * review comments". This module is the deterministic half of the workflow that
 * closes that loop.
 *
 * The rule/judgement split is the whole point: everything expressible as a rule
 * ("is this PR in scope?", "have we already answered at this SHA?", "is any of
 * this feedback ours?") lives here, pure and unit-tested. Whether a reviewer is
 * actually RIGHT, and what the correct fix is, is judgement and belongs to the
 * model. This module deliberately does not classify a comment as
 * actionable-vs-noise; it only answers "is there unseen feedback from someone
 * other than us?".
 *
 * Cross-run state is GitHub-native, same as the other dispatchers: no state
 * file, no state branch, no Actions cache. "We already responded at this head
 * SHA" is a `<!-- review-response:<sha> -->` marker comment, the same durable
 * dedup technique as `<!-- pr-fix-skip:<sha> -->` in pr-fix-dispatcher.
 *
 * LOOP SAFETY. This workflow's own writes (thread replies + the marker comment)
 * are exactly the events that trigger it. The pure gate is one of the two
 * guards: `normalizeFeedback` drops everything authored by `selfLogin` and
 * everything carrying the response marker, so our own output can never be read
 * back as feedback to respond to. The other guard is the workflow's job `if:`,
 * which never starts a run for a `github-actions[bot]` comment in the first
 * place. Both exist because either alone is one edit away from being lost.
 */

/** Head-branch prefix that puts a PR in scope. v1 does not respond on human PRs. */
export const IN_SCOPE_BRANCH_PREFIX = 'automation/';

/**
 * The login our own output is authored under.
 *
 * CAREFUL: this is NOT "the login whose comments to ignore". On this repo
 * `claude-pr-review.yml` — the house reviewer, and the one whose findings are
 * most specific to this codebase — also posts as `github-actions[bot]`, because
 * `claude-code-action` runs its Bash `gh` under GITHUB_TOKEN. Dropping every
 * comment by this login would therefore make the responder blind to exactly the
 * reviewer it most needs to read. `isSelfOutput` below is the narrow,
 * structural test that separates our replies from that reviewer's findings.
 */
export const DEFAULT_SELF_LOGIN = 'github-actions[bot]';

/**
 * Durable marker recording that we responded at this head SHA. Keyed to the SHA
 * so a decision is made once per SHA: a new push (ours or a human's) produces a
 * new SHA and makes the PR eligible again, exactly like the `pr-fix-skip`
 * marker.
 * @param {string} sha
 * @returns {string}
 */
export function buildResponseMarker(sha) {
  return `<!-- review-response:${sha} -->`;
}

/**
 * Defence-in-depth marker. The workflow posts the summary and the SHA marker as
 * ONE deterministic comment, so in the designed flow every top-level comment we
 * write already carries {@link buildResponseMarker}. This second marker exists
 * for the stray case: the model has `Bash` and could post a top-level comment of
 * its own, which the SHA marker would not cover. Recognising it costs one regex.
 */
export const SUMMARY_MARKER = '<!-- review-response-summary -->';

const RESPONSE_MARKER_RE = /<!--\s*review-response:([0-9a-f]{7,40})\s*-->/gi;
const SUMMARY_MARKER_RE = /<!--\s*review-response-summary\s*-->/i;

/**
 * Bookkeeping comments our OTHER automation posts, recognised by their markers.
 *
 * These are not feedback and must not wake the responder. They exist because the
 * workflow's job `if:` deliberately does NOT exclude `github-actions[bot]` as a
 * triggering author — it cannot, since `claude-pr-review.yml` posts the house
 * review under that same login (see {@link DEFAULT_SELF_LOGIN}). Admitting that
 * login also admits the dispatchers' own notes, so they are filtered here, where
 * the filter is testable, rather than by author.
 *
 * Marker-based on purpose: every one of these comments is written by a
 * deterministic step in this repo that emits a marker by construction, so this
 * cannot rot the way a body-text match would.
 */
const BOOKKEEPING_MARKER_RE = /<!--\s*(pr-fix-skip|backlog-skip|review-response)\b/i;

/**
 * Machine notices that carry no marker and are provably not review feedback.
 *
 * Kept deliberately short, and every entry is something observed on this repo —
 * not a speculative denylist. A filter that silently swallows real feedback is
 * the worst failure this module can have (a `DENYLIST_LABELS` entry once
 * disabled the backlog dispatcher entirely and nothing said so), which is why
 * {@link partitionFeedback} returns everything it drops and the CLI prints it.
 */
const NO_OP_BODY_PATTERNS = [
  {
    label: 'Copilot could-not-review notice',
    // Observed on #2179: Copilot posts a REVIEW whose body says it hit its quota.
    // It is a review by shape and an error message by content; answering it is
    // impossible and waking the model for it is pure cost.
    re: /unable to review this pull request/i,
  },
  {
    label: 'semantic-release publication notice',
    re: /This PR is included in version/i,
  },
];

/** Does this comment body carry the SHA-keyed response marker? */
function hasResponseMarker(body) {
  RESPONSE_MARKER_RE.lastIndex = 0;
  return RESPONSE_MARKER_RE.test(String(body ?? ''));
}

/** Does this body carry either of our markers? */
function hasAnySelfMarker(body) {
  const text = String(body ?? '');
  return hasResponseMarker(text) || SUMMARY_MARKER_RE.test(text);
}

/**
 * Is this item the responder's OWN output, rather than feedback to answer?
 *
 * Author alone cannot decide it (see {@link DEFAULT_SELF_LOGIN}), so the test is
 * structural, and every clause names a thing only the responder produces:
 *   • either of our markers, at any authorship — a relay bot mirroring our
 *     comment must not be able to feed it back to us;
 *   • an inline comment that is a REPLY in an existing thread, authored by us.
 *     The responder only ever replies; the house reviewer's inline comments open
 *     new threads (`in_reply_to_id` absent), because that is what the
 *     `create_inline_comment` MCP tool does.
 *
 * That covers all three shapes of our output by construction: the workflow's ONE
 * top-level comment carries the SHA marker (the summary and the marker are the
 * same deterministically-posted comment, so the model never posts a bare one),
 * inline output is always a reply, and the responder never submits a review.
 * `SUMMARY_MARKER` and the timestamp watermark in {@link decideResponse} are the
 * backstops for a stray model-authored comment.
 * @param {{author?: string, kind?: string, body?: string, inReplyToId?: number|null}} item
 * @param {string} selfLogin
 * @returns {boolean}
 */
export function isSelfOutput(item, selfLogin = DEFAULT_SELF_LOGIN) {
  if (hasAnySelfMarker(item?.body)) return true;
  if (String(item?.author ?? '') !== selfLogin) return false;
  return item?.kind === 'inline' && item?.inReplyToId != null;
}

/**
 * Every head SHA we have already responded at, newest-first order irrelevant.
 * @param {Array<{body?: string}>} issueComments from `GET /issues/{n}/comments`
 * @returns {Set<string>}
 */
export function parseRespondedShas(issueComments = []) {
  const shas = new Set();
  for (const comment of Array.isArray(issueComments) ? issueComments : []) {
    for (const [, sha] of String(comment?.body ?? '').matchAll(RESPONSE_MARKER_RE)) {
      shas.add(sha.toLowerCase());
    }
  }
  return shas;
}

/**
 * When we last responded on this PR, as an ISO timestamp, or null if never.
 *
 * Read from the marker comments rather than from "our newest comment": we post
 * other things too (the pr-fix dispatcher's markers are also authored by
 * `github-actions[bot]`), and using an unrelated comment as the watermark would
 * silently swallow feedback that arrived before it.
 * @param {Array<{body?: string, user?: {login?: string}, created_at?: string, createdAt?: string}>} issueComments
 * @param {string} [selfLogin]
 * @returns {string|null}
 */
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

/** Normalize one API object into a feedback item, or null when it is unusable. */
function toItem(raw, kind) {
  const body = String(raw?.body ?? '').trim();
  const state = raw?.state == null ? undefined : String(raw.state).toUpperCase();
  // A review row with no body is a bare APPROVED/COMMENTED click. There is
  // nothing to answer, and treating it as feedback would make every LGTM
  // trigger a run.
  if (!body) return null;
  const createdAt = raw?.created_at ?? raw?.createdAt ?? raw?.submitted_at ?? raw?.submittedAt;
  // `original_line` is what an inline comment keeps once its line has been
  // outdated by a later push; `line` goes null in that case.
  const line = raw?.line ?? raw?.original_line ?? null;
  const item = {
    id: raw?.id ?? null,
    kind,
    author: String(raw?.user?.login ?? raw?.author ?? ''),
    createdAt: createdAt ? String(createdAt) : null,
    body,
  };
  if (raw?.path != null) item.path = String(raw.path);
  if (line != null) item.line = Number(line);
  if (raw?.in_reply_to_id != null) item.inReplyToId = Number(raw.in_reply_to_id);
  if (state) item.state = state;
  if (raw?.html_url) item.url = String(raw.html_url);
  return item;
}

/**
 * Fold the three feedback endpoints into one chronological list.
 *
 * All THREE are required, and the third is the one that is easy to miss: this
 * repo's own `claude-pr-review.yml` posts its verdict as a top-level ISSUE
 * comment, so `GET /pulls/{n}/reviews` alone sees nothing at all from the house
 * reviewer. Codex/Copilot use review summaries and inline comments; the house
 * reviewer uses inline comments plus a top-level summary — and posts under the
 * SAME login as our own output, which is why the loop guard here is
 * {@link isSelfOutput} (structural) and not a plain author comparison.
 * @param {{
 *   reviews?: Array<object>,
 *   reviewComments?: Array<object>,
 *   issueComments?: Array<object>,
 *   selfLogin?: string,
 * }} input
 * @returns {Array<{id: number|null, kind: 'review'|'inline'|'top-level', author: string, createdAt: string|null, body: string, path?: string, line?: number, inReplyToId?: number, state?: string, url?: string}>}
 */
export function normalizeFeedback(input = {}) {
  return partitionFeedback(input).feedback;
}

/**
 * Why this item is not feedback to answer, or null when it is.
 * @param {object} item
 * @param {string} selfLogin
 * @returns {string|null}
 */
export function dropReason(item, selfLogin = DEFAULT_SELF_LOGIN) {
  if (isSelfOutput(item, selfLogin)) return "the responder's own output";
  const body = String(item?.body ?? '');
  const marker = BOOKKEEPING_MARKER_RE.exec(body);
  if (marker) return `bookkeeping comment from our own automation (${marker[1]})`;
  for (const { label, re } of NO_OP_BODY_PATTERNS) {
    if (re.test(body)) return label;
  }
  return null;
}

/**
 * Same fold as {@link normalizeFeedback}, but also returns what was dropped and
 * why.
 *
 * The dropped list is not diagnostics for their own sake: a filter that quietly
 * removes everything looks exactly like "no feedback arrived", and this repo has
 * already shipped one filter that did precisely that. The CLI prints this, so a
 * run that answers nothing always says which rule was responsible.
 * @param {{reviews?: Array<object>, reviewComments?: Array<object>, issueComments?: Array<object>, selfLogin?: string}} input
 * @returns {{feedback: Array<object>, dropped: Array<{item: object, reason: string}>}}
 */
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

/** Items strictly newer than `since`; all of them when `since` is null. */
function newerThan(items, since) {
  if (!since) return items;
  return items.filter((item) => String(item.createdAt ?? '') > String(since));
}

/**
 * Decide whether to respond to review feedback on one PR, and to what.
 *
 * Every branch carries a human-readable `reason` so the Actions log and
 * `$GITHUB_OUTPUT` explain the decision without anyone re-deriving it.
 * @param {{
 *   state?: string,
 *   isDraft?: boolean,
 *   headRefName?: string,
 *   headRepoFullName?: string|null,
 *   repoFullName?: string,
 *   feedback?: Array<{author?: string, createdAt?: string|null}>,
 *   lastRespondedSha?: string|null,
 *   headSha?: string,
 *   lastResponseAt?: string|null,
 *   selfLogin?: string,
 * }} input
 * @returns {{shouldRespond: boolean, reason: string, items: Array<object>}}
 */
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
    lastResponseAt: since = null,
    selfLogin = DEFAULT_SELF_LOGIN,
  } = input;
  const skip = (reason) => ({ shouldRespond: false, reason, items: [] });

  if (state !== 'open') {
    return skip(`PR is not open (state="${state ?? 'unknown'}").`);
  }
  if (isDraft) {
    return skip('PR is a draft — its author is still working on it.');
  }
  // Secrets are unavailable to fork PRs and this job holds write access, so a
  // fork head is refused before anything else looks at its content. It is also
  // unpushable: the responder pushes to `headRefName` in THIS repository.
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

  // Second application of the loop guard: `normalizeFeedback` already ran it,
  // but this function is also called with hand-built lists (tests, and any
  // future caller that assembles feedback itself), and "never respond to our own
  // output" must not depend on the caller having filtered first.
  const respondableFeedback = (Array.isArray(feedback) ? feedback : []).filter(
    (item) => !dropReason(item, selfLogin)
  );
  if (respondableFeedback.length === 0) {
    return skip('No review feedback from anyone other than us.');
  }

  const unseen = newerThan(respondableFeedback, since);

  // The SHA marker alone is not enough to stop: a reviewer can leave a second
  // round of comments without the branch moving, and that round deserves an
  // answer. Both conditions must hold to skip.
  if (lastRespondedSha && headSha && lastRespondedSha.toLowerCase() === headSha.toLowerCase()) {
    if (unseen.length === 0) {
      return skip(
        `Already responded at head SHA ${headSha.slice(0, 7)} and nothing new has arrived since${since ? ` ${since}` : ''}.`
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
      `All ${respondableFeedback.length} feedback item(s) predate our last response${since ? ` at ${since}` : ''}, and the branch has moved since — nothing unanswered.`
    );
  }

  return {
    shouldRespond: true,
    reason: since
      ? `${unseen.length} feedback item(s) arrived after our last response at ${since}.`
      : `${unseen.length} feedback item(s) and no response from us yet.`,
    items: unseen,
  };
}

/**
 * What was filtered out and why, grouped by reason, for the Actions log.
 * @param {Array<{item: object, reason: string}>} dropped
 * @returns {string}
 */
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

/**
 * One-line-per-item digest for the Actions log and the step summary. Kept here
 * (not in the CLI) so it is covered by the unit tests along with everything
 * else that shapes the decision's presentation.
 * @param {Array<object>} items
 * @param {number} maxBodyChars
 * @returns {string}
 */
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
