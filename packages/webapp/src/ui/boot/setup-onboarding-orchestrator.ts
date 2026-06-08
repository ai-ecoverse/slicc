/**
 * `setup-onboarding-orchestrator.ts` — shared OnboardingOrchestrator
 * factory + provider catalogue builder used by both `mainExtension` and
 * `mainStandaloneWorker`.
 *
 * The two float-specific copies were almost identical: only the binding
 * to `provider-settings.ts` differed (extension renamed imports to
 * avoid lexical conflicts). This module accepts those helpers as deps
 * so the same factory drives both floats.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { DeviceCodePrompter } from '../../providers/types.js';
import type {
  OnboardingOrchestrator,
  ProviderCatalogue,
  ProviderEntry,
  ProviderModel,
} from '../../scoops/onboarding-orchestrator.js';
import { resolveDefaultModel } from '../onboarding-helpers.js';
import type { BootStageLogger } from './types.js';

/**
 * Provider-settings surface needed by the orchestrator factory. Both
 * floats reach the same module (`../provider-settings.js`) — we accept
 * the bag here so tests can substitute fakes without touching globals.
 */
export interface OnboardingProviderHelpers {
  getAvailableProviders(): string[];
  providerOffersLlmModels(id: string): boolean;
  getProviderConfig(id: string): ProviderConfigSnapshot;
  getProviderModels(id: string): ProviderModel[];
  isModelHiddenFromPicker(id: string): boolean;
  addAccount(
    id: string,
    key: string,
    baseUrl?: string,
    deployment?: string,
    apiVersion?: string
  ): void;
  setSelectedModelId(id: string): void;
}

// Subset of provider-settings `getProviderConfig()` return type that the
// onboarding factory actually reads. Kept structurally compatible with
// `provider-settings.ProviderConfig` so the importing call sites can
// pass the module namespace directly.
export interface ProviderConfigSnapshot {
  id: string;
  name?: string;
  description?: string;
  requiresApiKey?: boolean;
  requiresBaseUrl?: boolean;
  requiresDeployment?: boolean;
  requiresApiVersion?: boolean;
  apiKeyPlaceholder?: string | null;
  apiKeyEnvVar?: string | null;
  baseUrlPlaceholder?: string | null;
  baseUrlDescription?: string | null;
  deploymentPlaceholder?: string | null;
  deploymentDescription?: string | null;
  apiVersionDefault?: string | null;
  apiVersionDescription?: string | null;
  isOAuth?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onOAuthLogin?: (launcher: any, onSuccess: () => void, options?: any) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onOAuthLoginIntercepted?: (launcher: any, onSuccess: () => void, options?: any) => Promise<void>;
}

export interface OnboardingDeviceCodeHelpers {
  createSprinkleDeviceCodePrompter(args: {
    broadcastToDip: (payload: { type: string; [k: string]: unknown }) => void;
  }): DeviceCodePrompter;
}

/**
 * Build a fresh provider catalogue (providers + models) for the
 * onboarding orchestrator. Identical shape across both floats.
 */
export function buildOnboardingProviderCatalogue(
  deps: OnboardingProviderHelpers
): ProviderCatalogue {
  const ids = deps.getAvailableProviders().filter((id) => deps.providerOffersLlmModels(id));
  const providers: ProviderEntry[] = ids
    .map((id): ProviderEntry => {
      const cfg = deps.getProviderConfig(id);
      return {
        id: cfg.id,
        name: cfg.name ?? cfg.id,
        description: cfg.description,
        requiresApiKey: cfg.requiresApiKey ?? true,
        requiresBaseUrl: cfg.requiresBaseUrl ?? false,
        requiresDeployment: !!cfg.requiresDeployment,
        requiresApiVersion: !!cfg.requiresApiVersion,
        apiKeyPlaceholder: cfg.apiKeyPlaceholder ?? undefined,
        apiKeyEnvVar: cfg.apiKeyEnvVar ?? undefined,
        defaultBaseUrl: cfg.baseUrlPlaceholder ?? undefined,
        baseUrlDescription: cfg.baseUrlDescription ?? undefined,
        deploymentPlaceholder: cfg.deploymentPlaceholder ?? undefined,
        deploymentDescription: cfg.deploymentDescription ?? undefined,
        apiVersionDefault: cfg.apiVersionDefault ?? undefined,
        apiVersionDescription: cfg.apiVersionDescription ?? undefined,
        isOAuth: !!cfg.isOAuth,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const models: Record<string, ProviderModel[]> = {};
  for (const id of ids) {
    try {
      models[id] = deps
        .getProviderModels(id)
        .filter((m) => !deps.isModelHiddenFromPicker(m.id))
        .map((m) => ({ id: m.id, name: m.name }));
    } catch {
      models[id] = [];
    }
  }
  return { providers, models };
}

/**
 * Dependencies for `createOnboardingOrchestratorSetup()` — wires the
 * lazy orchestrator factory so callers can construct on first use.
 */
export interface OnboardingOrchestratorSetupDeps {
  fs: VirtualFS;
  log: BootStageLogger;
  providers: OnboardingProviderHelpers;
  deviceCode: OnboardingDeviceCodeHelpers;
  postSystemMessage(line: string): void;
  postDipReference(md: string): void;
  broadcastToDip(payload: { type: string; [k: string]: unknown }): void;
  /**
   * Float-specific final-lick dispatcher — already wraps
   * `flushCredentialsToWorker(client)` + `dispatchWelcomeLickOnce(...)`
   * around `client.sendSprinkleLick('welcome', data)`.
   */
  onFireFinalLick(data: Record<string, unknown>): void;
}

export interface OnboardingOrchestratorHandle {
  /** Lazily construct (or return the cached) orchestrator. */
  get(): OnboardingOrchestrator;
  /** Read-only access — returns null when not yet constructed. */
  peek(): OnboardingOrchestrator | null;
  /** Catalogue accessor, exported for convenience. */
  buildCatalogue(): ProviderCatalogue;
}

/**
 * Build the lazy onboarding-orchestrator handle. The orchestrator
 * itself is constructed on first `get()` so its `launchOAuth` hook can
 * capture the live sprinkle manager + welcome ledger by reference.
 * Behavior matches the inline copies in `mainExtension` and
 * `mainStandaloneWorker`. The dynamic import of
 * `scoops/onboarding-orchestrator.js` is identical in both
 * float-specific call sites — both immediately awaited it before any
 * lick could fire, so the same await fits into the boot stage.
 */
export async function createOnboardingOrchestratorSetup(
  deps: OnboardingOrchestratorSetupDeps
): Promise<OnboardingOrchestratorHandle> {
  const { OnboardingOrchestrator: OnboardingOrchestratorCtor } = await import(
    '../../scoops/onboarding-orchestrator.js'
  );
  let cached: OnboardingOrchestrator | null = null;

  const get = (): OnboardingOrchestrator => {
    if (cached) return cached;
    cached = new OnboardingOrchestratorCtor({
      fs: deps.fs,
      postSystemMessage: deps.postSystemMessage,
      postDipReference: deps.postDipReference,
      getProviderCatalogue: () => buildOnboardingProviderCatalogue(deps.providers),
      saveAccount: (id, key, baseUrl, deployment, apiVersion) =>
        deps.providers.addAccount(id, key, baseUrl, deployment, apiVersion),
      setSelectedModel: (id) => deps.providers.setSelectedModelId(id),
      resolveModelLabel: (provider, modelId) => {
        try {
          const found = deps.providers.getProviderModels(provider).find((m) => m.id === modelId);
          return found?.name ?? null;
        } catch {
          return null;
        }
      },
      broadcastToDip: (payload) => deps.broadcastToDip(payload),
      fireFinalLick: (data) => deps.onFireFinalLick(data),
      launchOAuth: async (providerId, baseUrl) =>
        await launchOnboardingOAuth(providerId, baseUrl ?? null, deps),
    });
    return cached;
  };

  return {
    get,
    peek: () => cached,
    buildCatalogue: () => buildOnboardingProviderCatalogue(deps.providers),
  };
}

async function launchOnboardingOAuth(
  providerId: string,
  baseUrl: string | null,
  deps: OnboardingOrchestratorSetupDeps
): Promise<{ ok: boolean; message?: string; model?: string | null }> {
  try {
    const cfg = deps.providers.getProviderConfig(providerId);
    if (!cfg.isOAuth || (!cfg.onOAuthLogin && !cfg.onOAuthLoginIntercepted)) {
      return { ok: false, message: 'Provider does not support OAuth.' };
    }
    if (cfg.requiresBaseUrl && baseUrl) deps.providers.addAccount(providerId, '', baseUrl);
    if (cfg.onOAuthLoginIntercepted) {
      const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
        '../../providers/oauth-service.js'
      );
      const launcher = await createInterceptingOAuthLauncherForCurrentRuntime();
      if (!launcher) {
        return {
          ok: false,
          message:
            'Intercepted OAuth requires the controlled-browser transport — open SLICC in standalone or extension mode.',
        };
      }
      await cfg.onOAuthLoginIntercepted(launcher, () => undefined, {
        presentDeviceCode: deps.deviceCode.createSprinkleDeviceCodePrompter({
          broadcastToDip: (payload) => deps.broadcastToDip(payload),
        }),
      });
    } else if (cfg.onOAuthLogin) {
      const { createOAuthLauncher } = await import('../../providers/oauth-service.js');
      const launcher = createOAuthLauncher();
      await cfg.onOAuthLogin(launcher, () => undefined);
    }
    return {
      ok: true,
      model: resolveDefaultModel(
        providerId,
        cfg as Parameters<typeof resolveDefaultModel>[1],
        deps.providers.getProviderModels as Parameters<typeof resolveDefaultModel>[2],
        deps.providers.isModelHiddenFromPicker as Parameters<typeof resolveDefaultModel>[3]
      ),
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'OAuth login failed.',
    };
  }
}
