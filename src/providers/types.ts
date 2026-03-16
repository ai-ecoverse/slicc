/**
 * Shared provider configuration type used by both built-in and external providers.
 */

/**
 * Opens a browser window/flow for the given authorize URL and returns the
 * redirect URL (with token/code in fragment or query) once the flow completes.
 * Returns null if the user cancelled or the flow timed out.
 */
export type OAuthLauncher = (authorizeUrl: string) => Promise<string | null>;

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
  onOAuthLogin?: (launcher: OAuthLauncher, onSuccess: () => void) => Promise<void>;
  /** Called when the user clicks logout for this OAuth provider. */
  onOAuthLogout?: () => Promise<void>;
  /**
   * Optional: return the model IDs this provider supports.
   * When present, getProviderModels uses this instead of returning all Anthropic models.
   * Models are resolved against the Anthropic registry by ID.
   */
  getModelIds?: () => Array<{ id: string; name?: string }>;
}
