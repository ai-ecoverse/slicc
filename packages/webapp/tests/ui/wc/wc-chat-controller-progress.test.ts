// @vitest-environment jsdom
/**
 * Bash progress overlay rendering: `tool_progress` events attach a compact
 * bar (label / percentage / ETA) to the in-flight tool row, indeterminate
 * units get a spinner track, `end` removes the unit, the bar survives a
 * row rebuild, and `tool_result` clears everything for that call.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

vi.mock('../../../src/kernel/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/kernel/telemetry.js')>(
    '../../../src/kernel/telemetry.js'
  );
  return { ...actual, trackChatSend: vi.fn() };
});

import type { ToolProgressEvent } from '@slicc/shared-ts';
import type { AgentEvent, AgentHandle } from '../../../src/ui/types.js';
import { WcChatController } from '../../../src/ui/wc/wc-chat-controller.js';
import { formatEta } from '../../../src/ui/wc/wc-message-view.js';

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

function progress(partial: Partial<ToolProgressEvent> = {}): ToolProgressEvent {
  return { id: 'sleep-1', label: 'sleep 30', phase: 'update', ...partial };
}

describe('WcChatController tool_progress handling', () => {
  let thread: HTMLElement;
  let agent: FakeAgent;
  let controller: WcChatController;

  beforeEach(() => {
    document.body.replaceChildren();
    thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    agent = new FakeAgent();
    controller = new WcChatController({ thread, agent });
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({
      type: 'tool_use_start',
      messageId: 'm1',
      toolName: 'bash',
      toolInput: { command: 'sleep 30' },
    });
  });

  const block = () => thread.querySelector<HTMLElement>('slicc-action-row .wcmsg-progress');

  it('renders label, percentage and ETA for a determinate unit', () => {
    agent.emit({
      type: 'tool_progress',
      messageId: 'm1',
      toolName: 'bash',
      progress: progress({ fraction: 0.5, etaMs: 15_000 }),
    });
    const el = block();
    expect(el).not.toBeNull();
    expect(el?.querySelector('.wcmsg-progress__label')?.textContent).toBe('sleep 30');
    expect(el?.querySelector('.wcmsg-progress__pct')?.textContent).toBe('50%');
    expect(el?.querySelector('.wcmsg-progress__eta')?.textContent).toBe('~15s');
    const fill = el?.querySelector<HTMLElement>('.wcmsg-progress__fill');
    expect(fill?.style.width).toBe('50%');
    expect(fill?.classList.contains('wcmsg-progress__fill--indeterminate')).toBe(false);
    expect(el?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
  });

  it('renders an indeterminate spinner when fraction is undefined', () => {
    agent.emit({
      type: 'tool_progress',
      messageId: 'm1',
      toolName: 'bash',
      progress: progress({ id: 'cmd-1', label: 'git fetch', phase: 'start' }),
    });
    const el = block();
    expect(el?.querySelector('.wcmsg-progress__pct')?.textContent).toBe('');
    expect(el?.querySelector('.wcmsg-progress__eta')?.textContent).toBe('');
    expect(
      el
        ?.querySelector('.wcmsg-progress__fill')
        ?.classList.contains('wcmsg-progress__fill--indeterminate')
    ).toBe(true);
    expect(el?.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
  });

  it('tracks several units and removes each on end', () => {
    const emit = (p: ToolProgressEvent) =>
      agent.emit({ type: 'tool_progress', messageId: 'm1', toolName: 'bash', progress: p });
    emit(progress({ id: 'a', label: 'a', phase: 'start' }));
    emit(progress({ id: 'b', label: 'b', phase: 'start' }));
    expect(block()?.querySelectorAll('.wcmsg-progress__unit')).toHaveLength(2);
    emit(progress({ id: 'a', label: 'a', phase: 'end' }));
    expect(block()?.querySelectorAll('.wcmsg-progress__unit')).toHaveLength(1);
    expect(block()?.querySelector('[data-progress-id="b"]')).not.toBeNull();
    emit(progress({ id: 'b', label: 'b', phase: 'end' }));
    expect(block()).toBeNull();
  });

  it('keeps the bar across a message rerender and clears it on tool_result', () => {
    agent.emit({
      type: 'tool_progress',
      messageId: 'm1',
      toolName: 'bash',
      progress: progress({ fraction: 0.25, etaMs: 22_500 }),
    });
    // A second tool starting rebuilds the message's rows.
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'read_file', toolInput: {} });
    const rows = thread.querySelectorAll('slicc-action-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.wcmsg-progress__pct')?.textContent).toBe('25%');
    expect(rows[1].querySelector('.wcmsg-progress')).toBeNull();

    agent.emit({ type: 'tool_result', messageId: 'm1', toolName: 'bash', result: 'done' });
    expect(thread.querySelector('.wcmsg-progress')).toBeNull();
  });

  it('ignores progress for an unknown message or a tool with no in-flight call', () => {
    agent.emit({
      type: 'tool_progress',
      messageId: 'nope',
      toolName: 'bash',
      progress: progress(),
    });
    agent.emit({
      type: 'tool_progress',
      messageId: 'm1',
      toolName: 'curl_tool',
      progress: progress(),
    });
    expect(thread.querySelector('.wcmsg-progress')).toBeNull();
  });

  it('drops tracked progress on dispose', () => {
    agent.emit({ type: 'tool_progress', messageId: 'm1', toolName: 'bash', progress: progress() });
    expect(block()).not.toBeNull();
    controller.dispose();
  });
});

describe('formatEta', () => {
  it('formats seconds, minutes and hours coarsely', () => {
    expect(formatEta(0)).toBe('0s');
    expect(formatEta(14_600)).toBe('15s');
    expect(formatEta(65_000)).toBe('1m05s');
    expect(formatEta(3_720_000)).toBe('1h02m');
  });
});
