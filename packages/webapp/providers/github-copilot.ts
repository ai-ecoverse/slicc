import type {
  Api,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  createAssistantMessageEventStream,
  registerApiProvider,
  streamAnthropic,
  streamOpenAICompletions,
  streamOpenAIResponses,
  streamSimpleAnthropic,
  streamSimpleOpenAICompletions,
  streamSimpleOpenAIResponses,
} from '@earendil-works/pi-ai/compat';
import { getModel, getModels } from '../src/core/model-catalog.js';
import { fetchCopilotUsage } from '../src/providers/github-copilot-usage.js';
import type { ProviderBudgetWindow } from '../src/providers/provider-budget.js';
import type {
  DeviceCodePrompter,
  InterceptingOAuthLauncher,
  ModelMetadata,
  OAuthLoginOptions,
  ProviderConfig,
} from '../src/providers/types.js';
import { getAccounts, saveOAuthAccount } from '../src/ui/provider-settings.js';

const PROVIDER_ID = 'github-copilot';

const VSCODE_COPILOT_CLIENT_ID = atob('SXYxLmI1MDdhMDhjODdlY2ZlOTg=');

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

const COPILOT_EXCHANGE_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};

const DEVICE_FLOW_POST_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
};

const DEVICE_SUCCESS_PATTERN = 'https://github.com/login/device/success*';

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

function getCopilotAccount() {
  return getAccounts().find((a) => a.providerId === PROVIDER_ID);
}

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

async function pollForGitHubAccessToken(
  device: DeviceCodeResponse,
  signal: AbortSignal
): Promise<string> {
  const deadline = Date.now() + device.expires_in * 1000;

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

    expiresAtMs: data.expires_at * 1000 - 5 * 60 * 1000,
    apiBaseUrl: extractCopilotApiBase(data.token) ?? 'https://api.individual.githubcopilot.com',
    githubAccessToken,
  };
}

interface CopilotCatalogEntry {
  id: string;
  name: string;
  vendor: string;

  api: 'anthropic-messages' | 'openai-completions' | 'openai-responses';
  contextWindow: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;

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
  } catch {}
}

function findCachedCopilotModel(modelId: string): CopilotCatalogEntry | null {
  const cache = loadCachedCopilotCatalog();
  return cache.find((m) => m.id === modelId) ?? null;
}

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

function markCopilotModelUnavailable(modelId: string, reason: string): void {
  const cache = loadCachedCopilotCatalog();
  const idx = cache.findIndex((m) => m.id === modelId);
  if (idx < 0) return;
  cache[idx] = { ...cache[idx], policyState: `unavailable:${reason}` };
  storeCachedCopilotCatalog(cache);
}

function explainModelRejection(modelId: string, raw: string): string {
  return (
    `GitHub Copilot rejected "${modelId}" with model_not_supported. ` +
    `This usually means the model isn't included in your Copilot plan ` +
    `(Opus and other premium models require Copilot Pro / Pro+ / Business / Enterprise). ` +
    `Try Claude Sonnet 4.6 or another model that appears in the picker after a fresh login. ` +
    `Original error: ${raw}`
  );
}

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

function handleCopilotStreamEvent(
  stream: CopilotEventStream,
  model: Model<Api>,
  event: unknown
): boolean {
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

function emitCopilotStreamError(
  stream: CopilotEventStream,
  model: Model<Api>,
  error: unknown
): void {
  const raw = error instanceof Error ? error.message : String(error);
  let surfaced: unknown = error;

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
  options: ProviderStreamOptions | SimpleStreamOptions,
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

function createCopilotStreamWrapper(
  simple: false
): (model: Model<Api>, context: Context, options?: ProviderStreamOptions) => CopilotEventStream;
function createCopilotStreamWrapper(
  simple: true
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => CopilotEventStream;
function createCopilotStreamWrapper(simple: boolean) {
  return (
    model: Model<Api>,
    context: Context,
    options: ProviderStreamOptions | SimpleStreamOptions = {}
  ) => {
    const stream = createAssistantMessageEventStream();
    void pumpCopilotStream(stream, model, context, options, simple);
    return stream;
  };
}

const streamCopilot = createCopilotStreamWrapper(false);
const streamSimpleCopilot = createCopilotStreamWrapper(true);

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
      } catch {}
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
        } catch {}
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

async function getBudgetUsage(): Promise<ProviderBudgetWindow | null> {
  const account = getCopilotAccount();
  if (!account?.refreshToken) return null;
  return fetchCopilotUsage(account.refreshToken, fetch, { headers: COPILOT_EXCHANGE_HEADERS });
}

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
  getBudgetUsage,

  onOAuthLoginIntercepted: async (
    launcher: InterceptingOAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => {
    const device = await startDeviceFlow();

    const verificationUrl = new URL(device.verification_uri);
    verificationUrl.searchParams.set('user_code', device.user_code);

    const prompter = options?.presentDeviceCode ?? defaultDeviceCodePrompter;
    const decision = await prompter({
      userCode: device.user_code,
      verificationUrl: verificationUrl.toString(),
      expiresInSeconds: device.expires_in,
    });
    if (decision === 'cancel') {
      throw new Error('GitHub Copilot login cancelled');
    }

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

    await tabPromise;

    const copilot = await exchangeForCopilotToken(githubAccessToken);

    let userName: string | undefined;
    try {
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${githubAccessToken}`, Accept: 'application/json' },
      });
      if (userRes.ok) {
        const u = (await userRes.json()) as { name?: string; login?: string };
        userName = u.name || u.login;
      }
    } catch {}
    await persistCopilot(copilot, userName);

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

export function register(): void {
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
