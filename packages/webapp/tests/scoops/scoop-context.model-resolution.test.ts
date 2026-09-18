import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../../src/core/index.js';
import {
  estimateContextFill,
  getModelApiKey,
  missingApiKeyMessage,
  resolveScoopModel,
} from '../../src/scoops/scoop-context/model-resolution.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const selectedProvider = vi.fn(() => 'adobe');
const perProviderKey = vi.fn((provider: string) => `key-for-${provider}`);
let currentModel: unknown = { id: 'm', provider: 'adobe', contextWindow: 1000 };
const resolveCurrentModel = vi.fn(() => currentModel);

vi.mock('../../src/providers/account-store.js', () => ({
  getApiKey: () => 'selected-key',
  getApiKeyForProvider: (p: string) => perProviderKey(p),
  getSelectedProvider: () => selectedProvider(),
  modelRunsOnProvider: () => true,
  resolveCurrentModel: () => resolveCurrentModel(),
  resolveModelById: () => currentModel,
}));

function unit(overrides: Partial<RegisteredScoop> = {}): RegisteredScoop {
  return {
    jid: 'cone_1',
    name: 'Cone',
    folder: 'cone',
    parentJid: null,
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  } as RegisteredScoop;
}

function gelatiere(overrides: Partial<RegisteredScoop> = {}): RegisteredScoop {
  return unit({
    jid: 'scoop_gelatiere',
    name: 'gelatiere',
    folder: 'gelatiere',
    parentJid: 'system:gelatiere',
    ...overrides,
  });
}

function assistant(input: number, cacheRead: number, output: number): AgentMessage {
  return {
    role: 'assistant',
    content: [],
    usage: { input, cacheRead, output },
  } as unknown as AgentMessage;
}

beforeEach(() => {
  currentModel = { id: 'm', provider: 'adobe', contextWindow: 1000 };
  vi.clearAllMocks();
  selectedProvider.mockReturnValue('adobe');
  perProviderKey.mockImplementation((p: string) => `key-for-${p}`);
  resolveCurrentModel.mockClear();
});

describe('getModelApiKey', () => {
  it('uses the PINNED provider credential, not the selected one (#2195)', () => {
    expect(getModelApiKey(unit({ model: { id: 'x', provider: 'openrouter' } }))).toBe(
      'key-for-openrouter'
    );
  });

  it('falls back to the selected provider credential when nothing is pinned', () => {
    expect(getModelApiKey(unit())).toBe('selected-key');
  });

  it('never gives an unpinned Gelatiere the globally selected credential', () => {
    expect(getModelApiKey(gelatiere())).toBeNull();
  });
});

describe('resolveScoopModel', () => {
  it('never falls back to global selected-model for Gelatiere', () => {
    expect(() => resolveScoopModel(gelatiere())).toThrow('no leading-cone model');
    expect(resolveCurrentModel).not.toHaveBeenCalled();
  });
});

describe('estimateContextFill', () => {
  it('is 0 before the first assistant turn', () => {
    expect(estimateContextFill([], unit())).toBe(0);
    expect(
      estimateContextFill([{ role: 'user', content: 'hi' } as unknown as AgentMessage], unit())
    ).toBe(0);
  });

  it('reads the LAST assistant usage and counts input + cacheRead + output', () => {
    const messages = [assistant(100, 0, 0), assistant(200, 100, 50)];
    expect(estimateContextFill(messages, unit())).toBeCloseTo(0.35);
  });

  it('skips assistant messages that reported no usage', () => {
    const noUsage = { role: 'assistant', content: [] } as unknown as AgentMessage;
    const messages = [assistant(100, 0, 100), noUsage];
    expect(estimateContextFill(messages, unit())).toBeCloseTo(0.2);
  });

  it('clamps at 1 when the reported usage overshoots the window', () => {
    expect(estimateContextFill([assistant(5000, 0, 0)], unit())).toBe(1);
  });

  it('falls back to the default window when model resolution throws', () => {
    currentModel = null;
    expect(estimateContextFill([assistant(100_000, 0, 0)], unit())).toBeCloseTo(0.5);
  });
});

describe('missingApiKeyMessage', () => {
  it('names the pinned provider', () => {
    expect(missingApiKeyMessage(unit({ model: { id: 'x', provider: 'openrouter' } }))).toContain(
      'provider "openrouter"'
    );
  });

  it('falls back to the selected provider', () => {
    selectedProvider.mockReturnValue('anthropic');
    expect(missingApiKeyMessage(unit())).toContain('provider "anthropic"');
  });

  it('stays generic when the provider cannot be determined', () => {
    selectedProvider.mockImplementation(() => {
      throw new Error('no localStorage');
    });
    expect(missingApiKeyMessage(unit())).toBe('No API key configured. Open Settings to add one.');
  });

  it('explains a missing leading-cone model for Gelatiere without naming global selection', () => {
    expect(missingApiKeyMessage(gelatiere())).toBe(
      'The gelatiere cannot run until the leading cone has a model.'
    );
    expect(selectedProvider).not.toHaveBeenCalled();
  });
});
