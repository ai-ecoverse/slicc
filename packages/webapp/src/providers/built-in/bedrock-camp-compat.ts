/**
 * Bedrock-camp model-compatibility helpers, dependency-free.
 *
 * These exist separately from `bedrock-camp.ts` because that module
 * statically imports pi-ai's compat/streaming layer (~400 kB minified).
 * The eagerly loaded `account-store.ts` needs only these pure helpers to
 * filter the model picker; importing them from `bedrock-camp.ts` would
 * hoist the whole provider engine into BOTH realms' boot-critical eager
 * graphs (page paint + kernel-worker-ready). The first-load ratchet
 * (`check-first-load-size.mjs`) guards this edge staying cut — add no
 * provider/pi-ai imports here.
 *
 * `bedrock-camp.ts` still carries its own private copies of these
 * helpers (the file is on the boy-scout debt lists, so it cannot be
 * edited without paying all its debt down; consolidating on this module
 * is that PR's job). Until then
 * `tests/providers/bedrock-camp-compat.test.ts` asserts the two
 * implementations agree — change both together.
 */

// Picker filter: keep only Claude 4.x and newer on an inference-profile prefix
// that is reachable from the configured endpoint region.
//
// 1. Inference profile (us./eu./global./apac./au./jp.) — bare anthropic.* 400s with
//    "on-demand throughput isn't supported".
// 2. Claude 4.x and newer, plus a narrow allowlist — older Claude 3.x are
//    weaker at resisting prompt injection; most non-Claude Bedrock models
//    (Nova, Llama, Writer, …) are similarly risky, and DeepSeek R1
//    specifically 400s on toolConfig ("This model doesn't support tool use")
//    which breaks the agent loop. The version group is open-ended so a new
//    Claude generation (5, 6, …) lands in the picker with no edit here; new
//    *families* still have to be added to the alternation (as `fable` was).
//    Non-Claude stays DEFAULT-DENY: an id earns its place in
//    BEDROCK_CAMP_ALLOWED_NON_CLAUDE_RE only after being verified live.
// 3. Region must match the endpoint — e.g. `eu.*` IDs 400 with "invalid
//    model identifier" when sent to a `us-*` runtime, and vice versa
//    (confirmed: `jp.anthropic.claude-sonnet-4-6` 400s on the `us-west-2`
//    runtime but only 403s on `ap-northeast-1`, i.e. the id resolves there).
//    `global.*` works anywhere.
//
//    The country prefixes are narrower than the continent ones and do NOT
//    map to a `startsWith` — `jp` is Japan only, so it must not swallow
//    `ap-northeast-2` (Seoul), and `au` is Australia only. Enumerated from
//    `GET /inference-profiles` per region: ap-northeast-1 serves
//    `apac|jp|global`, ap-southeast-2 serves `apac|au|global`, and
//    ap-southeast-1 / ap-south-1 serve `apac|global` with no country tier.
const BEDROCK_CAMP_INFERENCE_PROFILE_RE = /^(us|eu|global|apac|au|jp)\./;
const BEDROCK_CAMP_CLAUDE_RE = /\.anthropic\.claude-(opus|sonnet|haiku|fable)-(?:[4-9]|\d\d)/;
// Verified live on `bedrock-runtime.us-west-2` (see `docs/pitfalls.md` §5):
// openai.gpt-5.6-{sol,terra,luna} do implicit prompt caching — cacheWrite on
// the first call, cacheRead on every repeat, including with a system prompt
// and toolConfig attached — and emit tool calls reliably.
//
// The bar for this list is prompt caching, which is why xai.grok-4.6 is NOT
// here: it is functional (200s, tool calls) but cached on only 2 of 15
// attempts at ~18-20k tokens, so it would bill full input on nearly every
// turn. Re-measure before adding it.
//
// gpt-5.6 rejects `temperature` and every `additionalModelRequestFields`
// thinking shape; `temperature-support.ts` and
// `buildAdditionalModelRequestFields` already handle both. It does not accept
// an explicit `cachePoint` block either — caching is automatic and sending one
// 403s.
//
// Anchored and spelled out per variant on purpose. A looser `gpt-5[.-]6-`
// would auto-admit any future `*.openai.gpt-5.6-*` the catalogue gains — the
// exact default-deny hole this list exists to avoid — and would accept the
// `gpt-5-6-` spelling, which no Bedrock id uses and which was never verified.
const BEDROCK_CAMP_ALLOWED_NON_CLAUDE_RE = /\.openai\.gpt-5\.6-(?:sol|terra|luna)$/;
// Matches standard (us-east-1), FIPS (us-east-1-fips) and China
// (cn-north-1.amazonaws.com.cn) Bedrock runtime hosts.
const BEDROCK_RUNTIME_HOST_RE =
  /bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/i;

export function bedrockCampRegionFromBaseUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const { hostname } = new URL(baseUrl);
    return hostname.toLowerCase().match(BEDROCK_RUNTIME_HOST_RE)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Japan-only and Australia-only inference profiles, listed exhaustively. */
const JP_REGIONS = new Set(['ap-northeast-1', 'ap-northeast-3']);
const AU_REGIONS = new Set(['ap-southeast-2', 'ap-southeast-4']);

function profileMatchesRegion(prefix: string, region: string): boolean {
  if (prefix === 'global') return true;
  if (prefix === 'us') return region.startsWith('us-');
  if (prefix === 'eu') return region.startsWith('eu-');
  if (prefix === 'apac') return region.startsWith('ap-');
  if (prefix === 'jp') return JP_REGIONS.has(region);
  if (prefix === 'au') return AU_REGIONS.has(region);
  return false;
}

/**
 * True when a picker-visible id is an Anthropic Claude model.
 *
 * `buildAdditionalModelRequestFields` emits a thinking shape ONLY for Claude,
 * so effort control (low/medium/high/xhigh) never reaches the wire for the
 * allowlisted non-Claude models — every level would produce a byte-identical
 * request. The UI gates its thinking-level selector on `model.reasoning`
 * (`no-thinking` in `wc-nav.ts` / `wc-live-thinking-hydration.ts`), so
 * `account-store.ts` uses this to clear that flag and hide a control that
 * does nothing. It does NOT suppress rendering of `reasoningContent` — gpt-5.6
 * still reasons, it just cannot be told how hard.
 */
export function isBedrockCampClaudeModel(model: { id: string }): boolean {
  return BEDROCK_CAMP_CLAUDE_RE.test(model.id);
}

export function isBedrockCampCompatible(model: { id: string }, region?: string | null): boolean {
  if (!BEDROCK_CAMP_INFERENCE_PROFILE_RE.test(model.id)) return false;
  if (
    !BEDROCK_CAMP_CLAUDE_RE.test(model.id) &&
    !BEDROCK_CAMP_ALLOWED_NON_CLAUDE_RE.test(model.id)
  ) {
    return false;
  }
  if (!region) return true; // no endpoint configured yet — stay permissive
  const prefix = model.id.split('.', 1)[0];
  return profileMatchesRegion(prefix, region);
}
