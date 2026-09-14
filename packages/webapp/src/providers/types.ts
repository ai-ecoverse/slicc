import type {
  AnthropicMessagesCompat,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
} from '@earendil-works/pi-ai';
import type { ProviderBudgetWindow } from './provider-budget.js';

export type OAuthLauncher = (
  authorizeUrl: string,
  opts?: { interactive?: boolean }
) => Promise<string | null>;

export interface OAuthRequestRewrite {
  match: string;

  appendParams?: Record<string, string>;

  replaceUrl?: string;
}

export interface InterceptOAuthConfig {
  authorizeUrl: string;

  redirectUriPattern: string;

  rewrite?: OAuthRequestRewrite[];

  onCapture?: 'close' | 'leave';

  timeoutMs?: number;
}

export type InterceptingOAuthLauncher = (config: InterceptOAuthConfig) => Promise<string | null>;

export interface DeviceCodePromptInput {
  userCode: string;

  verificationUrl: string;

  expiresInSeconds: number;
}

export type DeviceCodePrompter = (input: DeviceCodePromptInput) => Promise<'continue' | 'cancel'>;

export interface OAuthTokenValidation {
  status: 'accepted' | 'rejected' | 'unknown';

  userName?: string;

  detail?: string;
}

export interface OAuthLoginOptions {
  scopes?: string;

  forceReauth?: boolean;

  presentDeviceCode?: DeviceCodePrompter;
}

export type CompatOverrides =
  | AnthropicMessagesCompat
  | OpenAICompletionsCompat
  | OpenAIResponsesCompat;

export interface ModelMetadata {
  api?: 'anthropic' | 'openai';

  context_window?: number;

  max_tokens?: number;

  reasoning?: boolean;

  input?: string[];

  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };

  compat?: CompatOverrides;

  thinkingLevelMap?: Record<string, string | null>;
}

export interface ProviderConfig {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;

  optionalApiKey?: boolean;
  apiKeyPlaceholder?: string;
  apiKeyEnvVar?: string;
  requiresBaseUrl: boolean;
  baseUrlPlaceholder?: string;
  baseUrlDescription?: string;

  hidden?: boolean;

  isOAuth?: boolean;

  onOAuthLogin?: (
    launcher: OAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => Promise<void>;

  onOAuthLoginIntercepted?: (
    launcher: InterceptingOAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => Promise<void>;

  onOAuthLogout?: () => Promise<void>;

  getOAuthLogoutUrl?: (account: { accessToken?: string; providerId: string }) => string | undefined;

  onSilentRenew?: () => Promise<string | null>;

  onValidateToken?: () => Promise<OAuthTokenValidation>;

  getValidAccessToken?: () => Promise<string>;

  getBudgetUsage?: () => Promise<ProviderBudgetWindow | null>;

  refreshModels?: (accessToken?: string) => Promise<void>;

  oauthTokenDomains?: string[];

  modelOverrides?: Record<string, ModelMetadata>;

  defaultModelId?: string;

  requiresDeployment?: boolean;
  deploymentPlaceholder?: string;
  deploymentDescription?: string;

  requiresApiVersion?: boolean;
  apiVersionDefault?: string;
  apiVersionDescription?: string;

  getModelIds?: () => Array<{ id: string; name?: string } & ModelMetadata>;
}
