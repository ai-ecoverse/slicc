// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ChatPanel } from '../../src/ui/chat-panel.js';

vi.mock('../../src/ui/voice-input.js', () => ({
  VoiceInput: class {
    destroy() {}
    start() {}
    stop() {}
    setAutoSend() {}
    setLang() {}
    isListening() {
      return false;
    }
  },
  getVoiceAutoSend: () => false,
  getVoiceLang: () => 'en-US',
}));

const groupsRef: { value: Array<Record<string, unknown>> } = { value: [] };
vi.mock('../../src/ui/provider-settings.js', () => ({
  getApiKey: () => '',
  showProviderSettings: () => {},
  applyProviderDefaults: () => {},
  getAllAvailableModels: () => groupsRef.value,
  getSelectedModelId: () => 'claude-sonnet',
  getSelectedProvider: () => 'anthropic',
  setSelectedModelId: () => {},
  getProviderConfig: () => null,
}));

describe('ChatPanel model selector — multi-provider provider labels', () => {
  let container: HTMLElement;
  let panel: ChatPanel;
  let testCounter = 0;

  beforeEach(async () => {
    testCounter += 1;
    const store: Record<string, string> = { 'selected-model': 'anthropic:claude-sonnet' };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    panel = new ChatPanel(container);
    await panel.initSession(`test-model-selector-${testCounter}`);
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
    groupsRef.value = [];
  });

  it('omits the provider label when only one provider is configured', () => {
    groupsRef.value = [
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        models: [
          { id: 'claude-sonnet', name: 'Claude Sonnet' },
          { id: 'claude-opus', name: 'Claude Opus' },
        ],
      },
    ];
    panel.refreshModelSelector();

    expect(container.querySelector('.chat__model-btn-provider')).toBeNull();
    expect(container.querySelector('.chat__model-menu-provider')).toBeNull();
    const btn = container.querySelector('.chat__model-btn--compact');
    expect(btn?.textContent).toContain('Claude Sonnet');
    expect(btn?.textContent).not.toContain('Anthropic');
  });

  it('shows the provider label on the trigger and every menu item when multiple providers are configured', () => {
    groupsRef.value = [
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        models: [{ id: 'claude-sonnet', name: 'Claude Sonnet' }],
      },
      {
        providerId: 'bedrock',
        providerName: 'AWS Bedrock',
        models: [{ id: 'claude-sonnet', name: 'Claude Sonnet' }],
      },
    ];
    panel.refreshModelSelector();

    const btnProvider = container.querySelector('.chat__model-btn-provider');
    expect(btnProvider).not.toBeNull();
    expect(btnProvider?.textContent).toBe('Anthropic');

    // Open the menu so menu items render.
    (container.querySelector('.chat__model-btn--compact') as HTMLButtonElement).click();

    const menuProviders = container.querySelectorAll('.chat__model-menu-provider');
    expect(menuProviders).toHaveLength(2);
    const labels = Array.from(menuProviders).map((el) => el.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Anthropic', 'AWS Bedrock']));
  });
});
