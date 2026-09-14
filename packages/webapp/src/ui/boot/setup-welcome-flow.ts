import type { VirtualFS } from '../../fs/index.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import type { OnboardingProfile } from '../../scoops/onboarding-messages.js';
import type { OnboardingFinalLickPayload } from './setup-onboarding-orchestrator.js';
import type { BootStageLogger } from './types.js';

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
  } catch {}
}

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

  'gelatiere-dismiss',
  'gelatiere-install',
  'gelatiere-try',
]);

export interface WelcomeLickBody {
  action?: unknown;
  data?: unknown;
  readonly [key: string]: unknown;
}

export interface WelcomeConnectAttemptData {
  provider?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  deployment?: unknown;
  apiVersion?: unknown;
  model?: unknown;
  readonly [key: string]: unknown;
}

export interface WelcomeOAuthAttemptData {
  provider?: unknown;
  baseUrl?: unknown;
  readonly [key: string]: unknown;
}

interface WelcomeGelatiereCardData {
  id?: unknown;
  readonly [key: string]: unknown;
}

export interface WelcomeDeviceCodeDecisionData {
  decision?: unknown;
  readonly [key: string]: unknown;
}

export interface WelcomeOnboardingCompleteData extends OnboardingProfile {
  mountWorkspace?: unknown;
}

interface WelcomeFastForwardDispatcher {
  fire(data: OnboardingFinalLickPayload): void;

  broadcastAlreadyConnected(providerId: string): void;
}

export interface WelcomeLickInterceptorDeps {
  firedWelcomeActions: Set<string>;

  getAccounts(): Array<{ providerId: string }>;
  getProviderConfig(id: string): { name?: string } | null;

  resolveDeviceCodeDecision(decision: 'cancel' | 'continue'): void;

  getOnboardingOrchestrator(): {
    handleFirstRun(): void;
    handleOnboardingComplete(profile: OnboardingProfile): Promise<unknown>;
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

  applyPendingMount?: () => Promise<void>;

  fastForward: WelcomeFastForwardDispatcher;

  onShortcutMigrate(): void;

  contextLabel: string;

  vfs: VirtualFS | null;

  log: BootStageLogger;
}

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
      event.sprinkleName === 'welcome' ||
      event.sprinkleName === 'inline' ||
      event.sprinkleName === 'suggestions'
        ? ((event.body as WelcomeLickBody | null)?.action as string | undefined)
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

    const body = event.body as WelcomeLickBody | null;
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

type WelcomeBranchBody = WelcomeLickBody | null;

function optString(data: { readonly [key: string]: unknown }, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value ? value : null;
}

function handleOnboardingCompleteBranch(body: WelcomeBranchBody, deps: WelcomeBranchDeps): boolean {
  const orch = deps.getOnboardingOrchestrator();
  const profile = (body?.data as WelcomeOnboardingCompleteData | undefined) ?? {};
  if (profile.mountWorkspace && deps.applyPendingMount) {
    deps
      .applyPendingMount()
      .catch((err) => deps.log.warn('Failed to mount workspace from onboarding', err));
  }
  void orch
    .handleOnboardingComplete(profile)
    .catch((err) => deps.log.warn('OnboardingOrchestrator failed', err));
  return true;
}

function handleConnectAttemptBranch(body: WelcomeBranchBody, deps: WelcomeBranchDeps): boolean {
  const data = body?.data as WelcomeConnectAttemptData | undefined;
  if (data) {
    void deps
      .getOnboardingOrchestrator()
      .handleConnectAttempt({
        provider: String(data.provider ?? ''),
        apiKey: String(data.apiKey ?? ''),
        baseUrl: optString(data, 'baseUrl'),
        deployment: optString(data, 'deployment'),
        apiVersion: optString(data, 'apiVersion'),
        model: data.model == null ? null : String(data.model),
      })
      .catch((err) => deps.log.warn('handleConnectAttempt failed', err));
  }
  return true;
}

function handleOAuthAttemptBranch(body: WelcomeBranchBody, deps: WelcomeBranchDeps): boolean {
  const data = body?.data as WelcomeOAuthAttemptData | undefined;
  if (data) {
    void deps
      .getOnboardingOrchestrator()
      .handleOAuthAttempt({
        provider: String(data.provider ?? ''),
        baseUrl: optString(data, 'baseUrl'),
      })
      .catch((err) => deps.log.warn('handleOAuthAttempt failed', err));
  }
  return true;
}

const WELCOME_BRANCHES: Record<
  string,
  (body: WelcomeBranchBody, deps: WelcomeBranchDeps) => boolean
> = {
  'device-code-decision': (body, deps) => {
    const decision = (body?.data as WelcomeDeviceCodeDecisionData | undefined)?.decision;
    deps.resolveDeviceCodeDecision(decision === 'cancel' ? 'cancel' : 'continue');
    return true;
  },
  'first-run': (_body, deps) => {
    deps.getOnboardingOrchestrator().handleFirstRun();
    return true;
  },
  'onboarding-complete': handleOnboardingCompleteBranch,
  'connect-ready': (_body, deps) => handleConnectReadyBranch(deps),
  'connect-attempt': handleConnectAttemptBranch,
  'oauth-attempt': handleOAuthAttemptBranch,
  'shortcut-migrate': (_body, deps) => {
    deps.onShortcutMigrate();
    return true;
  },
  'gelatiere-dismiss': (body, deps) => {
    settleGelatiereSuggestion(body, deps, 'dismiss');
    return true;
  },

  'gelatiere-install': (body, deps) => {
    settleGelatiereSuggestion(body, deps, 'take');
    return false;
  },
  'gelatiere-try': (body, deps) => {
    settleGelatiereSuggestion(body, deps, 'take');
    return false;
  },
};

let gelatiereModule: Promise<typeof import('../../base/gelatiere-store.js')> | undefined;
function loadGelatiereModule(): Promise<typeof import('../../base/gelatiere-store.js')> {
  gelatiereModule ??= import('../../base/gelatiere-store.js');
  return gelatiereModule;
}

function settleGelatiereSuggestion(
  body: WelcomeBranchBody,
  deps: WelcomeBranchDeps,
  mode: 'dismiss' | 'take'
): void {
  const id = (body?.data as WelcomeGelatiereCardData | undefined)?.id;
  if (typeof id !== 'string' || !id || !deps.vfs) return;
  const vfs = deps.vfs;
  void loadGelatiereModule()
    .then(({ dismissGelatiereSuggestion, takeGelatiereSuggestion }) =>
      mode === 'take' ? takeGelatiereSuggestion(vfs, id) : dismissGelatiereSuggestion(vfs, id)
    )
    .catch((err) => deps.log.warn('Failed to settle gelatiere suggestion', err));
}

function dispatchWelcomeBranch(
  action: string,
  body: WelcomeBranchBody,
  deps: WelcomeBranchDeps
): boolean {
  return WELCOME_BRANCHES[action]?.(body, deps) ?? false;
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

export async function fireFastForwardFinalLick(
  fs: VirtualFS | null,
  providerId: string,
  fire: (data: OnboardingFinalLickPayload) => void
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
  } catch {}
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

async function loadPersistedProfile(fs: VirtualFS): Promise<OnboardingProfile> {
  try {
    const homes = await fs.readDir('/home');
    let best: { profile: OnboardingProfile; mtime: number } | null = null;
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
          best = { profile: parsed as OnboardingProfile, mtime };
        }
      } catch {}
    }
    return best?.profile ?? {};
  } catch {
    return {};
  }
}
