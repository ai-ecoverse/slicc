import { slugify } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import { type ValidationResult, validateApiKey } from './api-key-validator.js';
import type { OnboardingProfile, RandomFn } from './onboarding-messages.js';
import { buildIntroMessages } from './onboarding-messages.js';
import { recordWelcomed } from './welcome-detection.js';

const log = createLogger('onboarding-orchestrator');

export interface ProviderEntry {
  id: string;
  name: string;
  description?: string;
  requiresApiKey: boolean;
  requiresBaseUrl: boolean;

  requiresDeployment?: boolean;

  requiresApiVersion?: boolean;

  apiKeyPlaceholder?: string;

  apiKeyEnvVar?: string;

  defaultBaseUrl?: string;

  baseUrlDescription?: string;

  deploymentPlaceholder?: string;

  deploymentDescription?: string;

  apiVersionDefault?: string;

  apiVersionDescription?: string;

  isOAuth?: boolean;
}

export interface ProviderModel {
  id: string;
  name?: string;
}

export interface ProviderCatalogue {
  providers: ProviderEntry[];
  models: Record<string, ProviderModel[]>;
}

export interface ConnectAttemptPayload {
  provider: string;
  apiKey: string;
  baseUrl?: string | null;

  deployment?: string | null;

  apiVersion?: string | null;
  model?: string | null;
}

export interface OAuthAttemptPayload {
  provider: string;
  baseUrl?: string | null;
}

export interface OAuthLaunchResult {
  ok: boolean;

  model?: string | null;
  message?: string;
}

export interface OnboardingCompleteWithProviderData {
  profile: OnboardingProfile;
  provider: string;
  model: string | null;
  modelLabel: string | null;
  validation: string;
}

export interface OnboardingCompleteWithProviderLick {
  action: 'onboarding-complete-with-provider';
  data: OnboardingCompleteWithProviderData;
}

export interface OrchestratorDeps {
  fs: VirtualFS;

  postSystemMessage: (line: string) => void;

  postDipReference: (markdown: string) => void;

  getProviderCatalogue: () => ProviderCatalogue;

  saveAccount: (
    providerId: string,
    apiKey: string,
    baseUrl?: string,
    deployment?: string,
    apiVersion?: string
  ) => void;

  setSelectedModel: (modelId: string) => void;

  resolveModelLabel?: (providerId: string, modelId: string) => string | null;

  broadcastToDip: (payload: { type: string; [k: string]: unknown }) => void;

  fireFinalLick: (data: OnboardingCompleteWithProviderLick) => void;

  onAccountsChanged?: () => void;

  launchOAuth?: (providerId: string, baseUrl?: string | null) => Promise<OAuthLaunchResult>;

  fetchImpl?: typeof fetch;

  rand?: RandomFn;
}

type Stage = 'idle' | 'collect-profile' | 'awaiting-connect' | 'connecting' | 'complete';

export class OnboardingOrchestrator {
  private deps: OrchestratorDeps;
  private stage: Stage = 'idle';
  private profile: OnboardingProfile = {};

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  getStage(): Stage {
    return this.stage;
  }

  getProfile(): OnboardingProfile {
    return { ...this.profile };
  }

  handleFirstRun(): void {
    if (this.stage !== 'idle') return;
    this.stage = 'collect-profile';
    this.deps.postDipReference("Welcome to SLICC — let's get you set up.");
    this.deps.postDipReference('![Welcome](/shared/sprinkles/welcome/welcome.shtml)');
  }

  async handleOnboardingComplete(profile: OnboardingProfile): Promise<boolean> {
    if (this.stage !== 'idle' && this.stage !== 'collect-profile') {
      log.debug('Ignoring duplicate onboarding-complete', { stage: this.stage });
      return true;
    }
    this.profile = profile ?? {};
    this.stage = 'awaiting-connect';

    void recordWelcomed(this.deps.fs).catch((err) => log.warn('recordWelcomed failed', err));
    void this.persistProfile(this.profile).catch((err) => log.warn('persistProfile failed', err));

    const lines = buildIntroMessages(this.profile, this.deps.rand);
    for (const line of lines) {
      this.deps.postSystemMessage(line);
    }
    this.deps.postDipReference('![Connect a model](/shared/sprinkles/welcome/connect-llm.shtml)');
    return true;
  }

  handleConnectReady(): void {
    if (this.stage === 'complete') return;
    const catalogue = this.deps.getProviderCatalogue();
    this.deps.broadcastToDip({
      type: 'slicc-providers',
      providers: catalogue.providers,
      models: catalogue.models,
    });
  }

  async handleConnectAttempt(payload: ConnectAttemptPayload): Promise<void> {
    if (this.stage === 'complete') return;
    this.stage = 'connecting';

    const { provider, apiKey, baseUrl, deployment, apiVersion, model } = payload;
    if (!provider || typeof apiKey !== 'string' || !apiKey.trim()) {
      this.deps.broadcastToDip({
        type: 'slicc-connect-result',
        ok: false,
        kind: 'failed',
        message: 'Provider and API key are required.',
      });
      this.stage = 'awaiting-connect';
      return;
    }

    const requiredFieldError = this.validateProviderRequiredFields(provider, baseUrl, deployment);
    if (requiredFieldError) {
      this.deps.broadcastToDip({
        type: 'slicc-connect-result',
        ok: false,
        kind: 'failed',
        message: requiredFieldError,
      });
      this.stage = 'awaiting-connect';
      return;
    }

    let result: ValidationResult;
    try {
      result = await validateApiKey({
        provider,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl ?? undefined,
        fetchImpl: this.deps.fetchImpl,
      });
    } catch (err) {
      log.warn('validateApiKey threw', err);
      this.deps.broadcastToDip({
        type: 'slicc-connect-result',
        ok: false,
        kind: 'failed',
        message: 'Validation request was aborted.',
      });
      this.stage = 'awaiting-connect';
      return;
    }

    if (result.kind === 'failed') {
      this.deps.broadcastToDip({
        type: 'slicc-connect-result',
        ok: false,
        kind: 'failed',
        message: result.message,
      });
      this.stage = 'awaiting-connect';
      return;
    }

    let effectiveModel = model || null;
    if (!effectiveModel) {
      try {
        const catalogue = this.deps.getProviderCatalogue();
        const fallback = catalogue.models?.[provider]?.[0]?.id;
        if (fallback) effectiveModel = fallback;
      } catch (err) {
        log.warn('Failed to resolve fallback model for provider', { provider, err });
      }
    }
    try {
      this.deps.saveAccount(
        provider,
        apiKey.trim(),
        baseUrl?.trim() || undefined,
        deployment?.trim() || undefined,
        apiVersion?.trim() || undefined
      );

      if (effectiveModel) {
        this.deps.setSelectedModel(prefixModel(provider, effectiveModel));
      }
    } catch (err) {
      log.warn('saveAccount failed', err);
      this.deps.broadcastToDip({
        type: 'slicc-connect-result',
        ok: false,
        kind: 'failed',
        message: 'Failed to save credentials locally.',
      });
      this.stage = 'awaiting-connect';
      return;
    }

    try {
      this.deps.onAccountsChanged?.();
    } catch (err) {
      log.warn('onAccountsChanged threw', err);
    }

    const note =
      result.kind === 'skipped'
        ? `Saved — ${result.reason}`
        : 'Validated against the provider. Ready when you are.';
    this.deps.broadcastToDip({
      type: 'slicc-connect-result',
      ok: true,
      kind: result.kind,
      note,
    });

    const modelLabel =
      effectiveModel && this.deps.resolveModelLabel?.(provider, effectiveModel)
        ? this.deps.resolveModelLabel?.(provider, effectiveModel)
        : effectiveModel || null;
    this.stage = 'complete';
    this.deps.fireFinalLick({
      action: 'onboarding-complete-with-provider',
      data: {
        profile: this.profile,
        provider,
        model: effectiveModel ?? null,
        modelLabel,
        validation: result.kind,
      },
    });
  }

  async handleOAuthAttempt(payload: OAuthAttemptPayload): Promise<void> {
    if (this.stage === 'complete') return;
    if (!this.deps.launchOAuth) {
      this.deps.broadcastToDip({
        type: 'slicc-connect-result',
        ok: false,
        kind: 'failed',
        message: 'OAuth login is not available in this runtime.',
      });
      return;
    }
    this.stage = 'connecting';

    let result: OAuthLaunchResult;
    try {
      result = await this.deps.launchOAuth(payload.provider, payload.baseUrl ?? null);
    } catch (err) {
      log.warn('launchOAuth threw', err);
      this.deps.broadcastToDip({
        type: 'slicc-connect-result',
        ok: false,
        kind: 'failed',
        message: err instanceof Error ? err.message : 'Login was cancelled.',
      });
      this.stage = 'awaiting-connect';
      return;
    }

    if (!result.ok) {
      this.deps.broadcastToDip({
        type: 'slicc-connect-result',
        ok: false,
        kind: 'failed',
        message: result.message || 'Login was cancelled.',
      });
      this.stage = 'awaiting-connect';
      return;
    }

    if (result.model) {
      try {
        this.deps.setSelectedModel(prefixModel(payload.provider, result.model));
      } catch (err) {
        log.warn('setSelectedModel after OAuth failed', err);
      }
    }

    try {
      this.deps.onAccountsChanged?.();
    } catch (err) {
      log.warn('onAccountsChanged threw', err);
    }

    this.deps.broadcastToDip({
      type: 'slicc-connect-result',
      ok: true,
      kind: 'ok',
      note: result.message || 'Logged in.',
    });

    const modelLabel =
      result.model && this.deps.resolveModelLabel?.(payload.provider, result.model)
        ? this.deps.resolveModelLabel?.(payload.provider, result.model)
        : (result.model ?? null);
    this.stage = 'complete';
    this.deps.fireFinalLick({
      action: 'onboarding-complete-with-provider',
      data: {
        profile: this.profile,
        provider: payload.provider,
        model: result.model ?? null,
        modelLabel,
        validation: 'oauth',
      },
    });
  }

  private validateProviderRequiredFields(
    provider: string,
    baseUrl: string | null | undefined,
    deployment: string | null | undefined
  ): string | null {
    let providerEntry: ProviderEntry | undefined;
    try {
      providerEntry = this.deps.getProviderCatalogue().providers.find((p) => p.id === provider);
    } catch (err) {
      log.warn('getProviderCatalogue threw during required-field gate', err);
      return 'Could not load provider requirements. Please try again.';
    }
    if (providerEntry?.requiresDeployment && !deployment?.trim()) {
      return `${providerEntry.name} requires a deployment name.`;
    }
    if (providerEntry?.requiresBaseUrl && !baseUrl?.trim()) {
      return `${providerEntry.name} requires a base URL.`;
    }
    return null;
  }

  private async persistProfile(profile: OnboardingProfile): Promise<void> {
    const slug = slugify(profile.name || 'user', { fallback: 'user' });

    await this.deps.fs.writeFile(`/home/${slug}/.welcome.json`, JSON.stringify(profile, null, 2));
  }
}

function prefixModel(provider: string, modelId: string): string {
  if (modelId.startsWith(`${provider}:`)) return modelId;
  return `${provider}:${modelId}`;
}
