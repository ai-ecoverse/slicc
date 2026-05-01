import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/index.js';
import {
  OnboardingOrchestrator,
  type ProviderCatalogue,
} from '../../src/scoops/onboarding-orchestrator.js';
import { __test__ as messageTest } from '../../src/scoops/onboarding-messages.js';

function fakeFetch(impl: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    return await impl(String(input));
  }) as unknown as typeof fetch;
}

const baseCatalogue: ProviderCatalogue = {
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      description: 'GPT-4 and friends',
      requiresApiKey: true,
      requiresBaseUrl: false,
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      description: 'Claude 4',
      requiresApiKey: true,
      requiresBaseUrl: false,
    },
  ],
  models: {
    openai: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    anthropic: [{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }],
  },
};

function makeHarness(
  overrides: Partial<
    Parameters<(typeof OnboardingOrchestrator)['prototype']['handleOnboardingComplete']>[0]
  > = {}
) {
  void overrides;
  const fs = new VirtualFS('test-' + Math.random());
  const systemMessages: string[] = [];
  const dipRefs: string[] = [];
  const dipInbox: any[] = [];
  const finalLicks: any[] = [];
  const accounts: any[] = [];
  const selectedModels: string[] = [];
  const skillInstallCalls: Array<{ at: number; profile: unknown }> = [];
  const orchestrator = new OnboardingOrchestrator({
    fs,
    postSystemMessage: (line) => systemMessages.push(line),
    postDipReference: (md) => dipRefs.push(md),
    getProviderCatalogue: () => baseCatalogue,
    saveAccount: (id, key, baseUrl) => accounts.push({ id, key, baseUrl }),
    setSelectedModel: (id) => selectedModels.push(id),
    resolveModelLabel: (_p, m) => m.toUpperCase(),
    broadcastToDip: (msg) => dipInbox.push(msg),
    fireFinalLick: (data) => finalLicks.push(data),
    installRecommendedSkills: async (profile) => {
      skillInstallCalls.push({ at: Date.now(), profile });
    },
    fetchImpl: fakeFetch(() => new Response('{}', { status: 200 })),
    rand: () => 0,
  });
  return {
    orchestrator,
    fs,
    systemMessages,
    dipRefs,
    dipInbox,
    finalLicks,
    accounts,
    selectedModels,
    skillInstallCalls,
  };
}

describe('OnboardingOrchestrator', () => {
  beforeEach(() => {
    // Each test gets a fresh in-memory IDB via fake-indexeddb/auto.
  });

  describe('handleOnboardingComplete', () => {
    it('posts three deterministic system messages followed by the connect-llm dip', async () => {
      const h = makeHarness();
      const handled = await h.orchestrator.handleOnboardingComplete({
        name: 'Paolo',
        purpose: 'work',
        role: 'developer',
      });
      expect(handled).toBe(true);
      expect(h.systemMessages).toHaveLength(3);
      expect(h.systemMessages[0]).toContain('Paolo');
      expect(h.systemMessages[1].startsWith("I'm sliccy.")).toBe(true);
      expect(h.systemMessages[2]).toBe(messageTest.CONFESSIONS[0]);
      expect(h.dipRefs).toHaveLength(1);
      expect(h.dipRefs[0]).toContain('/shared/sprinkles/welcome/connect-llm.shtml');
    });

    it('writes the welcomed marker AND the user profile JSON', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({
        name: 'Lars',
        purpose: 'school',
        tasks: ['research'],
      });
      // Allow the persistence promises to settle. Two concurrent
      // writes (recordWelcomed + persistProfile) on a fresh
      // LightningFS instance can take longer than a single tick under
      // load — poll for up to 500ms before failing.
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && !(await h.fs.exists('/shared/.welcomed'))) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(await h.fs.exists('/shared/.welcomed')).toBe(true);
      expect(await h.fs.exists('/home/lars/.welcome.json')).toBe(true);
      const raw = await h.fs.readFile('/home/lars/.welcome.json', 'utf8');
      const json = JSON.parse(raw as string);
      expect(json.name).toBe('Lars');
      expect(json.tasks).toEqual(['research']);
    });

    it('falls back to /home/user when the user skipped the name', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({});
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && !(await h.fs.exists('/home/user/.welcome.json'))) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(await h.fs.exists('/home/user/.welcome.json')).toBe(true);
    });

    it('kicks off the recommended-skills installer with the in-memory profile', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({ name: 'Kim', role: 'developer' });
      await new Promise((r) => setTimeout(r, 5));
      expect(h.skillInstallCalls).toHaveLength(1);
      // Profile is passed by reference so the installer doesn't have to wait
      // for the parallel persistProfile write to land on disk.
      expect(h.skillInstallCalls[0].profile).toMatchObject({ name: 'Kim', role: 'developer' });
    });

    it('silently no-ops when no skill installer was wired', async () => {
      const fs = new VirtualFS('no-installer-' + Math.random());
      const finalLicks: any[] = [];
      const orch = new OnboardingOrchestrator({
        fs,
        postSystemMessage: () => {},
        postDipReference: () => {},
        getProviderCatalogue: () => baseCatalogue,
        saveAccount: () => {},
        setSelectedModel: () => {},
        broadcastToDip: () => {},
        fireFinalLick: (data) => finalLicks.push(data),
        // installRecommendedSkills omitted on purpose.
        rand: () => 0,
      });
      const handled = await orch.handleOnboardingComplete({ name: 'NoInstaller' });
      expect(handled).toBe(true);
      // No throw, orchestrator still advances to awaiting-connect.
      expect(orch.getStage()).toBe('awaiting-connect');
    });

    it('is idempotent for duplicate complete events in the same session', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({ name: 'A' });
      await h.orchestrator.handleOnboardingComplete({ name: 'B' });
      // Still only one set of intro messages and one dip reference.
      expect(h.systemMessages).toHaveLength(3);
      expect(h.dipRefs).toHaveLength(1);
      expect(h.systemMessages[0]).toContain('A');
    });
  });

  describe('handleConnectReady', () => {
    it('responds to ready by broadcasting the provider catalogue to the dip', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({});
      h.dipInbox.length = 0;
      h.orchestrator.handleConnectReady();
      expect(h.dipInbox).toEqual([
        {
          type: 'slicc-providers',
          providers: baseCatalogue.providers,
          models: baseCatalogue.models,
        },
      ]);
    });

    it('ignores stray ready events when the orchestrator is idle', () => {
      const h = makeHarness();
      h.orchestrator.handleConnectReady();
      expect(h.dipInbox).toHaveLength(0);
    });
  });

  describe('handleConnectAttempt', () => {
    it('saves the account, selects the model, and fires the final cone lick on a successful probe', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({ name: 'Mira', role: 'developer' });
      await h.orchestrator.handleConnectAttempt({
        provider: 'openai',
        apiKey: 'sk-good',
        baseUrl: null,
        model: 'gpt-4o',
      });
      expect(h.accounts).toEqual([{ id: 'openai', key: 'sk-good', baseUrl: undefined }]);
      expect(h.selectedModels).toEqual(['gpt-4o']);
      expect(h.finalLicks).toHaveLength(1);
      expect(h.finalLicks[0].action).toBe('onboarding-complete-with-provider');
      expect(h.finalLicks[0].data.provider).toBe('openai');
      expect(h.finalLicks[0].data.model).toBe('gpt-4o');
      expect(h.finalLicks[0].data.modelLabel).toBe('GPT-4O');
      expect(h.dipInbox.some((m) => m.type === 'slicc-connect-result' && m.ok)).toBe(true);
    });

    it('rejects when the validator says the key is bad — does NOT save or fire the cone lick', async () => {
      const fetchImpl = fakeFetch(() => new Response('{"error":"bad"}', { status: 401 }));
      const fs = new VirtualFS('reject-' + Math.random());
      const accounts: any[] = [];
      const finalLicks: any[] = [];
      const dipInbox: any[] = [];
      const orch = new OnboardingOrchestrator({
        fs,
        postSystemMessage: () => {},
        postDipReference: () => {},
        getProviderCatalogue: () => baseCatalogue,
        saveAccount: (id, key) => accounts.push({ id, key }),
        setSelectedModel: () => {},
        broadcastToDip: (msg) => dipInbox.push(msg),
        fireFinalLick: (data) => finalLicks.push(data),
        fetchImpl,
        rand: () => 0,
      });
      await orch.handleOnboardingComplete({ name: 'Z' });
      await orch.handleConnectAttempt({ provider: 'openai', apiKey: 'bad', model: null });
      expect(accounts).toEqual([]);
      expect(finalLicks).toEqual([]);
      const reject = dipInbox.find((m) => m.type === 'slicc-connect-result');
      expect(reject.ok).toBe(false);
      expect(reject.kind).toBe('failed');
      // Still in awaiting-connect so the user can retry.
      expect(orch.getStage()).toBe('awaiting-connect');
    });

    it('treats a "skipped" validator result as success but flags the note', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch;
      const fs = new VirtualFS('skipped-' + Math.random());
      const accounts: any[] = [];
      const finalLicks: any[] = [];
      const dipInbox: any[] = [];
      const orch = new OnboardingOrchestrator({
        fs,
        postSystemMessage: () => {},
        postDipReference: () => {},
        getProviderCatalogue: () => baseCatalogue,
        saveAccount: (id, key) => accounts.push({ id, key }),
        setSelectedModel: () => {},
        broadcastToDip: (msg) => dipInbox.push(msg),
        fireFinalLick: (data) => finalLicks.push(data),
        fetchImpl,
        rand: () => 0,
      });
      await orch.handleOnboardingComplete({});
      await orch.handleConnectAttempt({ provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' });
      expect(accounts).toHaveLength(1);
      expect(finalLicks).toHaveLength(1);
      const ok = dipInbox.find((m) => m.type === 'slicc-connect-result' && m.ok);
      expect(ok.kind).toBe('skipped');
      expect(ok.note.toLowerCase()).toContain('saved');
      expect(orch.getStage()).toBe('complete');
    });

    it('falls back to the first catalogue model when the dip omits one', async () => {
      // Mirrors the new welcome-dip path: dip no longer picks a
      // model, so the orchestrator must pick a sensible default
      // matching the just-saved provider. Without this fallback a
      // stale `selected-model` from a previously-removed provider
      // would survive onboarding and break chat requests.
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({});
      await h.orchestrator.handleConnectAttempt({
        provider: 'anthropic',
        apiKey: 'sk-good',
        baseUrl: null,
        model: null,
      });
      expect(h.selectedModels).toEqual(['claude-opus-4-6']);
      expect(h.finalLicks).toHaveLength(1);
      expect(h.finalLicks[0].data.model).toBe('claude-opus-4-6');
      expect(h.finalLicks[0].data.modelLabel).toBe('CLAUDE-OPUS-4-6');
    });

    it('leaves the selected model untouched when the catalogue has no models for the provider', async () => {
      const fs = new VirtualFS('no-models-' + Math.random());
      const selectedModels: string[] = [];
      const finalLicks: any[] = [];
      const orch = new OnboardingOrchestrator({
        fs,
        postSystemMessage: () => {},
        postDipReference: () => {},
        getProviderCatalogue: () => ({
          providers: baseCatalogue.providers,
          models: { openai: [], anthropic: [] },
        }),
        saveAccount: () => {},
        setSelectedModel: (id) => selectedModels.push(id),
        broadcastToDip: () => {},
        fireFinalLick: (data) => finalLicks.push(data),
        fetchImpl: fakeFetch(() => new Response('{}', { status: 200 })),
        rand: () => 0,
      });
      await orch.handleOnboardingComplete({});
      await orch.handleConnectAttempt({
        provider: 'openai',
        apiKey: 'sk-good',
        model: null,
      });
      expect(selectedModels).toEqual([]);
      expect(finalLicks[0].data.model).toBeNull();
    });

    it('rejects empty payloads gracefully', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({});
      await h.orchestrator.handleConnectAttempt({
        provider: '',
        apiKey: '',
      } as any);
      expect(h.accounts).toEqual([]);
      const reject = h.dipInbox.find((m) => m.type === 'slicc-connect-result');
      expect(reject.ok).toBe(false);
    });
  });
});
