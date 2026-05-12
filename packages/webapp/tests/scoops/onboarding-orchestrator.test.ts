import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/index.js';
import {
  OnboardingOrchestrator,
  type ProviderCatalogue,
} from '../../src/scoops/onboarding-orchestrator.js';
import { __test__ as messageTest } from '../../src/scoops/onboarding-messages.js';

type AccountSnapshot = {
  id: string;
  key: string;
  baseUrl?: string;
  deployment?: string;
  apiVersion?: string;
};

type DipMessage = Record<string, unknown> & { type: string };

type FinalLickPayload = Record<string, unknown> & { action: string };

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
    {
      id: 'azure-openai',
      name: 'Azure OpenAI',
      description: 'GPT models via Azure AI Foundry',
      requiresApiKey: true,
      requiresBaseUrl: true,
      requiresDeployment: true,
      requiresApiVersion: true,
      defaultBaseUrl: 'https://your-resource.cognitiveservices.azure.com/',
      apiVersionDefault: '2024-08-01-preview',
    },
  ],
  models: {
    openai: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    anthropic: [{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }],
    'azure-openai': [{ id: 'gpt-4o', name: 'GPT-4o' }],
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
  const dipInbox: DipMessage[] = [];
  const finalLicks: FinalLickPayload[] = [];
  const accounts: AccountSnapshot[] = [];
  const selectedModels: string[] = [];
  const orchestrator = new OnboardingOrchestrator({
    fs,
    postSystemMessage: (line) => systemMessages.push(line),
    postDipReference: (md) => dipRefs.push(md),
    getProviderCatalogue: () => baseCatalogue,
    saveAccount: (id, key, baseUrl, deployment, apiVersion) =>
      accounts.push({ id, key, baseUrl, deployment, apiVersion }),
    setSelectedModel: (id) => selectedModels.push(id),
    resolveModelLabel: (_p, m) => m.toUpperCase(),
    broadcastToDip: (msg) => dipInbox.push(msg),
    fireFinalLick: (data) => finalLicks.push(data),
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

    it('also responds when the orchestrator is idle (reload after ledger suppressed onboarding-complete)', () => {
      // The connect-llm dip re-mounts from chat history on reload
      // and emits `connect-ready` again. The persistent welcome-
      // flow ledger may have already swallowed `onboarding-complete`
      // so the orchestrator stays at `idle`. The catalogue must
      // still flow through, otherwise the dip is stuck on
      // "Loading providers…" forever.
      const h = makeHarness();
      h.orchestrator.handleConnectReady();
      expect(h.dipInbox).toEqual([
        {
          type: 'slicc-providers',
          providers: baseCatalogue.providers,
          models: baseCatalogue.models,
        },
      ]);
    });

    it('ignores ready events after onboarding has fully completed', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({});
      await h.orchestrator.handleConnectAttempt({
        provider: 'openai',
        apiKey: 'sk-good',
        baseUrl: null,
        model: 'gpt-4o',
      });
      expect(h.orchestrator.getStage()).toBe('complete');
      h.dipInbox.length = 0;
      h.orchestrator.handleConnectReady();
      expect(h.dipInbox).toEqual([]);
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
      expect(h.accounts).toEqual([
        {
          id: 'openai',
          key: 'sk-good',
          baseUrl: undefined,
          deployment: undefined,
          apiVersion: undefined,
        },
      ]);
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
      const accounts: AccountSnapshot[] = [];
      const finalLicks: FinalLickPayload[] = [];
      const dipInbox: DipMessage[] = [];
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
      const accounts: AccountSnapshot[] = [];
      const finalLicks: FinalLickPayload[] = [];
      const dipInbox: DipMessage[] = [];
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
      const finalLicks: FinalLickPayload[] = [];
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

    it('forwards deployment + apiVersion to saveAccount for Azure-style providers', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({});
      await h.orchestrator.handleConnectAttempt({
        provider: 'azure-openai',
        apiKey: 'azure-key',
        baseUrl: 'https://example.cognitiveservices.azure.com/',
        deployment: 'gpt4o-eastus',
        apiVersion: '2024-08-01-preview',
        model: null,
      });
      expect(h.accounts).toEqual([
        {
          id: 'azure-openai',
          key: 'azure-key',
          baseUrl: 'https://example.cognitiveservices.azure.com/',
          deployment: 'gpt4o-eastus',
          apiVersion: '2024-08-01-preview',
        },
      ]);
      expect(h.finalLicks).toHaveLength(1);
      expect(h.finalLicks[0].data.provider).toBe('azure-openai');
    });

    it('rejects when a requiresDeployment provider is missing the deployment field', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({});
      await h.orchestrator.handleConnectAttempt({
        provider: 'azure-openai',
        apiKey: 'azure-key',
        baseUrl: 'https://example.cognitiveservices.azure.com/',
        deployment: null,
        apiVersion: '2024-08-01-preview',
      });
      expect(h.accounts).toEqual([]);
      expect(h.finalLicks).toEqual([]);
      const reject = h.dipInbox.find((m) => m.type === 'slicc-connect-result');
      expect(reject.ok).toBe(false);
      expect(reject.message).toContain('deployment');
      expect(h.orchestrator.getStage()).toBe('awaiting-connect');
    });

    it('rejects when a requiresBaseUrl provider is missing the base URL', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({});
      await h.orchestrator.handleConnectAttempt({
        provider: 'azure-openai',
        apiKey: 'azure-key',
        baseUrl: null,
        deployment: 'gpt4o-eastus',
      });
      expect(h.accounts).toEqual([]);
      const reject = h.dipInbox.find((m) => m.type === 'slicc-connect-result');
      expect(reject.ok).toBe(false);
      expect(reject.message.toLowerCase()).toContain('base url');
    });

    it('rejects empty payloads gracefully', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({});
      await h.orchestrator.handleConnectAttempt({
        provider: '',
        apiKey: '',
      });
      expect(h.accounts).toEqual([]);
      const reject = h.dipInbox.find((m) => m.type === 'slicc-connect-result');
      expect(reject.ok).toBe(false);
    });
  });

  describe('handleOAuthAttempt', () => {
    it('sets the model and fires the final lick on successful OAuth with a model', async () => {
      const fs = new VirtualFS('oauth-ok-' + Math.random());
      const selectedModels: string[] = [];
      const finalLicks: FinalLickPayload[] = [];
      const dipInbox: DipMessage[] = [];
      const launchOAuth = vi.fn(async () => ({ ok: true, model: 'adobe:claude-sonnet-4-6' }));
      const orch = new OnboardingOrchestrator({
        fs,
        postSystemMessage: () => {},
        postDipReference: () => {},
        getProviderCatalogue: () => baseCatalogue,
        saveAccount: () => {},
        setSelectedModel: (id) => selectedModels.push(id),
        resolveModelLabel: (_p, m) => m.toUpperCase(),
        broadcastToDip: (msg) => dipInbox.push(msg),
        fireFinalLick: (data) => finalLicks.push(data),
        fetchImpl: fakeFetch(() => new Response('{}', { status: 200 })),
        rand: () => 0,
        launchOAuth,
      });
      await orch.handleOnboardingComplete({});
      await orch.handleOAuthAttempt({ provider: 'adobe' });
      expect(launchOAuth).toHaveBeenCalledWith('adobe', null);
      expect(selectedModels).toEqual(['adobe:claude-sonnet-4-6']);
      expect(finalLicks).toHaveLength(1);
      expect(finalLicks[0].action).toBe('onboarding-complete-with-provider');
      expect(finalLicks[0].data.provider).toBe('adobe');
      expect(finalLicks[0].data.model).toBe('adobe:claude-sonnet-4-6');
      expect(finalLicks[0].data.validation).toBe('oauth');
      expect(orch.getStage()).toBe('complete');
    });

    it('fires the final lick but does not call setSelectedModel when OAuth returns no model', async () => {
      const fs = new VirtualFS('oauth-nomodel-' + Math.random());
      const selectedModels: string[] = [];
      const finalLicks: FinalLickPayload[] = [];
      const dipInbox: DipMessage[] = [];
      const orch = new OnboardingOrchestrator({
        fs,
        postSystemMessage: () => {},
        postDipReference: () => {},
        getProviderCatalogue: () => baseCatalogue,
        saveAccount: () => {},
        setSelectedModel: (id) => selectedModels.push(id),
        broadcastToDip: (msg) => dipInbox.push(msg),
        fireFinalLick: (data) => finalLicks.push(data),
        fetchImpl: fakeFetch(() => new Response('{}', { status: 200 })),
        rand: () => 0,
        launchOAuth: async () => ({ ok: true, model: null }),
      });
      await orch.handleOnboardingComplete({});
      await orch.handleOAuthAttempt({ provider: 'adobe' });
      expect(selectedModels).toEqual([]);
      expect(finalLicks).toHaveLength(1);
      expect(finalLicks[0].data.model).toBeNull();
      const okMsg = dipInbox.find((m) => m.type === 'slicc-connect-result' && m.ok);
      expect(okMsg).toBeTruthy();
    });

    it('broadcasts an error and keeps stage at awaiting-connect when OAuth fails', async () => {
      const fs = new VirtualFS('oauth-fail-' + Math.random());
      const finalLicks: FinalLickPayload[] = [];
      const dipInbox: DipMessage[] = [];
      const orch = new OnboardingOrchestrator({
        fs,
        postSystemMessage: () => {},
        postDipReference: () => {},
        getProviderCatalogue: () => baseCatalogue,
        saveAccount: () => {},
        setSelectedModel: () => {},
        broadcastToDip: (msg) => dipInbox.push(msg),
        fireFinalLick: (data) => finalLicks.push(data),
        fetchImpl: fakeFetch(() => new Response('{}', { status: 200 })),
        rand: () => 0,
        launchOAuth: async () => ({ ok: false, message: 'Login cancelled.' }),
      });
      await orch.handleOnboardingComplete({});
      await orch.handleOAuthAttempt({ provider: 'adobe' });
      expect(finalLicks).toEqual([]);
      const reject = dipInbox.find((m) => m.type === 'slicc-connect-result');
      expect(reject.ok).toBe(false);
      expect(reject.kind).toBe('failed');
      expect(orch.getStage()).toBe('awaiting-connect');
    });

    it('broadcasts an error and keeps stage at awaiting-connect when launchOAuth throws', async () => {
      const fs = new VirtualFS('oauth-throw-' + Math.random());
      const finalLicks: FinalLickPayload[] = [];
      const dipInbox: DipMessage[] = [];
      const orch = new OnboardingOrchestrator({
        fs,
        postSystemMessage: () => {},
        postDipReference: () => {},
        getProviderCatalogue: () => baseCatalogue,
        saveAccount: () => {},
        setSelectedModel: () => {},
        broadcastToDip: (msg) => dipInbox.push(msg),
        fireFinalLick: (data) => finalLicks.push(data),
        fetchImpl: fakeFetch(() => new Response('{}', { status: 200 })),
        rand: () => 0,
        launchOAuth: async () => {
          throw new Error('popup closed');
        },
      });
      await orch.handleOnboardingComplete({});
      await orch.handleOAuthAttempt({ provider: 'adobe' });
      expect(finalLicks).toEqual([]);
      const reject = dipInbox.find((m) => m.type === 'slicc-connect-result');
      expect(reject.ok).toBe(false);
      expect(reject.message).toContain('popup closed');
      expect(orch.getStage()).toBe('awaiting-connect');
    });

    it('is a no-op when launchOAuth is not provided by the runtime', async () => {
      const fs = new VirtualFS('oauth-noop-' + Math.random());
      const finalLicks: FinalLickPayload[] = [];
      const dipInbox: DipMessage[] = [];
      const orch = new OnboardingOrchestrator({
        fs,
        postSystemMessage: () => {},
        postDipReference: () => {},
        getProviderCatalogue: () => baseCatalogue,
        saveAccount: () => {},
        setSelectedModel: () => {},
        broadcastToDip: (msg) => dipInbox.push(msg),
        fireFinalLick: (data) => finalLicks.push(data),
        fetchImpl: fakeFetch(() => new Response('{}', { status: 200 })),
        rand: () => 0,
        // launchOAuth intentionally omitted
      });
      await orch.handleOnboardingComplete({});
      await orch.handleOAuthAttempt({ provider: 'adobe' });
      expect(finalLicks).toEqual([]);
      const reject = dipInbox.find((m) => m.type === 'slicc-connect-result');
      expect(reject.ok).toBe(false);
      expect(reject.message).toContain('not available');
    });

    it('ignores OAuth attempt when stage is already complete', async () => {
      const h = makeHarness();
      await h.orchestrator.handleOnboardingComplete({});
      await h.orchestrator.handleConnectAttempt({
        provider: 'openai',
        apiKey: 'sk-good',
        model: 'gpt-4o',
      });
      expect(h.orchestrator.getStage()).toBe('complete');
      h.finalLicks.length = 0;
      h.dipInbox.length = 0;
      await h.orchestrator.handleOAuthAttempt({ provider: 'adobe' });
      expect(h.finalLicks).toEqual([]);
      expect(h.dipInbox).toEqual([]);
    });
  });
});
