// @vitest-environment jsdom
/**
 * Regression: commit d222f1385 deleted the legacy `tool-ui-renderer.ts`
 * but `WcChatController.#handleAgentEvent` was never updated to handle
 * the `tool_ui` / `tool_ui_done` events. Agent-driven approval cards
 * (mount, USB/serial/HID pickers) were silently dropped at the `default`
 * branch, so `backend-local.ts` waited out its 5-minute timeout with no
 * dialog visible. These tests pin the restored path: the synthetic
 * `tool_ui` event mounts a dip in the thread, the dip's lick forwards
 * through `onToolUiAction`, and `tool_ui_done` disposes the dip.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

vi.mock('../../../src/ui/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/ui/telemetry.js')>(
    '../../../src/ui/telemetry.js'
  );
  return { ...actual, trackChatSend: vi.fn() };
});

// Stub `mountDip` so the controller test never spins up a real srcdoc
// iframe (jsdom doesn't execute its scripts anyway). The stub captures
// the onLick handler so tests can simulate a dip-side click directly,
// mirroring the patterns in tests/ui/dip.test.ts where dispose tracking
// matters more than the iframe internals.
const dipMocks: {
  mount: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  lastOnLick: ((action: string, data: unknown) => void) | null;
} = {
  mount: vi.fn(),
  dispose: vi.fn(),
  lastOnLick: null,
};

vi.mock('../../../src/ui/dip.js', () => ({
  mountDip: (
    container: HTMLElement,
    html: string,
    onLick: (action: string, data: unknown) => void,
    trusted?: boolean
  ) => {
    dipMocks.mount(container, html, trusted);
    dipMocks.lastOnLick = onLick;
    return { dispose: () => dipMocks.dispose() };
  },
}));

import { TOOL_UI_MOUNTED_ACTION } from '../../../src/tools/tool-ui.js';
import type { AgentEvent, AgentHandle } from '../../../src/ui/types.js';
import { WcChatController } from '../../../src/ui/wc/wc-chat-controller.js';

class FakeAgent implements AgentHandle {
  listeners = new Set<(event: AgentEvent) => void>();
  sendMessage(): void {}
  onEvent(callback: (event: AgentEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  stop(): void {}
  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

describe('WcChatController tool_ui handling', () => {
  let thread: HTMLElement;
  let agent: FakeAgent;
  let actions: Array<{ requestId: string; action: string; data: unknown }>;
  let controller: WcChatController;

  beforeEach(() => {
    document.body.replaceChildren();
    thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    agent = new FakeAgent();
    actions = [];
    dipMocks.mount.mockClear();
    dipMocks.dispose.mockClear();
    dipMocks.lastOnLick = null;
    controller = new WcChatController({
      thread,
      agent,
      onToolUiAction: (requestId, action, data) => {
        actions.push({ requestId, action, data });
      },
    });
  });

  it('mounts a dip under the thread and acks the mount on tool_ui', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'mount',
      requestId: 'tool-ui-1',
      html: '<button data-action="approve">Approve</button>',
    });

    // Dip mounted exactly once, in a thread-anchored container (not
    // inside the streaming message bubble — content_delta rerenders
    // would wipe an in-bubble card).
    expect(dipMocks.mount).toHaveBeenCalledTimes(1);
    const [container, html, trusted] = dipMocks.mount.mock.calls[0];
    expect(html).toContain('data-action="approve"');
    expect(trusted).toBe(false);
    expect((container as HTMLElement).getAttribute('data-tool-ui-request')).toBe('tool-ui-1');
    expect((container as HTMLElement).className).toBe('msg__dip');
    // Mount ack fires immediately so the worker-side mount backend can
    // exit its fast-fail wait without surfacing a "no panel" error.
    expect(actions[0]).toEqual({
      requestId: 'tool-ui-1',
      action: TOOL_UI_MOUNTED_ACTION,
      data: undefined,
    });
  });

  it('forwards dip licks to onToolUiAction with the originating requestId', () => {
    agent.emit({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'mount',
      requestId: 'tool-ui-7',
      html: '<button data-action="deny">Deny</button>',
    });
    actions.length = 0; // ignore the mount ack
    dipMocks.lastOnLick?.('deny', { reason: 'no thanks' });
    expect(actions).toEqual([
      { requestId: 'tool-ui-7', action: 'deny', data: { reason: 'no thanks' } },
    ]);
  });

  it('disposes the dip on tool_ui_done and removes its container', () => {
    agent.emit({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'mount',
      requestId: 'tool-ui-2',
      html: '<p>card</p>',
    });
    const container = thread.querySelector('[data-tool-ui-request="tool-ui-2"]');
    expect(container).not.toBeNull();

    agent.emit({ type: 'tool_ui_done', messageId: 'm1', requestId: 'tool-ui-2' });
    expect(dipMocks.dispose).toHaveBeenCalledTimes(1);
    expect(thread.querySelector('[data-tool-ui-request="tool-ui-2"]')).toBeNull();
  });

  it('replaces the dip on a re-entrant tool_ui for the same requestId', () => {
    agent.emit({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'mount',
      requestId: 'tool-ui-3',
      html: '<p>v1</p>',
    });
    agent.emit({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'mount',
      requestId: 'tool-ui-3',
      html: '<p>v2</p>',
    });
    // Two mounts; the first dip's dispose ran before the second mount.
    expect(dipMocks.mount).toHaveBeenCalledTimes(2);
    expect(dipMocks.dispose).toHaveBeenCalledTimes(1);
    expect(thread.querySelectorAll('[data-tool-ui-request="tool-ui-3"]').length).toBe(1);
  });

  it('disposes all live tool_ui dips on loadMessages', () => {
    agent.emit({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'mount',
      requestId: 'tool-ui-4',
      html: '<p>card</p>',
    });
    controller.loadMessages([]);
    expect(dipMocks.dispose).toHaveBeenCalledTimes(1);
    expect(thread.querySelector('[data-tool-ui-request="tool-ui-4"]')).toBeNull();
  });

  it('disposes all live tool_ui dips on dispose', () => {
    agent.emit({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'mount',
      requestId: 'tool-ui-5',
      html: '<p>card</p>',
    });
    controller.dispose();
    expect(dipMocks.dispose).toHaveBeenCalledTimes(1);
  });
});
