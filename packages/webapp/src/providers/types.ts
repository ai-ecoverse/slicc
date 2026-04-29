/**
 * Shared provider configuration type used by both built-in and external providers.
 */

/**
 * Opens a browser window/flow for the given authorize URL and returns the
 * redirect URL (with token/code in fragment or query) once the flow completes.
 * Returns null if the user cancelled or the flow timed out.
 */
export type OAuthLauncher = (authorizeUrl: string) => Promise<string | null>;

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
   * Per-model compatibility overrides for the underlying API (matches pi-ai's
   * `Model.compat` field; camelCase to align with pi-ai). Used to opt models
   * out of provider features that the upstream backend rejects — e.g. Adobe's
   * Bedrock relay returns 400 for `tools[].eager_input_streaming` on Haiku, so
   * Adobe sets `compat: { supportsEagerToolInputStreaming: false }` for Haiku
   * model entries. Shape is loosely typed because pi-ai's compat varies by
   * API (AnthropicMessagesCompat, OpenAICompletionsCompat, …).
   */
  compat?: Record<string, unknown>;
}

export interface ProviderConfig {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
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
  /** Called when the user clicks logout for this OAuth provider. */
  onOAuthLogout?: () => Promise<void>;
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
