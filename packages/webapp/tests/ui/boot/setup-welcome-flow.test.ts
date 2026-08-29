/**
 * Pins the welcome-flow lick interceptor's named body types so the
 * boy-scout `Record<string, unknown>` cleanup stays behaviour-preserving.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LickEvent } from '../../../src/scoops/lick-manager.js';
import {
  createWelcomeLickInterceptor,
  DEDUPED_WELCOME_ACTIONS,
  dispatchWelcomeLickOnce,
  loadFiredWelcomeActions,
  persistFiredWelcomeActions,
  type WelcomeLickInterceptorDeps,
} from '../../../src/ui/boot/setup-welcome-flow.js';

vi.mock('../../../src/scoops/welcome-detection.js', () => ({
  hasOnboardingFinalLickInHistory: vi.fn(async () => true),
}));

const LEDGER_KEY = 'slicc:welcome-flow-fired';

function makeFakeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}

function welcomeLick(action: string, data?: unknown): LickEvent {
  return {
    type: 'sprinkle',
    sprinkleName: 'welcome',
    timestamp: new Date().toISOString(),
    body: data === undefined ? { action } : { action, data },
  };
}

function makeDeps(overrides: Partial<WelcomeLickInterceptorDeps> = {}): WelcomeLickInterceptorDeps {
  const orch = {
    handleFirstRun: vi.fn(),
    handleOnboardingComplete: vi.fn(async () => true),
    handleConnectReady: vi.fn(),
    handleConnectAttempt: vi.fn(async () => true),
    handleOAuthAttempt: vi.fn(async () => true),
  };
  return {
    firedWelcomeActions: new Set(),
    getAccounts: () => [],
    getProviderConfig: () => null,
    resolveDeviceCodeDecision: vi.fn(),
    getOnboardingOrchestrator: () => orch,
    fastForward: {
      fire: vi.fn(),
      broadcastAlreadyConnected: vi.fn(),
    },
    onShortcutMigrate: vi.fn(),
    contextLabel: 'test',
    vfs: null,
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

describe('dispatchWelcomeLickOnce', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeFakeStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires once for a deduped action and suppresses the duplicate', () => {
    const set = new Set<string>();
    const fire = vi.fn();
    const log = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };

    dispatchWelcomeLickOnce('first-run', set, fire, 'test', log);
    dispatchWelcomeLickOnce('first-run', set, fire, 'test', log);

    expect(fire).toHaveBeenCalledTimes(1);
    expect(set.has('first-run')).toBe(true);
    expect(DEDUPED_WELCOME_ACTIONS.has('first-run')).toBe(true);
    expect(log.debug).toHaveBeenCalledOnce();
  });

  it('round-trips the persistent ledger through localStorage', () => {
    const set = new Set(['onboarding-complete']);
    persistFiredWelcomeActions(set);
    expect(localStorage.getItem(LEDGER_KEY)).toBe(JSON.stringify(['onboarding-complete']));
    expect([...loadFiredWelcomeActions()]).toEqual(['onboarding-complete']);
  });
});

describe('createWelcomeLickInterceptor', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeFakeStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ignores non-sprinkle and non-welcome-flow licks', () => {
    const deps = makeDeps();
    const intercept = createWelcomeLickInterceptor(deps);

    expect(
      intercept({
        type: 'cron',
        timestamp: new Date().toISOString(),
        body: { action: 'first-run' },
      })
    ).toBe(false);
    expect(
      intercept({
        type: 'sprinkle',
        sprinkleName: 'other',
        timestamp: new Date().toISOString(),
        body: { action: 'first-run' },
      })
    ).toBe(false);
    expect(intercept(welcomeLick('not-a-welcome-action'))).toBe(false);
  });

  it('routes first-run to the orchestrator and dedupes a second fire', () => {
    const deps = makeDeps();
    const intercept = createWelcomeLickInterceptor(deps);
    const orch = deps.getOnboardingOrchestrator();

    expect(intercept(welcomeLick('first-run'))).toBe(true);
    expect(orch.handleFirstRun).toHaveBeenCalledOnce();
    expect(intercept(welcomeLick('first-run'))).toBe(true);
    expect(orch.handleFirstRun).toHaveBeenCalledOnce();
  });

  it('passes onboarding-complete profile data and mounts when requested', async () => {
    const applyPendingMount = vi.fn(async () => {});
    const deps = makeDeps({ applyPendingMount });
    const intercept = createWelcomeLickInterceptor(deps);
    const orch = deps.getOnboardingOrchestrator();

    expect(
      intercept(
        welcomeLick('onboarding-complete', {
          name: 'Ada',
          mountWorkspace: true,
        })
      )
    ).toBe(true);

    expect(orch.handleOnboardingComplete).toHaveBeenCalledWith({
      name: 'Ada',
      mountWorkspace: true,
    });
    expect(applyPendingMount).toHaveBeenCalledOnce();
    await Promise.resolve();
  });

  it('forwards connect-attempt and oauth-attempt fields to the orchestrator', async () => {
    const deps = makeDeps();
    const intercept = createWelcomeLickInterceptor(deps);
    const orch = deps.getOnboardingOrchestrator();

    expect(
      intercept(
        welcomeLick('connect-attempt', {
          provider: 'anthropic',
          apiKey: 'sk-test',
          baseUrl: 'https://example.test',
          deployment: 'dep',
          apiVersion: '2024-01-01',
          model: 'claude-opus-4-6',
        })
      )
    ).toBe(true);
    expect(
      intercept(
        welcomeLick('oauth-attempt', {
          provider: 'openai',
          baseUrl: '',
        })
      )
    ).toBe(true);

    await Promise.resolve();
    expect(orch.handleConnectAttempt).toHaveBeenCalledWith({
      provider: 'anthropic',
      apiKey: 'sk-test',
      baseUrl: 'https://example.test',
      deployment: 'dep',
      apiVersion: '2024-01-01',
      model: 'claude-opus-4-6',
    });
    expect(orch.handleOAuthAttempt).toHaveBeenCalledWith({
      provider: 'openai',
      baseUrl: null,
    });
  });

  it('resolves device-code decisions and runs shortcut-migrate', () => {
    const deps = makeDeps();
    const intercept = createWelcomeLickInterceptor(deps);

    expect(intercept(welcomeLick('device-code-decision', { decision: 'cancel' }))).toBe(true);
    expect(deps.resolveDeviceCodeDecision).toHaveBeenCalledWith('cancel');

    expect(intercept(welcomeLick('device-code-decision', { decision: 'go' }))).toBe(true);
    expect(deps.resolveDeviceCodeDecision).toHaveBeenCalledWith('continue');

    expect(intercept(welcomeLick('shortcut-migrate'))).toBe(true);
    expect(deps.onShortcutMigrate).toHaveBeenCalledOnce();
  });

  it('calls handleConnectReady when no accounts are stored', () => {
    const deps = makeDeps({ getAccounts: () => [] });
    const intercept = createWelcomeLickInterceptor(deps);
    const orch = deps.getOnboardingOrchestrator();

    expect(intercept(welcomeLick('connect-ready'))).toBe(true);
    expect(orch.handleConnectReady).toHaveBeenCalledOnce();
    expect(deps.fastForward.broadcastAlreadyConnected).not.toHaveBeenCalled();
  });

  it('fast-forwards when an account already exists', async () => {
    const deps = makeDeps({
      getAccounts: () => [{ providerId: 'anthropic' }],
    });
    const intercept = createWelcomeLickInterceptor(deps);
    const orch = deps.getOnboardingOrchestrator();

    expect(intercept(welcomeLick('connect-ready'))).toBe(true);
    expect(orch.handleConnectReady).not.toHaveBeenCalled();
    expect(deps.fastForward.broadcastAlreadyConnected).toHaveBeenCalledWith('anthropic');
    // hasOnboardingFinalLickInHistory is mocked true → fire() is skipped
    await vi.waitFor(() => {
      expect(deps.fastForward.fire).not.toHaveBeenCalled();
    });
  });
});
