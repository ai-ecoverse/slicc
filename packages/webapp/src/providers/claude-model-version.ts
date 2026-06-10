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

export type ClaudeFamily = 'opus' | 'sonnet' | 'haiku';

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

const CLAUDE_VERSION_RE = /(opus|sonnet|haiku)-(\d+)-(\d+)/;

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
        minor: Number(m[3]),
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
 * Adaptive thinking — Claude Opus and Sonnet at version ≥ 4.6 ship with the
 * `thinking: { type: 'adaptive' }` + `output_config.effort` shape (vs. the
 * legacy `thinking: { type: 'enabled', budget_tokens }`).
 */
export function claudeSupportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (!v) return false;
  if (v.family !== 'opus' && v.family !== 'sonnet') return false;
  return compareVersion(v, { major: 4, minor: 6 }) >= 0;
}

/**
 * Native `effort: "xhigh"` tier — Opus introduced this at 4.7 (and later
 * releases inherit it). Opus 4.6 clamps xhigh to `"max"` instead.
 */
export function claudeSupportsNativeXhighEffort(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (v?.family !== 'opus') return false;
  return compareVersion(v, { major: 4, minor: 7 }) >= 0;
}

/**
 * Opus 4.6 specifically clamps xhigh requests to effort `"max"`. Newer Opus
 * versions have native xhigh and older Opus versions don't use adaptive
 * thinking at all, so this is an exact-version predicate.
 */
export function claudeSupportsMaxEffort(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (v?.family !== 'opus') return false;
  return v.major === 4 && v.minor === 6;
}

/**
 * Bedrock rejects `temperature` for Opus ≥ 4.7 with
 * `400 "temperature is deprecated for this model."`. Sonnet and Haiku still
 * accept it on every released version.
 */
export function claudeRejectsTemperature(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (v?.family !== 'opus') return false;
  return compareVersion(v, { major: 4, minor: 7 }) >= 0;
}
