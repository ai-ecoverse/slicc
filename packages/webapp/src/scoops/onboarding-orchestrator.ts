/**
 * OnboardingOrchestrator — owns the post-welcome flow.
 *
 * Phases:
 *
 *   1. **collect-profile** — handled by `welcome.shtml`. Produces
 *      `onboarding-complete` lick with a `OnboardingProfile`.
 *   2. **deterministic-intro** — `handleOnboardingComplete()` saves
 *      the profile, kicks off `upskill recommendations --install`
 *      *silently in the background*, posts three deterministic
 *      sliccy lines into chat (no LLM), then renders the
 *      `connect-llm.shtml` dip.
 *   3. **connect-llm** — the dip emits `connect-ready` (we reply with
 *      the live provider catalogue) then `connect-attempt` with the
 *      user's chosen provider + key. We validate, save, and finally
 *      fire the `onboarding-complete-with-provider` lick to the
 *      cone — at THIS point an LLM is wired up, so the cone's
 *      response (per `welcome` SKILL.md) is purely a brief greeting
 *      that comments on the model+provider choice. Everything else
 *      that used to be LLM-driven (profile save, skill install,
 *      capability table) now happens deterministically up-front.
 *
 * The orchestrator deliberately **does not** import any UI surface
 * directly — the host wires in callbacks. That keeps it testable
 * and keeps the standalone/extension paths in `main.ts` symmetric.
 */

import { createLogger } from '../core/logger.js';
import type { VirtualFS } from '../fs/index.js';
import { recordWelcomed } from './welcome-detection.js';
import type { OnboardingProfile, RandomFn } from './onboarding-messages.js';
import { buildIntroMessages } from './onboarding-messages.js';
import { validateApiKey, type ValidationResult } from './api-key-validator.js';

const log = createLogger('onboarding-orchestrator');

/**
 * Snapshot describing a single provider, dip-safe (no functions).
 *
 * Mirrors the field set the Settings → Add Account dialog renders so
 * the welcome dip can stay in lock-step with it. When the settings
 * dialog gains a new per-provider input, this interface and the
 * `buildProviderCatalogue` callsites in `main.ts` should grow with it
 * — otherwise the dip silently saves an account missing required
 * fields (the original symptom that motivated this contract).
 */
export interface ProviderEntry {
  id: string;
  name: string;
  description?: string;
  requiresApiKey: boolean;
  requiresBaseUrl: boolean;
  /** True when the provider needs a deployment name (Azure OpenAI). */
  requiresDeployment?: boolean;
  /** True when the provider needs a custom api-version (Azure OpenAI). */
  requiresApiVersion?: boolean;
  /** Optional API-key placeholder shown in the dip's input. */
  apiKeyPlaceholder?: string;
  /** Optional env-var hint appended to the API-key label. */
  apiKeyEnvVar?: string;
  /** Default value pre-filled into the base-url input. */
  defaultBaseUrl?: string;
  /** Helper text shown below the base-url input. */
  baseUrlDescription?: string;
  /** Placeholder for the deployment input. */
  deploymentPlaceholder?: string;
  /** Helper text shown below the deployment input. */
  deploymentDescription?: string;
  /** Default value (and placeholder) for the api-version input. */
  apiVersionDefault?: string;
  /** Helper text shown below the api-version input. */
  apiVersionDescription?: string;
  /** True when this provider authenticates via an OAuth popup. */
  isOAuth?: boolean;
}

/** Snapshot of a single model, dip-safe. */
export interface ProviderModel {
  id: string;
  name?: string;
}

/** Combined provider + model catalogue handed to the dip. */
export interface ProviderCatalogue {
  providers: ProviderEntry[];
  models: Record<string, ProviderModel[]>;
}

export interface ConnectAttemptPayload {
  provider: string;
  apiKey: string;
  baseUrl?: string | null;
  /** Deployment name for providers with `requiresDeployment` (Azure OpenAI). */
  deployment?: string | null;
  /** API version for providers with `requiresApiVersion` (Azure OpenAI). */
  apiVersion?: string | null;
  model?: string | null;
}

export interface OAuthAttemptPayload {
  provider: string;
  baseUrl?: string | null;
}

/** Result returned by the host's OAuth launcher callback. */
export interface OAuthLaunchResult {
  ok: boolean;
  /** Optional model id to set as selected after OAuth completes. */
  model?: string | null;
  message?: string;
}

export interface OrchestratorDeps {
  /** Shared filesystem for profile + welcomed-marker writes. */
  fs: VirtualFS;
  /** Append a sliccy-styled message into the chat without invoking the LLM. */
  postSystemMessage: (line: string) => void;
  /**
   * Append a markdown line that contains a `.shtml` image reference,
   * which the chat-panel hydrates into an inline dip.
   */
  postDipReference: (markdown: string) => void;
  /** Get the live provider catalogue snapshot. */
  getProviderCatalogue: () => ProviderCatalogue;
  /** Persist credentials. Mirrors `provider-settings.addAccount`. */
  saveAccount: (
    providerId: string,
    apiKey: string,
    baseUrl?: string,
    deployment?: string,
    apiVersion?: string
  ) => void;
  /** Set the active model id (mirrors `setSelectedModelId`). */
  setSelectedModel: (modelId: string) => void;
  /** Optional human label for the model that gets selected. */
  resolveModelLabel?: (providerId: string, modelId: string) => string | null;
  /** Send a message into the open `connect-llm` dip. */
  broadcastToDip: (payload: { type: string; [k: string]: unknown }) => void;
  /** Fire the FINAL onboarding-complete-with-provider lick to the cone. */
  fireFinalLick: (data: Record<string, unknown>) => void;
  /**
   * Launch the provider's OAuth flow. Resolves once the popup
   * completes and the host has saved the OAuth account locally.
   * Optional — providers without OAuth support can skip this.
   */
  launchOAuth?: (providerId: string, baseUrl?: string | null) => Promise<OAuthLaunchResult>;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional RNG for deterministic message picking in tests. */
  rand?: RandomFn;
}

type Stage = 'idle' | 'awaiting-connect' | 'connecting' | 'complete';

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

  /**
   * Phase transition: idle → collect-profile.
   * Called when the boot detects no `.welcomed` marker. Posts the
   * welcome dip directly into the chat without invoking the cone.
   * The cone has no API key on first run, so any LLM-driven path
   * here would surface a "No API key configured" error before the
   * user even gets a chance to type.
   */
  handleFirstRun(): void {
    if (this.stage !== 'idle') return;
    this.deps.postDipReference("Welcome to SLICC — let's get you set up.");
    this.deps.postDipReference('![Welcome](/shared/sprinkles/welcome/welcome.shtml)');
  }

  /**
   * Phase transition: collect-profile → deterministic-intro.
   * Called when the welcome wizard fires `onboarding-complete`. Returns
   * `true` when handled by the orchestrator (caller MUST suppress the
   * default cone-routing for this lick); `false` if the caller should
   * fall back to the legacy path.
   */
  async handleOnboardingComplete(profile: OnboardingProfile): Promise<boolean> {
    if (this.stage !== 'idle') {
      log.debug('Ignoring duplicate onboarding-complete', { stage: this.stage });
      return true;
    }
    this.profile = profile ?? {};
    this.stage = 'awaiting-connect';

    // Persist the welcome marker + profile in parallel. We don't
    // wait for the writes — even if they fail, the on-screen flow
    // continues so the user is never blocked by a transient FS hiccup.
    // Skill install happens at the tail of the cone's
    // `onboarding-complete-with-provider` reply (see welcome/SKILL.md),
    // not here — keeping it cone-driven gives the user one canonical
    // install point and avoids racing two concurrent installs.
    void recordWelcomed(this.deps.fs).catch((err) => log.warn('recordWelcomed failed', err));
    void this.persistProfile(this.profile).catch((err) => log.warn('persistProfile failed', err));

    // Three deterministic lines, then the connect-llm dip.
    const lines = buildIntroMessages(this.profile, this.deps.rand);
    for (const line of lines) {
      this.deps.postSystemMessage(line);
    }
    this.deps.postDipReference('![Connect a model](/shared/sprinkles/welcome/connect-llm.shtml)');
    return true;
  }

  /** Dip is mounted and asking for the provider catalogue.
   *
   * Responds in any non-complete stage. The dip emits `connect-ready`
   * whenever it (re)mounts — including after a reload where the
   * persistent welcome-flow ledger suppressed the prior
   * `onboarding-complete` and left the orchestrator at `idle`. We
   * still need to feed the catalogue so the dip leaves its
   * "Loading providers…" state.
   *
   * If onboarding has already wired a provider, the host short-
   * circuits with a `slicc-already-connected` message before this
   * runs, so the only remaining `complete` case is a programmatic
   * re-fire we can safely ignore.
   */
  handleConnectReady(): void {
    if (this.stage === 'complete') return;
    const catalogue = this.deps.getProviderCatalogue();
    this.deps.broadcastToDip({
      type: 'slicc-providers',
      providers: catalogue.providers,
      models: catalogue.models,
    });
  }

  /** User submitted a provider + key.
   *
   * Idle is also a valid entry stage — see `handleConnectReady` for
   * the reload case where the dip is re-mounted from chat history
   * after the welcome-flow ledger already suppressed
   * `onboarding-complete`.
   */
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

    // Match the Settings → Add Account dialog's required-field gate
    // so the dip can't silently save half-configured Azure-style
    // accounts. Without this, picking azure-openai from the welcome
    // dip used to write an account missing deployment + api-version
    // and break at the first chat request.
    const providerEntry = (() => {
      try {
        return this.deps.getProviderCatalogue().providers.find((p) => p.id === provider);
      } catch {
        return undefined;
      }
    })();
    if (providerEntry?.requiresDeployment && !deployment?.trim()) {
      this.deps.broadcastToDip({
        type: 'slicc-connect-result',
        ok: false,
        kind: 'failed',
        message: `${providerEntry.name} requires a deployment name.`,
      });
      this.stage = 'awaiting-connect';
      return;
    }
    if (providerEntry?.requiresBaseUrl && !baseUrl?.trim()) {
      this.deps.broadcastToDip({
        type: 'slicc-connect-result',
        ok: false,
        kind: 'failed',
        message: `${providerEntry.name} requires a base URL.`,
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

    // Authentication failure surfaces in the dip; we leave the user
    // in `awaiting-connect` so they can correct the key and retry.
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

    // Both `ok` and `skipped` count as accept-and-save for the
    // orchestrator; the dip surfaces the difference inline.
    //
    // When the dip omits a model (the welcome dip no longer
    // surfaces a model picker), fall back to the first model the
    // provider catalogue advertises for the just-saved provider.
    // Without this fallback, a stale `selected-model` from a
    // previously-removed provider would survive onboarding and
    // immediately fail chat requests until the user manually
    // corrected the header dropdown.
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
      if (effectiveModel) this.deps.setSelectedModel(effectiveModel);
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

    // Hand off to the cone — now that an LLM is configured, the cone
    // can comment on the choice. SKILL.md spells out the exact reply.
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

  /** User picked an OAuth provider and clicked "Login".
   *
   * Idle is also a valid entry stage — see `handleConnectReady` for
   * the reload case where the dip is re-mounted from chat history
   * after the welcome-flow ledger already suppressed
   * `onboarding-complete`.
   */
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
        this.deps.setSelectedModel(result.model);
      } catch (err) {
        log.warn('setSelectedModel after OAuth failed', err);
      }
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

  /** Internal — write the user's profile to /home/<name>/.welcome.json. */
  private async persistProfile(profile: OnboardingProfile): Promise<void> {
    const slug =
      (profile.name || 'user')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-+|-+$)/g, '') || 'user';
    // writeFile auto-creates parent directories so we don't need a
    // separate mkdir call.
    await this.deps.fs.writeFile(`/home/${slug}/.welcome.json`, JSON.stringify(profile, null, 2));
  }
}
