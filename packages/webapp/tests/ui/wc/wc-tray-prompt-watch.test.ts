// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

// `buildFollowerOptions` touches the composer chrome, which pulls the component
// library into this module graph.
installWcDomStubs();

import {
  FOLLOWER_PROMPT_SILENCE_MS,
  PROMPT_SILENCE_NOTE,
} from '../../../src/ui/wc/follower-prompt-watch.js';
import { buildFollowerOptions } from '../../../src/ui/wc/wc-tray.js';

/**
 * The prompt-silence hint on the tray ROLE-SWITCH follower — a leader-capable
 * float that joined another leader via `slicc:tray-join`. Same rule as the
 * dedicated follower mount (`wc-follower.test.ts`): a sent prompt that gets no
 * reaction at all for 30 s earns one note, in the addressed unit's thread.
 */
function mountRole() {
  const controller = {
    loadMessages: vi.fn(),
    setProcessing: vi.fn(),
    addUserMessage: vi.fn(),
    addAssistantMessage: vi.fn(),
    setAgent: vi.fn(),
    processing: false,
  };
  const sync = {
    selectScoop: vi.fn(),
    selectModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    sendMessage: vi.fn(() => true),
    stop: vi.fn(),
    requestModels: vi.fn(),
  };
  const role = buildFollowerOptions(
    {
      refs: {
        composerMeta: document.createElement('div'),
        composer: document.createElement('div'),
        inputCard: document.createElement('div'),
        switcher: document.createElement('div'),
        dock: document.createElement('div'),
        overlaySurfaces: new Set(),
      },
      browser: {},
      client: { sendSetFollowerForwarding: vi.fn() },
      window: { localStorage: { getItem: vi.fn(() => null) } },
      getController: () => controller,
      addSprinkle: vi.fn(),
      removeSprinkle: vi.fn(),
      agentHandle: { sendMessage: vi.fn(), onEvent: () => () => undefined, stop: vi.fn() },
      restoreLocalChrome: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never,
    'https://tray.example/join/token',
    () => sync as never
  );
  let emit: () => void = () => undefined;
  role.options.setChatAgent?.({
    sendMessage: vi.fn(),
    stop: vi.fn(),
    onEvent: (listener: () => void) => {
      emit = listener;
      return () => undefined;
    },
  } as never);
  role.options.onSnapshot?.([], 'cone_1');
  const handle = controller.setAgent.mock.calls.at(-1)?.[0] as {
    sendMessage(text: string, messageId?: string): void;
  };
  const notes = () =>
    controller.addAssistantMessage.mock.calls.filter(([text]) => text === PROMPT_SILENCE_NOTE);
  return { role, handle, emit: () => emit(), notes };
}

describe('tray role-switch follower: prompt silence hint', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('notes a prompt the leader never reacts to', async () => {
    const { handle, notes } = mountRole();
    handle.sendMessage('anyone there?', 'm1');
    await vi.advanceTimersByTimeAsync(FOLLOWER_PROMPT_SILENCE_MS);
    expect(notes()).toHaveLength(1);
  });

  it('stays quiet once the leader reacts (agent event or status frame)', async () => {
    const first = mountRole();
    first.handle.sendMessage('hello', 'm1');
    first.emit();
    await vi.advanceTimersByTimeAsync(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(first.notes()).toHaveLength(0);

    const second = mountRole();
    second.handle.sendMessage('hello', 'm2');
    second.role.options.onStatus?.('processing', 'cone_1');
    await vi.advanceTimersByTimeAsync(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(second.notes()).toHaveLength(0);
  });

  it('drops the note while another unit is shown, rather than misplacing it', async () => {
    const { role, handle, notes } = mountRole();
    handle.sendMessage('for cone 1', 'm1');
    // The view moves on: a roster that no longer carries cone_1 re-selects.
    role.options.onScoopsList?.(
      [{ jid: 'cone_2', name: 'other', isCone: true, parentId: null }] as never,
      'cone_2'
    );
    await vi.advanceTimersByTimeAsync(FOLLOWER_PROMPT_SILENCE_MS);
    expect(notes()).toHaveLength(0);
  });

  it('leaving the role cancels a pending note', async () => {
    const { role, handle, notes } = mountRole();
    handle.sendMessage('bye', 'm1');
    role.dispose();
    await vi.advanceTimersByTimeAsync(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(notes()).toHaveLength(0);
  });
});
