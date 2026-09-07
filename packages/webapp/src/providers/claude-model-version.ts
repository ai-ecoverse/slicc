/**
 * Shared Claude version parsing + capability predicates.
 *
 * Newer Claude releases ship faster than pi-ai's hardcoded model-capability
 * tables (the pinned pi-ai 0.75.3 knows opus-4-6/4-7 + sonnet-4-6 but not
 * opus-4-8, and a future opus-4-9 / sonnet-4-7 / opus-5-x would 502 the same
 * way: Bedrock 400 → Adobe `502 upstream_error` → bare 502 on
 * `/api/fetch-proxy`). Rather than maintain three exact-match string lists
 * across `bedrock-camp.ts`, `adaptive-thinking.ts`, and `temperature-support.ts`,
 * we parse the family + major + minor once and answer capability questions
 * from a version threshold so future releases are handled automatically.
 *
 * A pi-ai bump that learns these models leaves the predicates correct;
 * `adaptive-thinking.ts`'s rewrite hook is already a no-op when pi-ai emits
 * the adaptive shape itself.
 */

export type ClaudeFamily = 'opus' | 'sonnet' | 'haiku' | 'fable';

export interface ClaudeVersion {
  family: ClaudeFamily;
  major: number;
  minor: number;
}

/**
 * Normalize an id/name to comparison candidates: lower-cased, plus a variant
 * with run-together separators (spaces / dots / underscores / colons) collapsed
 * to dashes. Mirrors the matchers in `bedrock-camp.ts` and `temperature-support.ts`
 * so `Claude Opus 4.8`, `claude_opus_4_8`, and `us.anthropic.claude-opus-4-8`
 * all parse the same way.
 */
function matchCandidates(modelId: string, modelName?: string): string[] {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, '-')];
  });
}

/**
 * Match `family-major-minor` or `family-major` (e.g. `sonnet-5` without a
 * minor version, as in pi-ai 0.80.3's `claude-sonnet-5`). The `{1,2}` digit
 * constraint + negative lookahead prevents false positives on legacy IDs like
 * `claude-3-5-sonnet-20241022` where the date suffix would otherwise match.
 */
const CLAUDE_VERSION_RE = /(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/;

/**
 * Parse a Claude family/major/minor out of an id or display name. Returns
 * `null` for non-Claude or unparseable values. The first candidate that
 * matches wins, which means the dash-normalized form is tried alongside the
 * raw lowercase form so display names like "Claude Opus 4.8" succeed.
 */
export function parseClaudeVersion(modelId: string, modelName?: string): ClaudeVersion | null {
  for (const candidate of matchCandidates(modelId, modelName)) {
    const m = candidate.match(CLAUDE_VERSION_RE);
    if (m) {
      return {
        family: m[1] as ClaudeFamily,
        major: Number(m[2]),
        minor: m[3] !== undefined ? Number(m[3]) : 0,
      };
    }
  }
  return null;
}

/** Compare two `{major, minor}` tuples; returns -1/0/1. */
function compareVersion(
  a: { major: number; minor: number },
  b: { major: number; minor: number }
): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  return 0;
}

/**
 * Adaptive thinking — Claude Opus, Sonnet, and Fable at version ≥ 4.6 ship
 * with the `thinking: { type: 'adaptive' }` + `output_config.effort` shape
 * (vs. the legacy `thinking: { type: 'enabled', budget_tokens }`).
 *
 * Haiku is the lone holdout: `us.anthropic.claude-haiku-4-5` 400s with
 * "adaptive thinking is not supported on this model", so it stays on the
 * legacy shape. Excluding by family (rather than listing the adaptive ones)
 * keeps a future Fable/Opus generation correct without an edit.
 */
export function claudeSupportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (!v) return false;
  if (v.family === 'haiku') return false;
  return compareVersion(v, { major: 4, minor: 6 }) >= 0;
}

/**
 * Native `effort: "xhigh"` tier — Opus introduced this at 4.7, Sonnet at 5.0,
 * and Fable has it from its first release (5.0). Opus 4.6 and Sonnet 4.6 clamp
 * xhigh to `"max"` / `"high"` respectively.
 */
export function claudeSupportsNativeXhighEffort(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (!v) return false;
  if (v.family === 'opus') return compareVersion(v, { major: 4, minor: 7 }) >= 0;
  if (v.family === 'sonnet') return compareVersion(v, { major: 5, minor: 0 }) >= 0;
  if (v.family === 'fable') return compareVersion(v, { major: 5, minor: 0 }) >= 0;
  return false;
}

/**
 * Models that clamp xhigh requests to effort `"max"` — Opus 4.6 and
 * Sonnet 4.6, which support `max` but not `xhigh` natively.
 */
export function claudeSupportsMaxEffort(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (!v) return false;
  if (v.family === 'opus') return v.major === 4 && v.minor === 6;
  if (v.family === 'sonnet') return v.major === 4 && v.minor === 6;
  return false;
}

/**
 * Prompt caching (`cachePoint` blocks) — every Claude ≥ 4.x supports it, plus
 * the two legacy 3.x models that were backported (3.7 Sonnet, 3.5 Haiku).
 *
 * This replaced a `candidates.includes('-4-')` substring test in
 * `bedrock-camp.ts`, which silently returned false for `claude-opus-5` /
 * `claude-sonnet-5` / `claude-fable-5` — those have no `-4-` in their id — and
 * so dropped cache points on every Claude 5 request. Verified live on
 * `bedrock-runtime.us-west-2`: all three report a non-zero
 * `cacheWriteInputTokens`.
 */
export function claudeSupportsPromptCaching(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (v) return v.major >= 4;
  return matchCandidates(modelId, modelName).some(
    (s) => s.includes('claude-3-7-sonnet') || s.includes('claude-3-5-haiku')
  );
}

/**
 * Bedrock rejects `temperature` with
 * `400 "\`temperature\` is deprecated for this model."` for Opus ≥ 4.7,
 * Sonnet ≥ 5.0, and every Fable. Haiku still accepts it on every released
 * version (verified against `bedrock-runtime.us-west-2` for opus-5,
 * sonnet-5, fable-5, and haiku-4-5).
 *
 * The deprecation tracks generations, not families: assume a future family
 * ships without `temperature` and add it here when it lands.
 */
export function claudeRejectsTemperature(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (!v) return false;
  if (v.family === 'opus') return compareVersion(v, { major: 4, minor: 7 }) >= 0;
  if (v.family === 'sonnet') return compareVersion(v, { major: 5, minor: 0 }) >= 0;
  if (v.family === 'fable') return true;
  return false;
}
