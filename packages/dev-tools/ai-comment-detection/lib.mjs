/*
 * AI-comment detection — pure logic.
 *
 * Classifies each contribution on a PR thread (the PR body plus every comment
 * and review) as human or bot/AI, then decides which thread label applies. The
 * classifier runs a cost-ordered cascade — cheap account checks first, then a
 * markdown-density heuristic, then similarity to sibling comments, and only as
 * a last resort an injected Pangram AI-detection call. This module is free of
 * I/O so it can be unit-tested in isolation; the GitHub and Pangram network
 * calls live in `detect-comment-authors.mjs`.
 */

export const AI_GENERATED_LABEL = 'ai-generated';
export const HUMAN_IN_THE_LOOP_LABEL = 'human-in-the-loop';

/** Logins we always treat as bots regardless of the other signals. */
export const DEFAULT_BOT_LOGINS = new Set(
  [
    'github-actions',
    'dependabot',
    'renovate',
    'codecov',
    'copilot',
    'github-copilot',
    'claude',
    'claude-bot',
    'codex',
    'cursor',
    'devin',
    'sweep',
    'augment',
    'augment-agent',
    'augment-code',
  ].map((s) => s.toLowerCase())
);

const BOT_LOGIN_PATTERNS = [/\[bot\]$/i, /-bot$/i, /^bot-/i, /-ci$/i];

/** Markdown feature patterns; their match count drives the density score. */
const MARKDOWN_PATTERNS = [
  /\*\*[^*\n]+\*\*/g, // bold
  /__[^_\n]+__/g, // bold (underscore)
  /`[^`\n]+`/g, // inline code
  /```/g, // code fence
  /^\s{0,3}#{1,6}\s/gm, // heading
  /^\s*[-*+]\s+/gm, // unordered list item
  /^\s*\d+\.\s+/gm, // ordered list item
  /\[[^\]\n]+\]\([^)\n]+\)/g, // link
  /^\s*>\s?/gm, // blockquote
  /^\s*\|.*\|\s*$/gm, // table row
  /^\s*([-*_])\1{2,}\s*$/gm, // horizontal rule
];

/**
 * True if a login looks like a bot account (suffix/prefix patterns or a
 * known bot login). Tolerant of null/undefined.
 * @param {string|null|undefined} login
 * @param {Set<string>} [knownBots]
 */
export function isBotLogin(login, knownBots = DEFAULT_BOT_LOGINS) {
  const name = String(login ?? '').trim();
  if (!name) return false;
  if (knownBots.has(name.toLowerCase())) return true;
  return BOT_LOGIN_PATTERNS.some((re) => re.test(name));
}

/**
 * Cheap account-level bot check: GitHub user `type === 'Bot'`, a comment made
 * through a GitHub App (app token), or a bot-looking login.
 * @param {{login?: string, type?: string, viaApp?: boolean}} author
 * @param {Set<string>} [knownBots]
 */
export function isBotAccount({ login, type, viaApp } = {}, knownBots = DEFAULT_BOT_LOGINS) {
  if (type && String(type).toLowerCase() === 'bot') return true;
  if (viaApp) return true;
  return isBotLogin(login, knownBots);
}

/**
 * Markdown-formatting density: number of markdown feature occurrences per word.
 * Heavily formatted comments (many headings/bullets/bold) score high.
 * @param {string|null|undefined} text
 * @returns {number} occurrences per word (0 for empty text)
 */
export function markdownDensity(text) {
  const body = String(text ?? '');
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  let count = 0;
  for (const re of MARKDOWN_PATTERNS) {
    const m = body.match(re);
    if (m) count += m.length;
  }
  return count / words;
}

/** Lowercased word-token set for similarity comparison. */
export function tokenize(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

/** Jaccard similarity between two token sets (0..1). */
export function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const tok of a) if (b.has(tok)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Highest Jaccard similarity between `text` and any string in `corpus`.
 * @param {string} text
 * @param {string[]} corpus other comment bodies to compare against
 */
export function maxSimilarity(text, corpus = []) {
  const target = tokenize(text);
  if (target.size === 0) return 0;
  let max = 0;
  for (const other of corpus) {
    const sim = jaccardSimilarity(target, tokenize(other));
    if (sim > max) max = sim;
  }
  return max;
}

/**
 * Interpret a Pangram detection result. Supports the async task schema
 * (`fraction_ai` + `fraction_ai_assisted`) and the v3 sync schema
 * (`ai_likelihood`). Returns `available: false` when the result is unusable.
 * @param {object|null|undefined} result
 * @param {number} [threshold]
 */
export function interpretPangram(result, threshold = 0.5) {
  if (!result || result.stage === 'STAGE_FAILED')
    return { isAi: false, score: 0, available: false };
  const raw =
    result.ai_likelihood ??
    Number(result.fraction_ai ?? 0) + Number(result.fraction_ai_assisted ?? 0);
  const score = Number(raw);
  if (!Number.isFinite(score)) return { isAi: false, score: 0, available: false };
  return { isAi: score >= threshold, score, available: true };
}

/**
 * Whether a Pangram HTTP status is worth retrying: only transient rate-limit
 * (429) or server (5xx) errors. Client errors (400/401/402/403/413/422) are
 * terminal — a retry can't fix a bad key, no credits, or invalid input — so the
 * call fails fast to the human default rather than burning the poll budget.
 * @param {number} status
 */
export function isRetryablePangramStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Markdown-density above which a comment is treated as machine-formatted.
 * Tuned against a 395-contribution sample across the ai-ecoverse org validated
 * with Pangram: at 0.15 the flag was 96% precise but missed AI-written prose
 * clustered in the 0.11–0.15 band (genuine human replies topped out at ~0.105),
 * so 0.12 closes most of that recall gap without crossing the human cluster.
 */
export const MARKDOWN_DENSITY_THRESHOLD = 0.12;
/** Jaccard similarity above which a comment is treated as a templated dupe. */
export const SIMILARITY_THRESHOLD = 0.8;

/**
 * Classify a single contribution as human or bot/AI by running the cost-ordered
 * cascade: cheap account check, then markdown density, then similarity to the
 * sibling corpus, and finally (only if nothing else fired) the injected Pangram
 * call. When Pangram is absent or unavailable the contribution defaults to
 * human so the thread is never labelled AI on a missing signal.
 * @param {object} opts
 * @param {string} [opts.login] author login
 * @param {string} [opts.type] GitHub author type (`User` / `Bot`)
 * @param {boolean} [opts.viaApp] comment posted through a GitHub App token
 * @param {string} [opts.body] comment text
 * @param {string[]} [opts.corpus] sibling comment bodies for similarity
 * @param {(text: string) => Promise<object|null>} [opts.pangram] Pangram caller
 * @param {Set<string>} [opts.knownBots]
 * @returns {Promise<{isHuman: boolean, method: string, score?: number}>}
 */
export async function classifyComment({
  login,
  type,
  viaApp,
  body = '',
  corpus = [],
  pangram,
  knownBots = DEFAULT_BOT_LOGINS,
} = {}) {
  if (isBotAccount({ login, type, viaApp }, knownBots)) {
    return { isHuman: false, method: 'account' };
  }
  const density = markdownDensity(body);
  if (density >= MARKDOWN_DENSITY_THRESHOLD) {
    return { isHuman: false, method: 'markdown-density', score: density };
  }
  const similarity = maxSimilarity(body, corpus);
  if (similarity >= SIMILARITY_THRESHOLD) {
    return { isHuman: false, method: 'similarity', score: similarity };
  }
  if (typeof pangram === 'function') {
    const verdict = interpretPangram(await pangram(body));
    if (verdict.available) {
      return { isHuman: !verdict.isAi, method: 'pangram', score: verdict.score };
    }
  }
  return { isHuman: true, method: 'default-human' };
}

/**
 * Decide the thread-level labels from per-contribution verdicts. A thread with
 * at least one human contribution is `human-in-the-loop`; a thread that is
 * entirely bot/AI is `ai-generated`. An empty thread changes nothing.
 * @param {Array<{isHuman: boolean}>} verdicts
 * @returns {{add: string[], remove: string[]}}
 */
export function decideLabels(verdicts = []) {
  if (verdicts.length === 0) return { add: [], remove: [] };
  const hasHuman = verdicts.some((v) => v.isHuman);
  return hasHuman
    ? { add: [HUMAN_IN_THE_LOOP_LABEL], remove: [AI_GENERATED_LABEL] }
    : { add: [AI_GENERATED_LABEL], remove: [HUMAN_IN_THE_LOOP_LABEL] };
}

/**
 * `human-in-the-loop` is sticky: once any human has contributed to a thread,
 * later bot/AI activity can never make it fully AI again. So when the label is
 * already present the thread needs no reclassification, and the driver can skip
 * all remaining I/O (comment fetches and Pangram calls) entirely.
 * @param {string[]} currentLabels label names already on the thread
 */
export function isThreadSettledHuman(currentLabels = []) {
  return currentLabels.includes(HUMAN_IN_THE_LOOP_LABEL);
}
