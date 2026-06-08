/**
 * `setup-welcome-flow.ts` — boot stage that owns the persistent
 * welcome-flow dedup ledger AND the lick interceptor shared by both
 * `mainExtension` and `mainStandaloneWorker`.
 *
 * The interceptor decides whether a sprinkle/inline-dip lick belongs to
 * the deterministic onboarding flow (`first-run`, `connect-ready`, etc.)
 * and routes it to the page-resident `OnboardingOrchestrator` instead of
 * letting it reach the cone — the cone has no API key configured at
 * welcome-time and any unhandled lick would fatal with "No API key
 * configured for provider …".
 *
 * Both float-specific copies (~main.ts `interceptWelcomeLickExt` and
 * `interceptWelcomeLick`) were byte-equivalent except for the dispatch
 * targets, which are now injected as deps.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import type { BootStageLogger } from './types.js';

/**
 * Welcome-flow lick actions that must fire at most ONCE per browser
 * profile (not per session — reloads share the same ledger). Each one
 * is a state transition rather than an idempotent read.
 */
export const DEDUPED_WELCOME_ACTIONS = new Set<string>([
  'first-run',
  'onboarding-complete',
  'onboarding-complete-with-provider',
  'shortcut-migrate',
]);

const WELCOME_FLOW_LEDGER_KEY = 'slicc:welcome-flow-fired';

export function loadFiredWelcomeActions(): Set<string> {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(WELCOME_FLOW_LEDGER_KEY) : null;
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function persistFiredWelcomeActions(set: Set<string>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(WELCOME_FLOW_LEDGER_KEY, JSON.stringify([...set]));
  } catch {
    /* quota / disabled — fall back to in-memory dedup only */
  }
}

/**
 * Run `fire` only if the given welcome-flow action hasn't been fired
 * yet for this profile. Updates the persistent ledger on first fire.
 */
export function dispatchWelcomeLickOnce(
  action: string,
  set: Set<string>,
  fire: () => void,
  contextLabel: string,
  log: BootStageLogger
): void {
  if (DEDUPED_WELCOME_ACTIONS.has(action) && set.has(action)) {
    log.debug(`Suppressing duplicate welcome lick (${contextLabel})`, { action });
    return;
  }
  if (DEDUPED_WELCOME_ACTIONS.has(action)) {
    set.add(action);
    persistFiredWelcomeActions(set);
  }
  fire();
}

const WELCOME_FLOW_ACTIONS = new Set<string>([
  'first-run',
  'onboarding-complete',
  'connect-ready',
  'connect-attempt',
  'oauth-attempt',
  'device-code-decision',
  'shortcut-migrate',
]);

interface WelcomeFastForwardDispatcher {
  fire(data: Record<string, unknown>): void;
  // Optional broadcast on fast-forward (sends `slicc-already-connected` to dips)
  broadcastAlreadyConnected(providerId: string): void;
}

/**
 * Dependencies for `createWelcomeLickInterceptor()`. The interceptor
 * delegates each branch to the orchestrator + provider-settings helpers
 * the caller supplies, so the same body serves both floats.
 */
export interface WelcomeLickInterceptorDeps {
  /** In-memory dedup ledger (mutated on first fire). */
  firedWelcomeActions: Set<string>;
  /** Provider/account read helpers. */
  getAccounts(): Array<{ providerId: string }>;
  getProviderConfig(id: string): { name?: string } | null;
  /** Resolves the device-code prompter promise (continue / cancel). */
  resolveDeviceCodeDecision(decision: 'cancel' | 'continue'): void;
  /** Resolves the lazy onboarding orchestrator. */
  getOnboardingOrchestrator(): {
    handleFirstRun(): void;
    handleOnboardingComplete(profile: Record<string, unknown>): Promise<unknown>;
    handleConnectReady(): void;
    handleConnectAttempt(input: {
      provider: string;
      apiKey: string;
      baseUrl: string | null;
      deployment: string | null;
      apiVersion: string | null;
      model: string | null;
    }): Promise<unknown>;
    handleOAuthAttempt(input: { provider: string; baseUrl: string | null }): Promise<unknown>;
  };
  /** Optional pending-mount applier; only the extension path wires this. */
  applyPendingMount?: () => Promise<void>;
  /** Float-specific fast-forward dispatcher. */
  fastForward: WelcomeFastForwardDispatcher;
  /** Float-specific shortcut-migrate handler (writes the welcome sentinel). */
  onShortcutMigrate(): void;
  /** Float tag used in the persistent dedup log message. */
  contextLabel: string;
  /** Page-side VFS used by the fast-forward profile loader (cone path). */
  vfs: VirtualFS | null;
  /** Logger for the dedup / fast-forward warnings. */
  log: BootStageLogger;
}

/**
 * Build the welcome-lick interceptor. Returns `true` when the lick was
 * intercepted and MUST NOT be forwarded to the cone.
 */
export function createWelcomeLickInterceptor(
  deps: WelcomeLickInterceptorDeps
): (event: LickEvent) => boolean {
  const {
    firedWelcomeActions,
    getAccounts,
    getProviderConfig,
    resolveDeviceCodeDecision,
    getOnboardingOrchestrator,
    applyPendingMount,
    fastForward,
    onShortcutMigrate,
    contextLabel,
    vfs,
    log,
  } = deps;

  return (event: LickEvent): boolean => {
    if (event.type !== 'sprinkle') return false;
    const welcomeAction =
      event.sprinkleName === 'welcome' || event.sprinkleName === 'inline'
        ? ((event.body as Record<string, unknown> | null)?.action as string | undefined)
        : undefined;
    if (welcomeAction && DEDUPED_WELCOME_ACTIONS.has(welcomeAction)) {
      if (firedWelcomeActions.has(welcomeAction)) {
        log.debug(`Suppressing duplicate welcome lick (${contextLabel})`, {
          action: welcomeAction,
        });
        return true;
      }
      firedWelcomeActions.add(welcomeAction);
      persistFiredWelcomeActions(firedWelcomeActions);
    }
    if (!welcomeAction || !WELCOME_FLOW_ACTIONS.has(welcomeAction)) return false;

    const body = event.body as Record<string, unknown> | null;
    return dispatchWelcomeBranch(welcomeAction, body, {
      getAccounts,
      getProviderConfig,
      resolveDeviceCodeDecision,
      getOnboardingOrchestrator,
      applyPendingMount,
      fastForward,
      onShortcutMigrate,
      vfs,
      log,
    });
  };
}

interface WelcomeBranchDeps
  extends Omit<WelcomeLickInterceptorDeps, 'firedWelcomeActions' | 'contextLabel'> {}

function dispatchWelcomeBranch(
  action: string,
  body: Record<string, unknown> | null,
  deps: WelcomeBranchDeps
): boolean {
  const {
    getAccounts,
    getProviderConfig,
    resolveDeviceCodeDecision,
    getOnboardingOrchestrator,
    applyPendingMount,
    fastForward,
    onShortcutMigrate,
    vfs,
    log,
  } = deps;

  if (action === 'device-code-decision') {
    const decision = (body?.data as { decision?: unknown } | undefined)?.decision;
    resolveDeviceCodeDecision(decision === 'cancel' ? 'cancel' : 'continue');
    return true;
  }
  if (action === 'first-run') {
    getOnboardingOrchestrator().handleFirstRun();
    return true;
  }
  if (action === 'onboarding-complete') {
    const orch = getOnboardingOrchestrator();
    const profile = (body?.data as Record<string, unknown> | undefined) ?? {};
    if ((profile as Record<string, unknown>).mountWorkspace && applyPendingMount) {
      applyPendingMount().catch((err) =>
        log.warn('Failed to mount workspace from onboarding', err)
      );
    }
    void orch
      .handleOnboardingComplete(profile as Record<string, unknown>)
      .catch((err) => log.warn('OnboardingOrchestrator failed', err));
    return true;
  }
  if (action === 'connect-ready') {
    return handleConnectReadyBranch({
      getAccounts,
      getProviderConfig,
      getOnboardingOrchestrator,
      fastForward,
      vfs,
      log,
    });
  }
  if (action === 'connect-attempt') {
    const data = body?.data as Record<string, unknown> | undefined;
    if (data) {
      void getOnboardingOrchestrator()
        .handleConnectAttempt({
          provider: String(data.provider ?? ''),
          apiKey: String(data.apiKey ?? ''),
          baseUrl: typeof data.baseUrl === 'string' && data.baseUrl ? String(data.baseUrl) : null,
          deployment:
            typeof data.deployment === 'string' && data.deployment ? String(data.deployment) : null,
          apiVersion:
            typeof data.apiVersion === 'string' && data.apiVersion ? String(data.apiVersion) : null,
          model: data.model == null ? null : String(data.model),
        })
        .catch((err) => log.warn('handleConnectAttempt failed', err));
    }
    return true;
  }
  if (action === 'oauth-attempt') {
    const data = body?.data as Record<string, unknown> | undefined;
    if (data) {
      void getOnboardingOrchestrator()
        .handleOAuthAttempt({
          provider: String(data.provider ?? ''),
          baseUrl: typeof data.baseUrl === 'string' && data.baseUrl ? String(data.baseUrl) : null,
        })
        .catch((err) => log.warn('handleOAuthAttempt failed', err));
    }
    return true;
  }
  if (action === 'shortcut-migrate') {
    onShortcutMigrate();
    return true;
  }
  return false;
}

function handleConnectReadyBranch(deps: {
  getAccounts: WelcomeBranchDeps['getAccounts'];
  getProviderConfig: WelcomeBranchDeps['getProviderConfig'];
  getOnboardingOrchestrator: WelcomeBranchDeps['getOnboardingOrchestrator'];
  fastForward: WelcomeFastForwardDispatcher;
  vfs: VirtualFS | null;
  log: BootStageLogger;
}): boolean {
  const accounts = deps.getAccounts();
  if (accounts.length === 0) {
    deps.getOnboardingOrchestrator().handleConnectReady();
    return true;
  }
  const primary = accounts[0];
  deps.fastForward.broadcastAlreadyConnected(primary.providerId);
  void fireFastForwardFinalLick(deps.vfs, primary.providerId, deps.fastForward.fire).catch((err) =>
    deps.log.warn('Failed to fire fast-forward final lick', err)
  );
  return true;
}

/**
 * Re-fire the welcome-flow's final `onboarding-complete-with-provider`
 * lick when the connect-llm dip is fast-forwarded on reload. The
 * orchestrator's normal connect-attempt path never runs in that case so
 * the cone would otherwise never get to greet the user with the model
 * name. Skipped when the cone already has the lick in its history.
 */
export async function fireFastForwardFinalLick(
  fs: VirtualFS | null,
  providerId: string,
  fire: (data: Record<string, unknown>) => void
): Promise<void> {
  const { hasOnboardingFinalLickInHistory } = await import('../../scoops/welcome-detection.js');
  if (await hasOnboardingFinalLickInHistory()) return;
  const profile = fs ? await loadPersistedProfile(fs) : {};
  const { getSelectedModelId, getProviderConfig, getProviderModels } = await import(
    '../provider-settings.js'
  );
  const modelId = (() => {
    try {
      return getSelectedModelId() || null;
    } catch {
      return null;
    }
  })();
  const modelLabel = (() => {
    if (!modelId) return null;
    try {
      const found = getProviderModels(providerId).find((m) => m.id === modelId);
      return found?.name ?? modelId;
    } catch {
      return modelId;
    }
  })();
  let providerName: string | null = null;
  try {
    providerName = getProviderConfig(providerId).name ?? null;
  } catch {
    /* keep null */
  }
  fire({
    action: 'onboarding-complete-with-provider',
    data: {
      profile,
      provider: providerId,
      providerName,
      model: modelId,
      modelLabel,
      validation: 'preexisting',
    },
  });
}

/**
 * Read the most recently-written `/home/<slug>/.welcome.json` so the
 * fast-forward path can hand the cone the same profile shape the
 * orchestrator would have. Returns `{}` on any failure.
 */
async function loadPersistedProfile(fs: VirtualFS): Promise<Record<string, unknown>> {
  try {
    const homes = await fs.readDir('/home');
    let best: { profile: Record<string, unknown>; mtime: number } | null = null;
    for (const entry of homes) {
      if (entry.type !== 'directory') continue;
      const path = `/home/${entry.name}/.welcome.json`;
      try {
        const stat = await fs.stat(path);
        const mtime = stat.mtime ?? 0;
        if (best && mtime <= best.mtime) continue;
        const raw = await fs.readFile(path, { encoding: 'utf-8' });
        const parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
        if (parsed && typeof parsed === 'object') {
          best = { profile: parsed as Record<string, unknown>, mtime };
        }
      } catch {
        /* skip slugs without a profile */
      }
    }
    return best?.profile ?? {};
  } catch {
    return {};
  }
}
