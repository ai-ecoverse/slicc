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

// Picker filter: keep only Claude 4.x on an inference-profile prefix that
// is reachable from the configured endpoint region.
//
// 1. Inference profile (us./eu./global./apac.) — bare anthropic.* 400s with
//    "on-demand throughput isn't supported".
// 2. Claude 4.x only — older Claude 3.x are weaker at resisting prompt
//    injection; non-Claude Bedrock models (Nova, Llama, Writer, …) are
//    similarly risky, and DeepSeek R1 specifically 400s on toolConfig
//    ("This model doesn't support tool use") which breaks the agent loop.
// 3. Region must match the endpoint — e.g. `eu.*` IDs 400 with "invalid
//    model identifier" when sent to a `us-*` runtime, and vice versa.
//    `global.*` works anywhere.
const BEDROCK_CAMP_INFERENCE_PROFILE_RE = /^(us|eu|global|apac)\./;
const BEDROCK_CAMP_CLAUDE_4_RE = /\.anthropic\.claude-(opus|sonnet|haiku)-4/;
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

function profileMatchesRegion(prefix: string, region: string): boolean {
  if (prefix === 'global') return true;
  if (prefix === 'us') return region.startsWith('us-');
  if (prefix === 'eu') return region.startsWith('eu-');
  if (prefix === 'apac') return region.startsWith('ap-');
  return false;
}

export function isBedrockCampCompatible(model: { id: string }, region?: string | null): boolean {
  if (!BEDROCK_CAMP_INFERENCE_PROFILE_RE.test(model.id)) return false;
  if (!BEDROCK_CAMP_CLAUDE_4_RE.test(model.id)) return false;
  if (!region) return true; // no endpoint configured yet — stay permissive
  const prefix = model.id.split('.', 1)[0];
  return profileMatchesRegion(prefix, region);
}
