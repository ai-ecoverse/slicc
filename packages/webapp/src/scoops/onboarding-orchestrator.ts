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

/** Snapshot describing a single provider, dip-safe (no functions). */
export interface ProviderEntry {
  id: string;
  name: string;
  description?: string;
  requiresApiKey: boolean;
  requiresBaseUrl: boolean;
  defaultBaseUrl?: string;
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
  saveAccount: (providerId: string, apiKey: string, baseUrl?: string) => void;
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
  /**
   * Direct (no-shell) installer for the recommended-skills set. Used to
   * land the user's matching skills immediately after the welcome wizard
   * without going through the wasm shell layer (which lives in a different
   * execution context in extension mode and isn't reachable from the
   * panel-side orchestrator). Errors are logged and swallowed by the
   * orchestrator.
   */
  installRecommendedSkills?: () => Promise<void>;
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
    void recordWelcomed(this.deps.fs).catch((err) => log.warn('recordWelcomed failed', err));
    void this.persistProfile(this.profile).catch((err) => log.warn('persistProfile failed', err));

    // Kick off skill install in the background — no UI block, no shell
    // round-trip. The helper handles "no profile" / "all installed" /
    // "catalog fetch failed" internally, so we just fire and forget.
    if (this.deps.installRecommendedSkills) {
      void this.deps
        .installRecommendedSkills()
        .catch((err) => log.warn('installRecommendedSkills failed', err));
    }

    // Three deterministic lines, then the connect-llm dip.
    const lines = buildIntroMessages(this.profile, this.deps.rand);
    for (const line of lines) {
      this.deps.postSystemMessage(line);
    }
    this.deps.postDipReference('![Connect a model](/shared/sprinkles/welcome/connect-llm.shtml)');
    return true;
  }

  /** Dip is mounted and asking for the provider catalogue. */
  handleConnectReady(): void {
    if (this.stage !== 'awaiting-connect' && this.stage !== 'connecting') return;
    const catalogue = this.deps.getProviderCatalogue();
    this.deps.broadcastToDip({
      type: 'slicc-providers',
      providers: catalogue.providers,
      models: catalogue.models,
    });
  }

  /** User submitted a provider + key. */
  async handleConnectAttempt(payload: ConnectAttemptPayload): Promise<void> {
    if (this.stage !== 'awaiting-connect' && this.stage !== 'connecting') return;
    this.stage = 'connecting';

    const { provider, apiKey, baseUrl, model } = payload;
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
    try {
      this.deps.saveAccount(provider, apiKey.trim(), baseUrl ?? undefined);
      if (model) this.deps.setSelectedModel(model);
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
      model && this.deps.resolveModelLabel?.(provider, model)
        ? this.deps.resolveModelLabel?.(provider, model)
        : model || null;
    this.stage = 'complete';
    this.deps.fireFinalLick({
      action: 'onboarding-complete-with-provider',
      data: {
        profile: this.profile,
        provider,
        model: model ?? null,
        modelLabel,
        validation: result.kind,
      },
    });
  }

  /** User picked an OAuth provider and clicked "Login". */
  async handleOAuthAttempt(payload: OAuthAttemptPayload): Promise<void> {
    if (this.stage !== 'awaiting-connect' && this.stage !== 'connecting') return;
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
