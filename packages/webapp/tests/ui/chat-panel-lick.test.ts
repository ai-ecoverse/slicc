// @vitest-environment jsdom
/**
 * Tests for ChatPanel lick rendering + SessionStore persistence path.
 *
 * Covers the bug where licks loaded from the orchestrator DB were rendered
 * as plain user bubbles because their source/channel metadata was dropped.
 * With the fix, `addLickMessage` accepts a timestamp and the DB-fallback
 * path preserves lick metadata so every channel renders as a lick widget.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ChatPanel } from '../../src/ui/chat-panel.js';
import { SessionStore } from '../../src/ui/session-store.js';

// Stub out dependencies that require browser globals unavailable under jsdom.
vi.mock('../../src/ui/voice-input.js', () => ({
  VoiceInput: class {
    destroy() {}
    start() {}
    stop() {}
    setAutoSend() {}
    setLang() {}
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

describe('ChatPanel.addLickMessage', () => {
  let container: HTMLElement;
  let panel: ChatPanel;
  let testCounter = 0;

  beforeEach(async () => {
    testCounter += 1;
    container = document.createElement('div');
    document.body.appendChild(container);
    panel = new ChatPanel(container);
    // Unique session id per test — fake-indexeddb persists state across tests
    // in the same process, so a shared id would leak history between them.
    await panel.initSession(`test-lick-add-${testCounter}`);
  });

  afterEach(() => {
    container.remove();
  });

  it('renders a webhook lick as the lick details widget, not a user bubble', () => {
    panel.addLickMessage('wh-1', '[Webhook Event: hook]\n```json\n{"a":1}\n```', 'webhook');
    const lick = container.querySelector('details.lick');
    expect(lick).not.toBeNull();
    expect(container.querySelector('.msg--user')).toBeNull();
  });

  it('renders sprinkle / navigate / fswatch / session-reload as lick widgets', () => {
    panel.addLickMessage('sp-1', 'sprinkle content', 'sprinkle');
    panel.addLickMessage('nv-1', 'navigate content', 'navigate');
    panel.addLickMessage('fw-1', 'fswatch content', 'fswatch');
    panel.addLickMessage('sr-1', 'reload content', 'session-reload');
    const licks = container.querySelectorAll('details.lick');
    expect(licks.length).toBe(4);
  });

  it('preserves history-replay timestamp ordering when licks arrive out of order', () => {
    // Simulate DB-fallback replay where history has mixed timestamps.
    panel.addLickMessage('l-3', 'third', 'webhook', 3000);
    panel.addLickMessage('l-1', 'first', 'webhook', 1000);
    panel.addLickMessage('l-2', 'second', 'webhook', 2000);
    const msgs = panel.getMessages();
    expect(msgs.map((m) => m.id)).toEqual(['l-1', 'l-2', 'l-3']);
  });

  it('ignores duplicate ids (idempotent replay)', () => {
    panel.addLickMessage('dupe', 'once', 'cron', 1000);
    panel.addLickMessage('dupe', 'twice', 'cron', 1000);
    expect(panel.getMessages()).toHaveLength(1);
  });
});

describe('ChatPanel.persistLickToSession', () => {
  let container: HTMLElement;
  let panel: ChatPanel;
  let testCounter = 0;

  beforeEach(async () => {
    testCounter += 1;
    container = document.createElement('div');
    document.body.appendChild(container);
    panel = new ChatPanel(container);
    // Init on a *different* session — we'll persist licks to another one.
    await panel.initSession(`persist-test-selected-${testCounter}`);
  });

  afterEach(() => {
    container.remove();
  });

  it('writes the lick into the target session store with source=lick and channel preserved', async () => {
    const sid = `persist-write-${testCounter}`;
    await panel.persistLickToSession(sid, {
      id: 'persisted-1',
      content: 'webhook fired',
      channel: 'webhook',
      timestamp: 5000,
    });

    const store = new SessionStore();
    await store.init();
    const session = await store.load(sid);
    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(1);
    expect(session!.messages[0]).toMatchObject({
      id: 'persisted-1',
      role: 'user',
      content: 'webhook fired',
      source: 'lick',
      channel: 'webhook',
      timestamp: 5000,
    });
  });

  it('inserts in timestamp order when appending to existing history', async () => {
    const sid = `persist-order-${testCounter}`;
    const store = new SessionStore();
    await store.init();
    await store.saveMessages(sid, [
      { id: 'old-1', role: 'user', content: 'old', timestamp: 1000 },
      { id: 'old-2', role: 'user', content: 'later', timestamp: 9000 },
    ]);

    await panel.persistLickToSession(sid, {
      id: 'mid-lick',
      content: 'in between',
      channel: 'sprinkle',
      timestamp: 5000,
    });

    const session = await store.load(sid);
    expect(session!.messages.map((m) => m.id)).toEqual(['old-1', 'mid-lick', 'old-2']);
  });

  it('is idempotent — persisting the same lick id twice is a no-op', async () => {
    const sid = `persist-dupe-${testCounter}`;
    await panel.persistLickToSession(sid, {
      id: 'once',
      content: 'a',
      channel: 'cron',
      timestamp: 2000,
    });
    await panel.persistLickToSession(sid, {
      id: 'once',
      content: 'b',
      channel: 'cron',
      timestamp: 2000,
    });

    const store = new SessionStore();
    await store.init();
    const session = await store.load(sid);
    expect(session!.messages).toHaveLength(1);
    expect(session!.messages[0].content).toBe('a');
  });
});
