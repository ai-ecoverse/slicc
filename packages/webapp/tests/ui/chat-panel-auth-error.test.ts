// @vitest-environment jsdom
/**
 * Tests for the inline "Log in again" affordance that renders under an
 * auth-error bubble. The happy path: an `{type:'error', error, authAction}`
 * event from the agent produces a message with `authAction` metadata,
 * the rendered DOM exposes a clickable link, and the metadata survives
 * persistence so the link re-renders on session reload.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ChatPanel } from '../../src/ui/chat-panel.js';
import { SessionStore } from '../../src/ui/session-store.js';
import type { AgentEvent, AgentHandle } from '../../src/ui/types.js';

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

/** Minimal AgentHandle stub that lets tests fire synthetic events. */
function makeAgent(): { handle: AgentHandle; emit: (ev: AgentEvent) => void } {
  const listeners: Array<(ev: AgentEvent) => void> = [];
  return {
    handle: {
      sendMessage: () => {},
      onEvent: (cb) => {
        listeners.push(cb);
        return () => {
          const i = listeners.indexOf(cb);
          if (i !== -1) listeners.splice(i, 1);
        };
      },
      stop: () => {},
    },
    emit: (ev) => {
      for (const l of listeners) l(ev);
    },
  };
}

describe('ChatPanel auth-error rendering', () => {
  let container: HTMLElement;
  let panel: ChatPanel;
  let counter = 0;

  beforeEach(async () => {
    counter += 1;
    container = document.createElement('div');
    document.body.appendChild(container);
    panel = new ChatPanel(container);
    await panel.initSession(`auth-err-${counter}`);
  });

  afterEach(() => {
    container.remove();
  });

  it('renders a "Log in again" link for an error event carrying authAction', () => {
    const { handle, emit } = makeAgent();
    panel.setAgent(handle);
    emit({
      type: 'error',
      error: 'Adobe session expired — please log in again',
      authAction: { providerId: 'adobe', actionHint: 'reauth' },
    });

    const row = container.querySelector('.msg__auth-action');
    expect(row).not.toBeNull();
    const link = row!.querySelector('.msg__auth-action-link') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe('Log in again');
    expect(link!.getAttribute('data-provider-id')).toBe('adobe');
    expect(link!.getAttribute('data-action')).toBe('reauth');
  });

  it('does NOT render the auth-action row for a plain error event', () => {
    const { handle, emit } = makeAgent();
    panel.setAgent(handle);
    emit({ type: 'error', error: 'Something went wrong' });

    expect(container.querySelector('.msg__auth-action')).toBeNull();
  });

  it('stashes the auth error as a fresh assistant message (not appended to a streaming bubble)', () => {
    const { handle, emit } = makeAgent();
    panel.setAgent(handle);
    // Start a streaming assistant message first — an auth error in the
    // middle of a response should NOT be appended to it, otherwise the
    // authAction metadata would be lost and the re-login link would not
    // re-render on reload.
    emit({ type: 'message_start', messageId: 'm1' });
    emit({ type: 'content_delta', messageId: 'm1', text: 'thinking…' });
    emit({
      type: 'error',
      error: 'Adobe session expired — please log in again',
      authAction: { providerId: 'adobe', actionHint: 'reauth' },
    });

    const msgs = panel.getMessages();
    // The streaming bubble stays, and the auth error is its own entry.
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    const last = msgs[msgs.length - 1];
    expect(last.authAction).toEqual({ providerId: 'adobe', actionHint: 'reauth' });
    expect(last.content).toContain('Adobe session expired');
  });

  it('persists authAction to the session store and re-renders the link on reload', async () => {
    const { handle, emit } = makeAgent();
    panel.setAgent(handle);
    emit({
      type: 'error',
      error: 'Adobe session expired — please log in again',
      authAction: { providerId: 'adobe', actionHint: 'reauth' },
    });
    // Give the async persistSession chain a tick to flush.
    await new Promise((r) => setTimeout(r, 10));

    const store = new SessionStore();
    await store.init();
    const session = await store.load(`auth-err-${counter}`);
    expect(session).not.toBeNull();
    const saved = session!.messages.find((m) => m.authAction);
    expect(saved).toBeDefined();
    expect(saved!.authAction).toEqual({ providerId: 'adobe', actionHint: 'reauth' });

    // Simulate a reload by creating a fresh panel on the same session id.
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    const reloaded = new ChatPanel(container);
    await reloaded.initSession(`auth-err-${counter}`);

    const link = container.querySelector('.msg__auth-action-link') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute('data-provider-id')).toBe('adobe');
  });
});
