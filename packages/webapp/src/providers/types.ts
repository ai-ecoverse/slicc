/**
 * Shared provider configuration type used by both built-in and external providers.
 */

import type {
  AnthropicMessagesCompat,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
} from '@earendil-works/pi-ai';

/**
 * Opens a browser window/flow for the given authorize URL and returns the
 * redirect URL (with token/code in fragment or query) once the flow completes.
 * Returns null if the user cancelled or the flow timed out.
 */
export type OAuthLauncher = (authorizeUrl: string) => Promise<string | null>;

/**
 * Outbound-request rewrite applied during an intercepted OAuth flow.
 *
 * Lets the provider patch authorize URLs (e.g. add xAI's `plan=generic`) or
 * substitute test fixtures, without touching the launcher itself.
 */
export interface OAuthRequestRewrite {
  /** Substring matched against the outbound request URL (case-sensitive). */
  match: string;
  /** Search params to add or override on matching requests. */
  appendParams?: Record<string, string>;
  /** Replace the URL entirely (preserving method + headers). */
  replaceUrl?: string;
}

/**
 * Configuration for one run of the intercepted OAuth flow. The launcher
 * navigates a controlled-browser tab to `authorizeUrl`, intercepts the first
 * outbound request that matches `redirectUriPattern`, and resolves with the
 * full captured URL (which carries the code + state in the query string).
 * No HTTP server is ever bound to the redirect port.
 */
export interface InterceptOAuthConfig {
  /** Authorize URL — the launcher navigates the OAuth tab here. */
  authorizeUrl: string;
  /**
   * Pattern matching the loopback (or other) redirect URI we want to capture.
   * Supports a trailing `*` glob; e.g. `http://127.0.0.1:56121/*`.
   * The launcher resolves with the *full* URL of the first matching request.
   */
  redirectUriPattern: string;
  /**
   * Optional outbound-request rewrites, applied to any URL the OAuth tab
   * navigates to (authorize, intermediate hops, redirect). Useful for vendor
   * quirks like xAI's `plan=generic` requirement.
   */
  rewrite?: OAuthRequestRewrite[];
  /**
   * What to do with the OAuth tab after capture. Default: `"close"`.
   * - `"close"` — close the tab via `Target.closeTarget`.
   * - `"leave"` — leave the tab open (useful for debugging).
   */
  onCapture?: 'close' | 'leave';
  /** Override the default timeout. Default: 120_000 ms. */
  timeoutMs?: number;
}

/**
 * Launcher that drives the OAuth flow inside the controlled browser and
 * intercepts the redirect via CDP `Fetch.requestPaused` instead of running a
 * local callback server. See {@link InterceptOAuthConfig}.
 *
 * Returns the captured redirect URL on success, or null on timeout/cancel.
 */
export type InterceptingOAuthLauncher = (config: InterceptOAuthConfig) => Promise<string | null>;

/** Options passed to onOAuthLogin from the caller (e.g. oauth-token command). */
export interface OAuthLoginOptions {
  /**
   * Override the default scopes for this login. Passed directly to the
   * provider's authorize URL as the `scope` parameter. Format is
   * provider-specific (GitHub uses comma-separated, Google uses
   * space-separated). The provider is responsible for any normalization.
   */
  scopes?: string;
}

/**
 * Optional model capability overrides.
 * Used by both modelOverrides (static) and getModelIds (dynamic).
 *
 * Fields use snake_case to match JSON responses from proxies.
 * Merged into Model<Api> objects (camelCase) via applyModelMetadata()
 * in provider-settings.ts. Priority: pi-ai registry < modelOverrides < getModelIds.
 */
/**
 * Per-model compatibility overrides — the union of pi-ai's actual compat
 * interfaces, so callers get autocomplete on the keys that any of pi-ai's
 * stream functions actually consume. Imported as a union (not a conditional
 * type keyed on the API) because SLICC's custom API names (`adobe-anthropic`,
 * `bedrock-camp-converse`, etc.) aren't in pi-ai's `KnownApi` union, so the
 * conditional would resolve to `never`. Providers may set fields belonging
 * to any single API's compat shape — pi-ai reads by property name and
 * silently ignores fields it doesn't recognize for the active API.
 *
 * Notable knobs:
 * - `supportsEagerToolInputStreaming` (Anthropic): pi-ai 0.70+ adds
 *   `tools[].eager_input_streaming: true` by default. Set false to fall back
 *   to the `fine-grained-tool-streaming-2025-05-14` beta header — required
 *   for Adobe's Bedrock-Haiku path (Bedrock 400s on the field).
 * - `supportsLongCacheRetention` (Anthropic, OpenAIResponses): controls
 *   `cache_control.ttl: "1h"` / `prompt_cache_retention: "24h"`.
 * - OpenAI-completions has a much larger surface (`supportsStore`,
 *   `supportsDeveloperRole`, `maxTokensField`, `cacheControlFormat`, …)
 *   inherited from pi-ai's `OpenAICompletionsCompat`.
 */
export type CompatOverrides =
  | AnthropicMessagesCompat
  | OpenAICompletionsCompat
  | OpenAIResponsesCompat;

export interface ModelMetadata {
  /** API format: 'anthropic' (default) or 'openai' for OpenAI-compatible backends. */
  api?: 'anthropic' | 'openai';
  /** Context window size in tokens. */
  context_window?: number;
  /** Maximum output tokens. */
  max_tokens?: number;
  /** Whether the model supports thinking/reasoning. */
  reasoning?: boolean;
  /** Supported input modalities (e.g., ['text', 'image']). */
  input?: string[];
  /**
   * Per-model API compatibility overrides; matches pi-ai's `Model.compat`
   * field. Used to opt models out of provider features the upstream backend
   * rejects — e.g. Adobe sets `{ supportsEagerToolInputStreaming: false }`
   * on Haiku entries because Bedrock's Haiku endpoints 400 on that field.
   * See {@link CompatOverrides} for the full list of supported keys per API.
   */
  compat?: CompatOverrides;
}

export interface ProviderConfig {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  /**
   * When true, the dialog still shows the API key field but does not require
   * a value. `getApiKeyForProvider` returns the literal `'local'` instead of
   * `null` when the user leaves it blank, so callers that gate on a non-null
   * key (scoop init, pi-ai's stream) stay happy.
   *
   * Set this for providers that talk to local servers where the key is
   * usually ignored but might be needed for hosted OpenAI-compatible
   * endpoints (Together, Anyscale, Fireworks).
   */
  optionalApiKey?: boolean;
  apiKeyPlaceholder?: string;
  apiKeyEnvVar?: string;
  requiresBaseUrl: boolean;
  baseUrlPlaceholder?: string;
  baseUrlDescription?: string;
  /** OAuth providers show a login button instead of an API key input. */
  isOAuth?: boolean;
  /**
   * Called when the user clicks the login button for this OAuth provider.
   * Receives a launcher that opens the OAuth flow and returns the redirect URL.
   * The provider builds the authorize URL, calls the launcher, then handles the result.
   */
  onOAuthLogin?: (
    launcher: OAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => Promise<void>;
  /**
   * Alternative login hook that uses the controlled-browser interceptor
   * instead of a popup / chrome.identity flow. Providers implement EITHER
   * `onOAuthLogin` OR this — the `oauth-token` command dispatches based on
   * which is present.
   *
   * The intercepting launcher captures the redirect URL by watching the
   * controlled tab's outbound network traffic via CDP, with no local HTTP
   * server. Suited to providers whose OAuth client only accepts loopback
   * redirect URIs (e.g. xAI Grok, Google Cloud Code Assist).
   */
  onOAuthLoginIntercepted?: (
    launcher: InterceptingOAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => Promise<void>;
  /** Called when the user clicks logout for this OAuth provider. */
  onOAuthLogout?: () => Promise<void>;
  /**
   * Optional: refresh an expired/expiring token silently from page context.
   * Called by oauth-bootstrap at page load so the kernel-worker can stream
   * with a fresh token without needing window access. Returns the new token
   * (also persists it via saveOAuthAccount) or null if renewal is impossible
   * (e.g. user must re-authenticate).
   */
  onSilentRenew?: () => Promise<string | null>;
  /**
   * Domains this OAuth token should be unmasked for in fetch-proxy traffic.
   * Supports wildcards (e.g. '*.github.com').
   */
  oauthTokenDomains?: string[];
  /**
   * Optional: override model capabilities for specific model IDs.
   * Applied after pi-ai registry defaults, before getModelIds metadata.
   */
  modelOverrides?: Record<string, ModelMetadata>;
  /**
   * Optional: preferred default model ID when no model has been explicitly selected.
   * Searched by substring match (case-insensitive) against available model IDs.
   * Falls back to the first model in the list if no match is found.
   */
  defaultModelId?: string;
  /** When true, the setup dialog shows a deployment name text input. */
  requiresDeployment?: boolean;
  deploymentPlaceholder?: string;
  deploymentDescription?: string;
  /** When true, the setup dialog shows an API version text input with a default value. */
  requiresApiVersion?: boolean;
  apiVersionDefault?: string;
  apiVersionDescription?: string;
  /**
   * Optional: return the model IDs this provider supports.
   * When present, getProviderModels uses this instead of returning all Anthropic models.
   * Models are resolved against the Anthropic registry by ID; unknown IDs create fallback models.
   *
   * Must be synchronous, side-effect-free, and return a stable list for the session.
   * If dynamic model fetching is needed, pre-fetch during onOAuthLogin and cache the result.
   */
  getModelIds?: () => Array<{ id: string; name?: string } & ModelMetadata>;
}
