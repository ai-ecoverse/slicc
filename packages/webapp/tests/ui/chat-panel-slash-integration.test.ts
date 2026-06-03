// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ChatPanel } from '../../src/ui/chat-panel.js';
import { createSkillsMenuCommand } from '../../src/ui/slash-commands/skills-menu.js';
import {
  createSlashCommandRegistry,
  type SlashCommandActions,
} from '../../src/ui/slash-commands.js';

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

vi.mock('../../src/ui/provider-settings.js', () => ({
  getApiKey: () => '',
  showProviderSettings: () => {},
  applyProviderDefaults: () => {},
  getAllAvailableModels: () => [],
  getSelectedModelId: () => '',
  getSelectedProvider: () => null,
  setSelectedModelId: () => {},
  getProviderConfig: () => null,
}));

vi.mock('../../src/ui/telemetry.js', () => ({
  trackChatSend: () => {},
  trackImageView: () => {},
}));

vi.mock('../../src/ui/quick-llm.js', () => ({
  quickLabel: async () => null,
}));

function makeActions(): SlashCommandActions {
  return {
    newSession: vi.fn(async () => {}),
    freezeSession: vi.fn(async () => {}),
    clearChat: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    openMemory: vi.fn(async () => {}),
    openFrozenSessions: vi.fn(async () => {}),
  };
}

const testRegistry = createSlashCommandRegistry([
  {
    kind: 'action',
    name: 'new',
    description: 'New session.',
    run: async (ctx) => {
      await ctx.actions.newSession();
    },
  },
  {
    kind: 'action',
    name: 'help',
    description: 'Show help.',
    run: async (ctx) => {
      ctx.chat.addSystemMessage('help output');
    },
  },
  createSkillsMenuCommand(),
  {
    kind: 'skill',
    name: 'sprinkles',
    description: 'Reference the sprinkles skill',
  },
]);

describe('ChatPanel slash command integration', () => {
  let container: HTMLElement;
  let actions: SlashCommandActions;
  let testCounter = 0;

  beforeEach(() => {
    testCounter += 1;
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    actions = makeActions();
    const store: Record<string, string> = { 'selected-model': 'claude-sonnet' };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function makePanel(): ChatPanel {
    return new ChatPanel(container, {
      slashCommandActions: actions,
      slashCommandRegistry: testRegistry,
      isCone: () => true,
    });
  }

  it('typing "/" shows the picker with action+submenu entries only (no skills)', async () => {
    const panel = makePanel();
    await panel.initSession(`slash-test-${testCounter}`);
    const textarea = container.querySelector('textarea')!;
    textarea.value = '/';
    textarea.dispatchEvent(new Event('input'));
    await Promise.resolve();
    const picker = document.querySelector('.slash-picker') as HTMLElement | null;
    expect(picker).not.toBeNull();
    expect(picker!.style.display).not.toBe('none');
    // Should NOT list 'sprinkles' at top level
    const items = document.querySelectorAll('.slash-picker__item');
    const names = Array.from(items).map((el) => el.textContent);
    expect(names.some((n) => n?.includes('sprinkles'))).toBe(false);
    panel.dispose();
  });

  it('typing "/he" filters the picker to /help', async () => {
    const panel = makePanel();
    await panel.initSession(`slash-test-${testCounter}`);
    const textarea = container.querySelector('textarea')!;
    textarea.value = '/he';
    textarea.dispatchEvent(new Event('input'));
    await Promise.resolve();
    const items = document.querySelectorAll('.slash-picker__item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('help');
    panel.dispose();
  });

  it('Enter on picker invokes the action command', async () => {
    const panel = makePanel();
    await panel.initSession(`slash-test-${testCounter}`);
    const textarea = container.querySelector('textarea')! as HTMLTextAreaElement;
    textarea.value = '/new';
    textarea.dispatchEvent(new Event('input'));
    await Promise.resolve();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.newSession).toHaveBeenCalled();
    panel.dispose();
  });

  it('selecting /skills drills into submenu and picker shows skills', async () => {
    const panel = makePanel();
    await panel.initSession(`slash-test-${testCounter}`);
    const textarea = container.querySelector('textarea')! as HTMLTextAreaElement;
    textarea.value = '/skills';
    textarea.dispatchEvent(new Event('input'));
    await Promise.resolve();
    // Picker shows /skills entry; accept it
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    // Textarea now has '/skills ' and picker shows skills list
    expect(textarea.value).toBe('/skills ');
    const items = document.querySelectorAll('.slash-picker__item');
    const names = Array.from(items).map((el) => el.textContent);
    expect(names.some((n) => n?.includes('sprinkles'))).toBe(true);
    panel.dispose();
  });

  it('from /skills state, selecting a skill inserts "/name " and fires no action', async () => {
    const panel = makePanel();
    await panel.initSession(`slash-test-${testCounter}`);
    const textarea = container.querySelector('textarea')! as HTMLTextAreaElement;
    textarea.value = '/skills ';
    // Simulate cursor at end (position 8)
    Object.defineProperty(textarea, 'selectionStart', { value: 8, configurable: true });
    textarea.dispatchEvent(new Event('input'));
    await Promise.resolve();
    // Accept the sprinkles entry from the submenu
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(textarea.value).toContain('/sprinkles ');
    expect(actions.newSession).not.toHaveBeenCalled();
    expect(actions.openSettings).not.toHaveBeenCalled();
    panel.dispose();
  });

  it('typing a skill-specific prefix surfaces the skill directly (no /skills detour)', async () => {
    const panel = makePanel();
    await panel.initSession(`slash-test-${testCounter}`);
    const textarea = container.querySelector('textarea')! as HTMLTextAreaElement;
    textarea.value = '/spr';
    Object.defineProperty(textarea, 'selectionStart', { value: 4, configurable: true });
    textarea.dispatchEvent(new Event('input'));
    await Promise.resolve();
    const items = document.querySelectorAll('.slash-picker__item');
    const names = Array.from(items).map((el) => el.textContent);
    expect(names.some((n) => n?.includes('sprinkles'))).toBe(true);
    // Accept it → inserts the inline reference, fires no action.
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(textarea.value).toContain('/sprinkles ');
    expect(actions.newSession).not.toHaveBeenCalled();
    panel.dispose();
  });

  it('mid-text action: selecting action strips the token from the text', async () => {
    const panel = makePanel();
    await panel.initSession(`slash-test-${testCounter}`);
    const textarea = container.querySelector('textarea')! as HTMLTextAreaElement;
    textarea.value = 'do this /new';
    Object.defineProperty(textarea, 'selectionStart', { value: 12, configurable: true });
    textarea.dispatchEvent(new Event('input'));
    await Promise.resolve();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.newSession).toHaveBeenCalled();
    expect(textarea.value).not.toContain('/new');
    panel.dispose();
  });

  it('Escape dismisses the picker without clearing the textarea', async () => {
    const panel = makePanel();
    await panel.initSession(`slash-test-${testCounter}`);
    const textarea = container.querySelector('textarea')! as HTMLTextAreaElement;
    textarea.value = '/';
    textarea.dispatchEvent(new Event('input'));
    await Promise.resolve();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
    const picker = document.querySelector('.slash-picker') as HTMLElement | null;
    expect(picker!.style.display).toBe('none');
    expect(textarea.value).toBe('/');
    panel.dispose();
  });

  it('does not break normal Enter send when no slash command', async () => {
    const panel = makePanel();
    await panel.initSession(`slash-test-${testCounter}`);
    const sendMessage = vi.fn();
    const { default: agentHandle } = {
      default: {
        sendMessage,
        onEvent: (_cb: (e: unknown) => void) => () => {},
        stop: () => {},
      },
    };
    panel.setAgent(agentHandle);
    const textarea = container.querySelector('textarea')! as HTMLTextAreaElement;
    textarea.value = 'hello world';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith('hello world', expect.any(String), expect.any(Array));
    panel.dispose();
  });
});
