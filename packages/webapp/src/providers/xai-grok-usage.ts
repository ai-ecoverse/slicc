/**
 * Pure xAI Grok billing client — the rolling SuperGrok allowance.
 *
 * Grok does not meter this account per token: a SuperGrok / SuperGrok Heavy
 * subscription hands out a rolling window, and the number the grok.com
 * Settings → Usage tab shows ("23% used · Weekly SuperGrok Heavy Limit") is
 * the one that actually decides whether the next turn runs. So the provider
 * reports it as a {@link ProviderBudgetWindow} and every cost surface —
 * floatbar pill, cost overlay, monitor, `cost` — headlines the window.
 *
 * ## The endpoint
 *
 * ```
 * GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 * Authorization: Bearer <xai-grok OAuth access token>
 * ```
 *
 * Response (real, redacted):
 *
 * ```json
 * { "config": {
 *     "currentPeriod": { "type": "USAGE_PERIOD_TYPE_WEEKLY",
 *                        "start": "2026-09-04T19:03:46.999237+00:00",
 *                        "end":   "2026-09-11T19:03:46.999237+00:00" },
 *     "creditUsagePercent": 23.0,
 *     "productUsage": [{ "product": "GrokBuild", "usagePercent": 23.0 }],
 *     "billingPeriodEnd": "2026-09-11T19:03:46.999237+00:00" } }
 * ```
 *
 * This is the JSON transcoding of the same backend RPC the grok.com web app
 * calls over gRPC-web (`grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig`),
 * which is binary protobuf and cookie-authenticated — unusable from here. The
 * CLI proxy takes the OAuth token we already hold and needs nothing else: a
 * single GET with only `Authorization` is sufficient (no `x-userid`, no
 * `x-grok-client-*`), and slicc's existing narrower scope set is accepted.
 * Dropping `?format=credits` returns the MONTHLY view instead.
 *
 * `api.x.ai` has no usage endpoint at all (`/v1/usage`, `/v1/billing/usage`
 * and `/v1/rate-limits` all 404 while `/v1/models` answers), so the CLI proxy
 * host is genuinely required rather than a convenience.
 *
 * ## UNOFFICIAL AND UNDOCUMENTED
 *
 * xAI publishes nothing about this route and owes us no stability. Everything
 * below is therefore defensive: the body is size-capped before it is parsed,
 * every field is optional, every number is clamped, and an unrecognised shape
 * degrades to "no window" rather than to a wrong one. A usage lookup must
 * never break a chat turn — see the `getBudgetUsage` contract in `types.ts`,
 * whose cache swallows the throw and keeps the last good reading on screen.
 *
 * Prior art: https://github.com/stnly/pi-grok (`usage.ts`, `safe-fetch.ts`,
 * `bounded-json.ts`), a pi-ai xAI provider that ships this same lookup with
 * the same posture. It resolves `/v1/user` first to forward `x-userid`; we
 * measured that as unnecessary and do not.
 */

import type { ProviderBudgetWindow } from './provider-budget.js';

/** Minimal `fetch` surface, injected so tests need no network. */
export type XaiUsageFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** The credits (rolling-allowance) view. Without the param the route reports months. */
export const XAI_USAGE_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

/** A proxy this slow is not answering; the reading is not worth a stalled poll. */
const USAGE_TIMEOUT_MS = 8_000;

/**
 * Hard cap on the body we will parse. The real payload is a few hundred
 * bytes; anything at this scale is an error page or an interstitial, and
 * `JSON.parse` on an unbounded third-party body is how a decorative counter
 * stalls the worker.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Percent is a protobuf `float` from a route we do not control. Negatives are
 * nonsense and a garbage float must not render as an astronomical pill, so the
 * reading is clamped into a band that still lets a genuine overage (a window
 * legitimately past 100%) through intact.
 */
const MAX_PERCENT = 1_000;

/**
 * The proxy names its own period types and may add more; there is no shape to
 * name until a window has been read out of the body, which is what
 * {@link parseXaiUsage} does.
 */
// biome-ignore lint/plugin: parsed third-party JSON — the proxy owns these field names, narrowed structurally below.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse a `?format=credits` body into a window, or `null` when it carries
 * none.
 *
 * A body without a usable `creditUsagePercent` is not a window: reporting it
 * as 0% would say "nothing used" about a route that said nothing at all, and
 * "we don't know" must not look like "you have your whole week left".
 */
export function parseXaiUsage(payload: unknown): ProviderBudgetWindow | null {
  if (!isRecord(payload)) return null;
  // Tolerate both the documented envelope and a future unwrapped body.
  const config = isRecord(payload.config) ? payload.config : payload;
  const raw = config.creditUsagePercent;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const percent = Math.min(MAX_PERCENT, Math.max(0, raw));

  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  // `USAGE_PERIOD_TYPE_WEEKLY` → `weekly`. The enum is spelled out in full by
  // the JSON transcoding. Unknown members are lowercased rather than rejected,
  // so a future `..._DAILY` reads as `daily` without a code change; a type we
  // cannot name falls back to `billing`, true of every window this route
  // reports.
  const type = period.type;
  const named =
    typeof type === 'string' ? type.replace('USAGE_PERIOD_TYPE_', '').toLowerCase() : '';
  // `currentPeriod.end` is the credits window; `billingPeriodEnd` is the same
  // instant in the payloads we have seen, and the fallback for one where the
  // period block is absent. Anything we cannot turn into an instant is dropped
  // rather than rendered half-parsed.
  const end = period.end ?? config.billingPeriodEnd;
  const resetsAt = typeof end === 'string' && Number.isFinite(Date.parse(end)) ? end : undefined;
  return {
    percent,
    // The route reports consumption, never refusal — there is no
    // `rate-limited` signal in the payload to map. A window at or past its
    // critical threshold is what the surfaces tint on.
    status: 'ok',
    window: named && named !== 'unspecified' ? named : 'billing',
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * Fetch the account's rolling SuperGrok window.
 *
 * Returns `null` for "this account has no such window" — a 404/501 from a
 * route that has moved (this one is unofficial, so plan on it), or a 200
 * carrying nothing parseable. THROWS for a call that failed: the two get
 * different retry clocks upstream, and a proxy that is briefly unreachable
 * must not be written off as budget-less for the next half hour.
 *
 * A 401/403 throws with a re-login message rather than crashing a render
 * path; `budget-window-cache.ts` catches it, keeps the previous reading, and
 * retries in five minutes.
 */
export async function fetchXaiGrokUsage(
  accessToken: string,
  fetchImpl: XaiUsageFetch,
  opts: { timeoutMs?: number } = {}
): Promise<ProviderBudgetWindow | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? USAGE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(XAI_USAGE_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    const { status } = res;
    // 404/501 is the route saying it does not exist — an answer, not a
    // failure, and the likeliest way an undocumented endpoint retires.
    if (status === 404 || status === 501) return null;
    if (!res.ok) {
      // 401/403 is the one failure a user can act on, so it says so; the rest
      // are the cache's business, not the reader's.
      const why = status === 401 || status === 403 ? 're-login required' : 'failed';
      throw new Error(`xAI Grok usage: ${why} (${status})`);
    }
    const body = await res.text();
    // Cap before parsing, not after: the point is to never hand an unbounded
    // third-party string to `JSON.parse`. A 200 that is oversized or is not
    // JSON at all is an interstitial or a login wall, not an outage — "no
    // window" backs the probe off instead of spinning the retry clock.
    if (body.length > MAX_BODY_BYTES) return null;
    try {
      return parseXaiUsage(JSON.parse(body));
    } catch {
      return null;
    }
  } finally {
    clearTimeout(timer);
  }
}
