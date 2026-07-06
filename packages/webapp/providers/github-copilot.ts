/**
 * GitHub Copilot Provider — device-flow login + Copilot-backed LLM access.
 *
 * Why this is separate from `github.ts`:
 *   GitHub's `copilot_internal/v2/token` endpoint is gated on the OAuth
 *   client ID itself. Slicc's general-purpose GitHub OAuth App is not on
 *   the allowlist — all calls return 404 regardless of token scopes or
 *   subscription tier. The only public way to get a Copilot-eligible
 *   token is GitHub's device-code flow with the well-known VS Code
 *   Copilot Chat client ID (`Iv1.b507a08c87ecfe98`). That's what every
 *   third-party Copilot client (Aider, Continue, opencode, pi-mono, …)
 *   does. This provider implements exactly that flow, then reuses pi-ai's
 *   `github-copilot` provider machinery for streaming.
 *
 * Login UX:
 *   We piggy-back on `onOAuthLoginIntercepted` / the controlled-browser
 *   `InterceptingOAuthLauncher` (same pattern `oauth-token --intercept`
 *   exposes to the shell). The flow:
 *     1. POST `/login/device/code` to receive `device_code`, `user_code`,
 *        `verification_uri`.
 *     2. Open `https://github.com/login/device?user_code=XXXX-XXXX` in a
 *        fresh controlled-browser tab via the launcher. The user just
 *        clicks "Continue" → "Authorize <VS Code app>". The launcher
 *        auto-closes the tab when the post-authorize success page loads.
 *     3. Poll `/login/oauth/access_token` in parallel until GitHub issues
 *        the access token (typically <1s after the user clicks Authorize).
 *     4. Exchange that token for a short-lived Copilot token at
 *        `api.github.com/copilot_internal/v2/token`, save under this
 *        provider's account.
 *
 * Streaming:
 *   Pi-mono's anthropic / openai-completions / openai-responses providers
 *   already have built-in `model.provider === "github-copilot"` branches
 *   that send the right Bearer auth + dynamic VS Code Chat headers. Our
 *   wrappers just restore the underlying api / baseUrl / headers that
 *   slicc's getModelIds branch overrides with the slicc custom api name,
 *   then delegate.
 */

import type { Api, Context, Model } from '@earendil-works/pi-ai';
import {
  createAssistantMessageEventStream,
  getModel,
  getModels,
  registerApiProvider,
  streamAnthropic,
  streamOpenAICompletions,
  streamOpenAIResponses,
  streamSimpleAnthropic,
  streamSimpleOpenAICompletions,
  streamSimpleOpenAIResponses,
} from '@earendil-works/pi-ai/compat';
import type {
  DeviceCodePrompter,
  InterceptingOAuthLauncher,
  ModelMetadata,
  OAuthLoginOptions,
  ProviderConfig,
} from '../src/providers/types.js';
import { getAccounts, saveOAuthAccount } from '../src/ui/provider-settings.js';

// ── Constants ──────────────────────────────────────────────────────

const PROVIDER_ID = 'github-copilot';

/**
 * Public VS Code Copilot Chat OAuth App client ID. Hardcoded here (and in
 * pi-mono and every other third-party Copilot client) because it's the only
 * client GitHub authorizes to call `copilot_internal/v2/token`. Base64
 * encoded to mirror pi-mono's convention — not a security measure, just to
 * avoid trivial secret-scanner false positives in the public repo.
 */
const VSCODE_COPILOT_CLIENT_ID = atob('SXYxLmI1MDdhMDhjODdlY2ZlOTg=');

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

/** Mirrors the VS Code Copilot Chat extension's identifying headers. */
const COPILOT_EXCHANGE_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};

/** Headers GitHub expects on the device-code / token POSTs. */
const DEVICE_FLOW_POST_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
};

/**
 * After the user clicks "Authorize" on the device flow, GitHub navigates the
 * tab to `https://github.com/login/device/success` (with the user_code as a
 * query param). Capturing that URL via the intercepting launcher gives us a
 * clean tab-close signal — we don't need its body, just the navigation event.
 */
const DEVICE_SUCCESS_PATTERN = 'https://github.com/login/device/success*';

// ── Types ──────────────────────────────────────────────────────────

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  refresh_in?: number;
  sku?: string;
  copilot_plan?: string;
  chat_enabled?: boolean;
  endpoints?: { api?: string };
}

interface PersistedCopilot {
  copilotToken: string;
  expiresAtMs: number;
  apiBaseUrl: string;
  githubAccessToken: string;
}

// ── Account access ─────────────────────────────────────────────────

function getCopilotAccount() {
  return getAccounts().find((a) => a.providerId === PROVIDER_ID);
}

// ── Device flow ────────────────────────────────────────────────────

async function startDeviceFlow(): Promise<DeviceCodeResponse> {
  const res = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: DEVICE_FLOW_POST_HEADERS,
    body: new URLSearchParams({
      client_id: VSCODE_COPILOT_CLIENT_ID,
      scope: 'read:user',
    }),
  });
  if (!res.ok) {
    throw new Error(
      `GitHub device-code request failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => '')}`
    );
  }
  const data = (await res.json()) as DeviceCodeResponse;
  if (
    typeof data.device_code !== 'string' ||
    typeof data.user_code !== 'string' ||
    typeof data.verification_uri !== 'string' ||
    typeof data.expires_in !== 'number' ||
    typeof data.interval !== 'number'
  ) {
    throw new Error('GitHub device-code response had an unexpected shape');
  }
  return data;
}

/**
 * Poll `/login/oauth/access_token` until GitHub issues a token or the device
 * code expires. Returns the access token on success. Honors the `slow_down`
 * error by backing off; cancels cleanly when `signal` aborts.
 */
async function pollForGitHubAccessToken(
  device: DeviceCodeResponse,
  signal: AbortSignal
): Promise<string> {
  const deadline = Date.now() + device.expires_in * 1000;
  // Mirror pi-mono's pacing — the first wait gets a 1.2x buffer to stay
  // safely above GitHub's stated interval.
  let intervalMs = Math.max(1000, Math.floor(device.interval * 1000));
  let multiplier = 1.2;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('Copilot login cancelled');
    await abortableSleep(Math.ceil(intervalMs * multiplier), signal);

    const res = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: DEVICE_FLOW_POST_HEADERS,
      body: new URLSearchParams({
        client_id: VSCODE_COPILOT_CLIENT_ID,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    if (!res.ok) {
      throw new Error(
        `GitHub token poll failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => '')}`
      );
    }
    const data = (await res.json()) as AccessTokenResponse;
    if (typeof data.access_token === 'string' && data.access_token.length > 0) {
      return data.access_token;
    }
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      intervalMs = typeof data.interval === 'number' ? data.interval * 1000 : intervalMs + 5000;
      multiplier = 1.4;
      continue;
    }
    if (data.error) {
      const desc = data.error_description ? `: ${data.error_description}` : '';
      throw new Error(`Device flow failed (${data.error})${desc}`);
    }
  }
  throw new Error('Copilot device flow timed out (device code expired)');
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Copilot login cancelled'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Copilot login cancelled'));
      },
      { once: true }
    );
  });
}

// ── Copilot token exchange ─────────────────────────────────────────

function extractCopilotApiBase(token: string): string | null {
  const m = token.match(/proxy-ep=([^;]+)/);
  if (!m) return null;
  return `https://${m[1].replace(/^proxy\./, 'api.')}`;
}

async function exchangeForCopilotToken(githubAccessToken: string): Promise<PersistedCopilot> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: { ...COPILOT_EXCHANGE_HEADERS, Authorization: `Bearer ${githubAccessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Copilot token exchange failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`
    );
  }
  const data = (await res.json()) as CopilotTokenResponse;
  if (typeof data.token !== 'string' || typeof data.expires_at !== 'number') {
    throw new Error('Copilot token exchange returned an unexpected payload');
  }
  if (data.chat_enabled === false) {
    throw new Error('GitHub Copilot Chat is disabled for this account (no chat features granted)');
  }
  return {
    copilotToken: data.token,
    // Mirror pi-mono's 5-minute safety buffer for refresh.
    expiresAtMs: data.expires_at * 1000 - 5 * 60 * 1000,
    apiBaseUrl: extractCopilotApiBase(data.token) ?? 'https://api.individual.githubcopilot.com',
    githubAccessToken,
  };
}

// ── Live catalog discovery (/models) ───────────────────────────────

/**
 * Subset of GitHub Copilot's `/models` response we actually consume.
 * The endpoint returns far more fields (vision dimensions, tokenizer, etc.);
 * we only persist what slicc needs for picker rendering, policy management,
 * and stream dispatch.
 */
interface CopilotCatalogEntry {
  id: string;
  name: string;
  vendor: string;
  /** Pi-mono-style api shape, derived from supported_endpoints + vendor + id. */
  api: 'anthropic-messages' | 'openai-completions' | 'openai-responses';
  contextWindow: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  /** `enabled` / `disabled` / `unconfigured` — `disabled` requires a policy POST. */
  policyState: 'enabled' | 'disabled' | 'unconfigured' | string;
}

const COPILOT_CATALOG_STORAGE_KEY = 'github-copilot.models.v1';

interface RawCopilotModel {
  id: string;
  name?: string;
  object?: string;
  vendor?: string;
  model_picker_enabled?: boolean;
  preview?: boolean;
  supported_endpoints?: string[];
  policy?: { state?: string };
  capabilities?: {
    type?: string;
    family?: string;
    limits?: {
      max_context_window_tokens?: number;
      max_output_tokens?: number;
      max_prompt_tokens?: number;
    };
    supports?: {
      tool_calls?: boolean;
      streaming?: boolean;
      vision?: boolean;
      adaptive_thinking?: boolean;
      reasoning_effort?: unknown;
    };
  };
}

/**
 * Pick the pi-mono `api` shape from GitHub's catalog entry. Order matters:
 *   1) Anthropic vendors that advertise `/v1/messages` use Anthropic Messages
 *      (better caching + tool semantics on Claude than the OpenAI shape).
 *   2) OpenAI's GPT-5 / o-series / codex line speaks the `/responses` API.
 *   3) Everything else (gpt-4.x, gemini, grok, …) speaks `/chat/completions`.
 */
function pickCopilotApi(raw: RawCopilotModel): CopilotCatalogEntry['api'] {
  const endpoints = raw.supported_endpoints ?? [];
  const vendor = (raw.vendor ?? '').toLowerCase();
  const id = raw.id;
  if (vendor === 'anthropic' && endpoints.includes('/v1/messages')) {
    return 'anthropic-messages';
  }
  if (vendor === 'openai' && (/^gpt-5/i.test(id) || /codex/i.test(id) || /^o\d/i.test(id))) {
    return 'openai-responses';
  }
  return 'openai-completions';
}

function parseCopilotCatalog(json: unknown): CopilotCatalogEntry[] {
  if (!json || typeof json !== 'object') return [];
  const data = (json as { data?: RawCopilotModel[] }).data;
  if (!Array.isArray(data)) return [];
  const out: CopilotCatalogEntry[] = [];
  for (const raw of data) {
    if (raw.capabilities?.type && raw.capabilities.type !== 'chat') continue;
    if (raw.model_picker_enabled === false) continue;
    if (!raw.id) continue;
    out.push({
      id: raw.id,
      name: raw.name ?? raw.id,
      vendor: raw.vendor ?? '',
      api: pickCopilotApi(raw),
      contextWindow:
        raw.capabilities?.limits?.max_context_window_tokens ??
        raw.capabilities?.limits?.max_prompt_tokens ??
        128_000,
      maxTokens: raw.capabilities?.limits?.max_output_tokens ?? 8192,
      supportsTools: raw.capabilities?.supports?.tool_calls === true,
      supportsStreaming: raw.capabilities?.supports?.streaming !== false,
      supportsVision: raw.capabilities?.supports?.vision === true,
      supportsReasoning:
        raw.capabilities?.supports?.adaptive_thinking === true ||
        Array.isArray(raw.capabilities?.supports?.reasoning_effort),
      policyState: raw.policy?.state ?? 'enabled',
    });
  }
  return out;
}

async function fetchCopilotCatalog(creds: PersistedCopilot): Promise<CopilotCatalogEntry[]> {
  const res = await fetch(`${creds.apiBaseUrl}/models`, {
    headers: {
      ...COPILOT_EXCHANGE_HEADERS,
      Authorization: `Bearer ${creds.copilotToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Copilot /models returned ${res.status} ${res.statusText}`);
  }
  return parseCopilotCatalog(await res.json());
}

function loadCachedCopilotCatalog(): CopilotCatalogEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(COPILOT_CATALOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CopilotCatalogEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function storeCachedCopilotCatalog(catalog: CopilotCatalogEntry[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(COPILOT_CATALOG_STORAGE_KEY, JSON.stringify(catalog));
  } catch {
    /* quota or denied — picker still works without persistence */
  }
}

function findCachedCopilotModel(modelId: string): CopilotCatalogEntry | null {
  const cache = loadCachedCopilotCatalog();
  return cache.find((m) => m.id === modelId) ?? null;
}

/**
 * Refresh the catalog AND accept per-model usage policies that gate premium
 * models (Claude, GPT-5, Codex, Gemini, Grok). The /models response tells us
 * which models actually need a `policy.state === 'disabled'` accept; we only
 * POST for those, matching VS Code Copilot Chat's behavior.
 *
 * Best-effort and parallel: errors never block login or other models. The
 * cache is updated even if individual policy accepts fail — the user can
 * still pick non-gated models from the picker.
 */
async function refreshCopilotCatalogAndPolicies(creds: PersistedCopilot): Promise<void> {
  let catalog: CopilotCatalogEntry[];
  try {
    catalog = await fetchCopilotCatalog(creds);
  } catch (err) {
    console.warn(
      '[github-copilot] Catalog refresh failed; keeping previous cache.',
      err instanceof Error ? err.message : String(err)
    );
    return;
  }
  storeCachedCopilotCatalog(catalog);
  await Promise.all(
    catalog
      .filter((m) => m.policyState === 'disabled')
      .map(async (m) => {
        const url = `${creds.apiBaseUrl}/models/${encodeURIComponent(m.id)}/policy`;
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              ...COPILOT_EXCHANGE_HEADERS,
              'Content-Type': 'application/json',
              Authorization: `Bearer ${creds.copilotToken}`,
              'openai-intent': 'chat-policy',
              'x-interaction-type': 'chat-policy',
            },
            body: JSON.stringify({ state: 'enabled' }),
          });
          if (res.ok) {
            m.policyState = 'enabled';
          } else if (res.status !== 404 && res.status !== 400) {
            console.warn(
              `[github-copilot] enable policy for ${m.id} returned ${res.status} ${res.statusText}`
            );
          }
        } catch (err) {
          console.warn(
            `[github-copilot] enable policy for ${m.id} failed:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      })
  );
  storeCachedCopilotCatalog(catalog);
}

async function persistCopilot(creds: PersistedCopilot, userName?: string): Promise<void> {
  await saveOAuthAccount({
    providerId: PROVIDER_ID,
    accessToken: creds.copilotToken,
    refreshToken: creds.githubAccessToken,
    tokenExpiresAt: creds.expiresAtMs,
    baseUrl: creds.apiBaseUrl,
    userName,
  });
}

async function getValidCopilotToken(): Promise<string> {
  const account = getCopilotAccount();
  if (!account?.accessToken || !account.refreshToken) {
    throw new Error('Not logged in to GitHub Copilot — click "Login" in the provider settings');
  }
  const expiresAt = account.tokenExpiresAt ?? 0;
  if (Date.now() < expiresAt - 60_000) return account.accessToken;
  const refreshed = await exchangeForCopilotToken(account.refreshToken);
  await persistCopilot(refreshed, account.userName);
  return refreshed.copilotToken;
}

// ── Models ─────────────────────────────────────────────────────────

// Picker filter: keep only models powerful enough to drive the cone.
//
// Mirrors `isBedrockCampCompatible` in spirit — the cone needs strong
// instruction-following, robust tool use, and resistance to prompt
// injection. Mini/flash/haiku/nano variants reliably break the agent loop
// (truncated tool calls, missed instructions, hallucinated args) even
// when they're listed in GitHub Copilot's /models response.
//
// Excluded patterns (matched against both id and human-readable name,
// after lowercasing + replacing separators with `-`):
//   - `mini`        (gpt-4o-mini, gpt-5-mini, …)
//   - `nano`        (any future *-nano tier)
//   - `flash`       (gemini-*-flash)
//   - `haiku`       (claude-haiku-*)
//   - `lite`        (any future *-lite tier)
//   - `embedding`   (text-embedding-*, not chat at all)
//
// Lowering this bar means the cone silently degrades; users who really
// want a small model can still target it from feed_scoop or the agent
// shell, where the failure mode is contained to a single sub-scoop.
const COPILOT_CONE_EXCLUDE_PATTERNS = ['mini', 'nano', 'flash', 'haiku', 'lite', 'embedding'];

export function isCopilotConeCompatible(model: { id: string; name?: string }): boolean {
  const candidates = [model.id, model.name ?? ''].flatMap((v) => {
    const lower = v.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, '-')];
  });
  return !COPILOT_CONE_EXCLUDE_PATTERNS.some((needle) =>
    candidates.some((s) => s.includes(needle))
  );
}

function buildCopilotModelList(): Array<{ id: string; name: string } & ModelMetadata> {
  const account = getCopilotAccount();
  if (!account?.accessToken) return [];

  // Prefer the live /models cache (refreshed on login + silent renew).
  // Fall back to pi-mono's static catalog only when we have no cache yet
  // — that keeps the picker non-empty on first paint after login when
  // refreshCopilotCatalogAndPolicies is still in flight.
  const cache = loadCachedCopilotCatalog();
  if (cache.length > 0) {
    return cache
      .filter((m) => !m.policyState.startsWith('unavailable:'))
      .filter((m) => isCopilotConeCompatible(m))
      .map((m) => ({
        id: m.id,
        name: m.name,
        api: m.api === 'anthropic-messages' ? ('anthropic' as const) : ('openai' as const),
        context_window: m.contextWindow,
        max_tokens: m.maxTokens,
        reasoning: m.supportsReasoning,
        input: m.supportsVision ? (['text', 'image'] as const) : (['text'] as const),
      }));
  }
  let piModels: ReturnType<typeof getModels<'github-copilot'>>;
  try {
    piModels = getModels('github-copilot');
  } catch {
    return [];
  }
  return piModels
    .filter((m) => isCopilotConeCompatible({ id: m.id, name: m.name }))
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      api: m.api === 'anthropic-messages' ? ('anthropic' as const) : ('openai' as const),
      context_window: m.contextWindow,
      max_tokens: m.maxTokens,
      reasoning: m.reasoning,
      input: m.input,
    }));
}

// ── Stream wrappers ────────────────────────────────────────────────

function makeErrorOutput(model: Model<Api>, error: unknown) {
  return {
    type: 'error' as const,
    reason: 'error' as const,
    error: {
      role: 'assistant' as const,
      content: [],
      api: model.api,
      provider: PROVIDER_ID,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error' as const,
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

/** Pi-mono-style headers VS Code Copilot Chat sends on every API call. */
const COPILOT_API_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;

interface ResolvedCopilotModel {
  api: CopilotCatalogEntry['api'];
  baseUrl: string;
  headers: Record<string, string>;
}

/**
 * Find the right downstream API + baseUrl + headers for a Copilot model.
 *
 * Look-up order:
 *   1) The live `/models` cache (authoritative — reflects what GitHub
 *      actually serves right now, including models pi-mono doesn't know
 *      about yet such as claude-opus-4.8).
 *   2) Pi-mono's static catalog (legacy fallback for the brief window
 *      before the first /models fetch completes after login).
 *
 * Returns null if neither source knows the model — caller will surface
 * an error to the user explaining the picker is out of date.
 */
function resolveCopilotModel(modelId: string): ResolvedCopilotModel | null {
  const account = getCopilotAccount();
  const baseUrl = account?.baseUrl ?? 'https://api.individual.githubcopilot.com';

  const cached = findCachedCopilotModel(modelId);
  if (cached) {
    return { api: cached.api, baseUrl, headers: { ...COPILOT_API_HEADERS } };
  }
  try {
    const pi = getModel('github-copilot' as never, modelId as never) as unknown as Model<Api>;
    return {
      api: pi.api as CopilotCatalogEntry['api'],
      baseUrl: account?.baseUrl ?? pi.baseUrl,
      headers: { ...(pi.headers ?? {}), ...COPILOT_API_HEADERS },
    };
  } catch {
    return null;
  }
}

/**
 * Mark a model as unavailable on this account so the picker can hide it on
 * the next render. Keyed by model id; the next catalog refresh wipes the
 * flag, so users get a chance to retry after upgrading their plan.
 */
function markCopilotModelUnavailable(modelId: string, reason: string): void {
  const cache = loadCachedCopilotCatalog();
  const idx = cache.findIndex((m) => m.id === modelId);
  if (idx < 0) return;
  cache[idx] = { ...cache[idx], policyState: `unavailable:${reason}` };
  storeCachedCopilotCatalog(cache);
}

/**
 * Translate GitHub's terse `model_not_supported` error into something
 * actionable. The same error code covers two very different cases:
 *   1) The user's Copilot plan tier does not include the model (Free tier
 *      can't use Opus, etc.) — even after a successful policy POST.
 *   2) The model id is genuinely unknown to the backend.
 *
 * We can't tell which from the response alone, but mentioning the plan
 * possibility gives the user a useful next step.
 */
function explainModelRejection(modelId: string, raw: string): string {
  return (
    `GitHub Copilot rejected "${modelId}" with model_not_supported. ` +
    `This usually means the model isn't included in your Copilot plan ` +
    `(Opus and other premium models require Copilot Pro / Pro+ / Business / Enterprise). ` +
    `Try Claude Sonnet 4.6 or another model that appears in the picker after a fresh login. ` +
    `Original error: ${raw}`
  );
}

/**
 * Read the human-readable message off a streaming `error` event. Pi-mono
 * (and our own makeErrorOutput) put it on `event.error.errorMessage`, but
 * some adapter paths surface it directly on `event.errorMessage` instead —
 * try both so we don't miss a 400 just because the shape varies.
 */
function extractStreamErrorMessage(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as { type?: unknown; error?: unknown; errorMessage?: unknown };
  if (e.type !== 'error') return null;
  if (e.error && typeof e.error === 'object') {
    const inner = (e.error as { errorMessage?: unknown }).errorMessage;
    if (typeof inner === 'string') return inner;
  }
  return typeof e.errorMessage === 'string' ? e.errorMessage : null;
}

type CopilotEventStream = ReturnType<typeof createAssistantMessageEventStream>;

/** Pick the pi-ai stream function for a resolved Copilot API + simple flag. */
function pickCopilotStreamFn(
  api: string,
  simple: boolean
): (model: never, context: never, options: never) => AsyncIterable<unknown> {
  if (api === 'anthropic-messages') {
    return (simple ? streamSimpleAnthropic : streamAnthropic) as never;
  }
  if (api === 'openai-responses') {
    return (simple ? streamSimpleOpenAIResponses : streamOpenAIResponses) as never;
  }
  return (simple ? streamSimpleOpenAICompletions : streamOpenAICompletions) as never;
}

/**
 * Forward a single upstream event, rewriting the misleading
 * `model_not_supported` 400 into a plan-aware explanation and marking the
 * model unavailable so the picker hides it next render. Returns `true` when
 * the stream was terminated and the caller should stop pumping.
 */
function handleCopilotStreamEvent(
  stream: CopilotEventStream,
  model: Model<Api>,
  event: unknown
): boolean {
  // Pi-mono surfaces HTTP errors as in-stream `error` events rather than
  // thrown exceptions, so the outer catch never sees them.
  const errMsg = extractStreamErrorMessage(event);
  if (errMsg && /model_not_supported/i.test(errMsg)) {
    markCopilotModelUnavailable(model.id, 'model_not_supported');
    const friendly = explainModelRejection(model.id, errMsg);
    console.error('[github-copilot] Plan-gated model rejection:', friendly);
    stream.push(makeErrorOutput(model, new Error(friendly)) as never);
    stream.end();
    return true;
  }
  stream.push(event as never);
  return false;
}

/** Surface a thrown stream error, applying the same model_not_supported rewrite. */
function emitCopilotStreamError(
  stream: CopilotEventStream,
  model: Model<Api>,
  error: unknown
): void {
  const raw = error instanceof Error ? error.message : String(error);
  let surfaced: unknown = error;
  // Belt-and-suspenders: the same rewrite for thrown errors, in case a future
  // pi-mono adapter throws instead of emitting an error event.
  if (/model_not_supported/i.test(raw)) {
    markCopilotModelUnavailable(model.id, 'model_not_supported');
    surfaced = new Error(explainModelRejection(model.id, raw));
  }
  console.error(
    '[github-copilot] Stream error:',
    surfaced instanceof Error ? surfaced.message : String(surfaced)
  );
  stream.push(makeErrorOutput(model, surfaced) as never);
  stream.end();
}

async function pumpCopilotStream(
  stream: CopilotEventStream,
  model: Model<Api>,
  context: Context,
  options: Record<string, unknown>,
  simple: boolean
): Promise<void> {
  try {
    const apiKey = await getValidCopilotToken();
    const resolved = resolveCopilotModel(model.id);
    if (!resolved) {
      throw new Error(
        `GitHub Copilot does not recognize "${model.id}" — open the picker (the model list refreshes on login) and pick a current model.`
      );
    }
    const inner: Model<Api> = {
      ...model,
      api: resolved.api as Api,
      baseUrl: resolved.baseUrl,
      headers: resolved.headers,
      provider: 'github-copilot',
    } as Model<Api>;

    const opts = { ...options, apiKey };
    const fn = pickCopilotStreamFn(resolved.api, simple);
    const upstream = fn(inner as never, context as never, opts as never);
    for await (const event of upstream) {
      if (handleCopilotStreamEvent(stream, model, event)) return;
    }
    stream.end();
  } catch (error) {
    emitCopilotStreamError(stream, model, error);
  }
}

function createCopilotStreamWrapper(simple: boolean) {
  return (model: Model<Api>, context: Context, options: Record<string, unknown> = {}) => {
    const stream = createAssistantMessageEventStream();
    void pumpCopilotStream(stream, model, context, options, simple);
    return stream;
  };
}

const streamCopilot = createCopilotStreamWrapper(false);
const streamSimpleCopilot = createCopilotStreamWrapper(true);

// ── Default device-code prompter ───────────────────────────────────

/**
 * Fallback {@link DeviceCodePrompter} used when the caller (settings dialog,
 * welcome sprinkle, …) does not provide its own UI surface.
 *
 * Renders a small floating overlay with the user code + copy / continue /
 * cancel buttons, auto-copies the code to the clipboard, and resolves only
 * after the user explicitly continues or cancels — so the auth tab is never
 * opened behind the user's back.
 *
 * In contexts without a `document` (e.g. the kernel worker running
 * `oauth-token github-copilot`), this logs the code to the dev console and
 * resolves immediately with `'continue'` — that path has no UI to render to,
 * and the existing CLI surface already prints stdout the user can read.
 */
const defaultDeviceCodePrompter: DeviceCodePrompter = ({ userCode, verificationUrl }) => {
  if (typeof document === 'undefined') {
    console.info(
      `[github-copilot] Device verification code: ${userCode} — open ${verificationUrl} in a browser to authorize.`
    );
    return Promise.resolve('continue');
  }

  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-slicc-overlay', 'github-copilot-device');
    wrap.style.cssText = [
      'position:fixed',
      'top:24px',
      'right:24px',
      'z-index:2147483647',
      'background:#0d1117',
      'color:#e6edf3',
      'border:1px solid #30363d',
      'border-radius:10px',
      'padding:16px 18px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.45)',
      'font:13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      'min-width:260px',
      'max-width:340px',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'GitHub Copilot — verification code';
    title.style.cssText = 'font-weight:600;margin-bottom:8px;color:#7ee787';

    const codeBox = document.createElement('div');
    codeBox.textContent = userCode;
    codeBox.style.cssText = [
      'font:600 22px ui-monospace, SFMono-Regular, Menlo, monospace',
      'letter-spacing:2px',
      'background:#161b22',
      'border:1px solid #30363d',
      'border-radius:6px',
      'padding:10px 12px',
      'text-align:center',
      'margin-bottom:10px',
      'user-select:all',
      'cursor:text',
    ].join(';');

    const hint = document.createElement('div');
    hint.style.cssText = 'color:#8b949e;font-size:12px;line-height:1.5';
    hint.textContent =
      'Copy the code, then click Continue to open the GitHub authorization page in a new tab.';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:12px;justify-content:flex-end';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = [
      'background:transparent',
      'color:#e6edf3',
      'border:1px solid #30363d',
      'border-radius:6px',
      'padding:6px 12px',
      'font:600 12px inherit',
      'cursor:pointer',
    ].join(';');

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.textContent = 'Copy & Continue';
    continueBtn.style.cssText = [
      'background:#238636',
      'color:#fff',
      'border:0',
      'border-radius:6px',
      'padding:6px 12px',
      'font:600 12px inherit',
      'cursor:pointer',
    ].join(';');

    const cleanup = () => {
      try {
        wrap.remove();
      } catch {
        /* already removed */
      }
    };

    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve('cancel');
    });
    continueBtn.addEventListener('click', () => {
      void (async () => {
        try {
          const { copyTextToClipboard } = await import('../src/ui/clipboard.js');
          await copyTextToClipboard(userCode);
        } catch {
          /* user can still copy manually */
        }
        cleanup();
        resolve('continue');
      })();
    });

    row.appendChild(cancelBtn);
    row.appendChild(continueBtn);

    wrap.appendChild(title);
    wrap.appendChild(codeBox);
    wrap.appendChild(hint);
    wrap.appendChild(row);
    document.body.appendChild(wrap);
  });
};

// ── Provider config ────────────────────────────────────────────────

export const config: ProviderConfig = {
  id: PROVIDER_ID,
  name: 'GitHub Copilot',
  description:
    'Use your GitHub Copilot subscription to access Claude, GPT-5, Codex, Gemini, and Grok models. Sign in with the GitHub device-code flow.',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,
  defaultModelId: 'claude-sonnet-4.6',
  oauthTokenDomains: [
    '*.githubcopilot.com',
    'api.individual.githubcopilot.com',
    'api.business.githubcopilot.com',
    'api.enterprise.githubcopilot.com',
  ],

  getModelIds: buildCopilotModelList,

  onOAuthLoginIntercepted: async (
    launcher: InterceptingOAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => {
    // Step 1: ask GitHub for a fresh device code.
    const device = await startDeviceFlow();

    const verificationUrl = new URL(device.verification_uri);
    verificationUrl.searchParams.set('user_code', device.user_code);

    // Step 2: show the user the verification code via whatever UI surface
    // the caller provided (settings dialog, sprinkle, …), or our default
    // overlay. We do NOT open the auth tab until the user explicitly
    // continues — they need to see and copy the code first so they can
    // confirm it matches what GitHub shows on the authorize screen.
    const prompter = options?.presentDeviceCode ?? defaultDeviceCodePrompter;
    const decision = await prompter({
      userCode: device.user_code,
      verificationUrl: verificationUrl.toString(),
      expiresInSeconds: device.expires_in,
    });
    if (decision === 'cancel') {
      throw new Error('GitHub Copilot login cancelled');
    }

    // Step 3 + 4 run in parallel, AFTER the user confirmed:
    //   - the controlled-browser tab opens to the pre-filled verification URL
    //     and self-closes when the post-authorize success page loads;
    //   - we poll the access-token endpoint until GitHub issues a token.
    //
    // The launcher's promise is allowed to settle independently (success page
    // capture OR timeout); the polling promise is the source of truth for
    // whether we actually got a token.
    const pollAbort = new AbortController();
    const tabPromise = launcher({
      authorizeUrl: verificationUrl.toString(),
      redirectUriPattern: DEVICE_SUCCESS_PATTERN,
      onCapture: 'close',
      timeoutMs: device.expires_in * 1000,
    }).catch((err) => {
      console.warn(
        '[github-copilot] Launcher failed:',
        err instanceof Error ? err.message : String(err)
      );
      return null;
    });

    let githubAccessToken: string;
    try {
      githubAccessToken = await pollForGitHubAccessToken(device, pollAbort.signal);
    } catch (err) {
      pollAbort.abort();
      await tabPromise;
      throw err;
    }
    // Let the launcher resolve/cleanup naturally so the tab gets closed.
    await tabPromise;

    // Step 5: trade the GitHub token for a short-lived Copilot session token.
    const copilot = await exchangeForCopilotToken(githubAccessToken);
    // Try to fetch a display name so the picker shows "logged in as <name>".
    let userName: string | undefined;
    try {
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${githubAccessToken}`, Accept: 'application/json' },
      });
      if (userRes.ok) {
        const u = (await userRes.json()) as { name?: string; login?: string };
        userName = u.name || u.login;
      }
    } catch {
      /* best-effort */
    }
    await persistCopilot(copilot, userName);
    // Discover the live model catalog and accept per-model usage policies
    // GitHub gates premium models on (Claude, GPT-5, Codex, Gemini, Grok).
    // The result is cached for buildCopilotModelList + resolveCopilotModel.
    // Best-effort — never block login on it.
    await refreshCopilotCatalogAndPolicies(copilot);
    onSuccess();
  },

  onOAuthLogout: async () => {
    await saveOAuthAccount({ providerId: PROVIDER_ID, accessToken: '' });
  },

  onSilentRenew: async () => {
    const account = getCopilotAccount();
    if (!account?.refreshToken) return null;
    try {
      const refreshed = await exchangeForCopilotToken(account.refreshToken);
      await persistCopilot(refreshed, account.userName);
      // Refresh catalog + re-accept policies on every silent renew so the
      // picker reflects newly-released models (e.g. claude-opus-4.8) without
      // forcing the user to log out and back in.
      await refreshCopilotCatalogAndPolicies(refreshed);
      return refreshed.copilotToken;
    } catch (err) {
      console.warn(
        '[github-copilot] Silent renew failed:',
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  },
};

// ── Registration ───────────────────────────────────────────────────

export function register(): void {
  // Slicc's getModelIds branch in provider-settings.ts maps each model's
  // metadata `api` field to a synthetic api name `${providerId}-${api}`,
  // so we register stream functions under those exact names. Both delegate
  // to the same dispatcher — it picks anthropic / responses / completions
  // based on the underlying pi-mono model's real api.
  registerApiProvider({
    api: 'github-copilot-anthropic' as Api,
    stream: streamCopilot as never,
    streamSimple: streamSimpleCopilot as never,
  });
  registerApiProvider({
    api: 'github-copilot-openai' as Api,
    stream: streamCopilot as never,
    streamSimple: streamSimpleCopilot as never,
  });
}
