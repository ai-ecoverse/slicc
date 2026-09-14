// @vitest-environment jsdom

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
import { formatBytes, formatEta } from '../../../src/ui/wc/wc-message-view.js';

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
  return { id: 'script-1', label: 'sleep 30', phase: 'update', ...partial };
}

describe('WcChatController tool_progress handling', () => {
  let thread: HTMLElement;
  let agent: FakeAgent;
  let controller: WcChatController;
  let ring: Array<number | null>;

  beforeEach(() => {
    document.body.replaceChildren();
    thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    agent = new FakeAgent();
    ring = [];
    controller = new WcChatController({ thread, agent, onToolProgressChange: (f) => ring.push(f) });
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({
      type: 'tool_use_start',
      messageId: 'm1',
      toolName: 'bash',
      toolInput: { command: 'sleep 30' },
      toolCallId: 'tc-1',
    });
  });

  const row = () => thread.querySelector<HTMLElement>('slicc-action-row');
  const dots = () => row()?.querySelectorAll<HTMLElement>('.wcmsg-dots__dot') ?? [];
  const emit = (p: ToolProgressEvent) =>
    agent.emit({ type: 'tool_progress', messageId: 'm1', toolName: 'bash', progress: p });

  it('sets the determinate treatment: custom property, dots by thirds, title', () => {
    emit(progress({ fraction: 0.5, etaMs: 15_000, done: 3, total: 6, unit: 'iterations' }));
    const r = row();
    expect(r?.getAttribute('data-progress')).toBe('determinate');
    expect(r?.style.getPropertyValue('--slicc-progress')).toBe('0.5');
    expect(r?.getAttribute('title')).toBe('3/6 · sleep 30 — 50%, ~15s left');
    const d = dots();
    expect(d).toHaveLength(3);
    expect([...d].map((x) => x.classList.contains('is-done'))).toEqual([true, false, false]);
    expect([...d].map((x) => x.classList.contains('is-active'))).toEqual([false, true, false]);
    expect(r?.querySelector('.wcmsg-dots')?.getAttribute('aria-valuenow')).toBe('50');

    const head = r?.querySelector('.slicc-act__head');
    expect(head?.lastElementChild?.classList.contains('slicc-act__chev')).toBe(true);
    expect(ring).toEqual([0.5]);
  });

  it('marks the last dot active near the end and all done at 100%', () => {
    emit(progress({ fraction: 0.9 }));
    expect([...dots()].map((x) => x.classList.contains('is-active'))).toEqual([false, false, true]);
    emit(progress({ fraction: 1 }));
    expect([...dots()].map((x) => x.classList.contains('is-done'))).toEqual([true, true, true]);
    expect([...dots()].some((x) => x.classList.contains('is-active'))).toBe(false);
  });

  it('renders the indeterminate treatment without a fraction', () => {
    emit(progress({ id: 'script-2', label: 'git fetch', phase: 'start', fraction: undefined }));
    const r = row();
    expect(r?.getAttribute('data-progress')).toBe('indeterminate');
    expect(r?.querySelector('.wcmsg-dots')?.classList.contains('wcmsg-dots--indeterminate')).toBe(
      true
    );
    expect(r?.querySelector('.wcmsg-dots')?.hasAttribute('aria-valuenow')).toBe(false);
    expect(ring).toEqual([]);
  });

  it('clears on end and on tool_result, and resets the ring', () => {
    emit(progress({ fraction: 0.25 }));
    emit(progress({ fraction: 1, phase: 'end' }));
    expect(row()?.hasAttribute('data-progress')).toBe(false);
    expect(dots()).toHaveLength(0);
    expect(ring).toEqual([0.25, null]);

    emit(progress({ fraction: 0.4 }));
    agent.emit({ type: 'tool_result', messageId: 'm1', toolName: 'bash', result: 'done' });
    expect(thread.querySelector('[data-progress]')).toBeNull();
    expect(ring.at(-1)).toBeNull();
  });

  it('keeps the treatment across a message rerender', () => {
    emit(progress({ fraction: 0.25, etaMs: 22_500 }));
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'read_file', toolInput: {} });
    const rows = thread.querySelectorAll<HTMLElement>('slicc-action-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-progress')).toBe('determinate');
    expect(rows[0].querySelectorAll('.wcmsg-dots__dot')).toHaveLength(3);
    expect(rows[1].hasAttribute('data-progress')).toBe(false);
  });

  it('averages several in-flight determinate calls for the ring', () => {
    emit(progress({ fraction: 0.2 }));
    agent.emit({
      type: 'tool_use_start',
      messageId: 'm1',
      toolName: 'bash',
      toolInput: { command: 'ls' },
    });
    emit(progress({ id: 'script-9', fraction: 0.6 }));
    expect(ring.at(-1)).toBeCloseTo(0.4);
  });

  it('fills the cluster head with dots as calls complete (k of N), with no icon fill', () => {
    for (const id of ['c2', 'c3']) {
      agent.emit({
        type: 'tool_use_start',
        messageId: 'm1',
        toolName: 'bash',
        toolInput: { command: `echo ${id}` },
        toolCallId: id,
      });
    }
    const cluster = () => thread.querySelector<HTMLElement>('slicc-tool-cluster');
    expect(cluster()?.querySelectorAll('slicc-action-row[data-tool-id]')).toHaveLength(3);

    agent.emit({
      type: 'tool_progress',
      messageId: 'm1',
      toolName: 'bash',
      progress: progress({ fraction: 0.6 }),
      toolCallId: 'c2',
    });
    const head = cluster()?.querySelector('.slicc-cluster__head');
    expect(cluster()?.getAttribute('data-progress')).toBe('determinate');
    expect(head?.querySelectorAll('.wcmsg-dots__dot')).toHaveLength(3);
    expect(cluster()?.style.getPropertyValue('--slicc-progress')).toBe('');
    expect(cluster()?.getAttribute('title')).toContain('0 of 3 done');

    expect(cluster()?.querySelector('.slicc-cluster__count')?.textContent).toContain('3');

    agent.emit({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: 'ok',
      toolCallId: 'c2',
    });
    expect(cluster()?.style.getPropertyValue('--slicc-progress')).toBe('');
    expect(cluster()?.getAttribute('title')).toContain('1 of 3 done');
    const activeAfter = [...(head?.querySelectorAll('.wcmsg-dots__dot') ?? [])].findIndex((d) =>
      d.classList.contains('is-active')
    );
    expect(activeAfter).toBe(0);

    const css = document.getElementById('slicc-wcmsg-style')?.textContent ?? '';
    expect(css).toContain('slicc-action-row[data-progress] .slicc-act__body::before');
    expect(css).not.toContain('slicc-tool-cluster[data-progress] .slicc-cluster__ic');
    expect(css).not.toContain('slicc-tool-cluster[data-progress] .slicc-cluster__body::before');

    for (const id of ['c3', 'tc-1']) {
      agent.emit({
        type: 'tool_result',
        messageId: 'm1',
        toolName: 'bash',
        result: 'ok',
        toolCallId: id,
      });
    }
    expect(cluster()?.hasAttribute('data-progress')).toBe(false);
    expect(cluster()?.querySelector('.slicc-cluster__head .wcmsg-dots')).toBeNull();
  });

  it('pairs results with the right row when same-named calls run concurrently', () => {
    for (const id of ['c2', 'c3']) {
      agent.emit({
        type: 'tool_use_start',
        messageId: 'm1',
        toolName: 'bash',
        toolInput: { command: `echo ${id}` },
        toolCallId: id,
      });
    }

    agent.emit({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: 'output-for-c2',
      toolCallId: 'c2',
    });

    const byId = (id: string) =>
      thread.querySelector<HTMLElement>(`slicc-action-row[data-tool-id="m1:${id}"]`);
    expect(byId('c2')?.getAttribute('result')).toBe('done');
    expect(byId('c3')?.getAttribute('result')).toBe('…');
    expect(byId('tc-1')?.getAttribute('result')).toBe('…');
    expect(byId('c2')?.textContent).toContain('output-for-c2');
    expect(byId('c3')?.textContent ?? '').not.toContain('output-for-c2');
  });

  it('scopes a reused provider call id per message (no cross-message bleed)', () => {
    agent.emit({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: 'ok',
      toolCallId: 'tc-1',
    });
    agent.emit({ type: 'message_start', messageId: 'm2' });
    agent.emit({
      type: 'tool_use_start',
      messageId: 'm2',
      toolName: 'bash',
      toolInput: { command: 'sleep 5' },
      toolCallId: 'tc-1',
    });

    const ids = [...thread.querySelectorAll<HTMLElement>('slicc-action-row[data-tool-id]')].map(
      (r) => r.dataset.toolId
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('m1:tc-1');
    expect(ids).toContain('m2:tc-1');

    agent.emit({
      type: 'tool_progress',
      messageId: 'm2',
      toolName: 'bash',
      progress: progress({ fraction: 0.5 }),
      toolCallId: 'tc-1',
    });
    const row = (id: string) =>
      thread.querySelector<HTMLElement>(`slicc-action-row[data-tool-id="${id}"]`);
    expect(row('m2:tc-1')?.getAttribute('data-progress')).toBe('determinate');
    expect(row('m1:tc-1')?.hasAttribute('data-progress')).toBe(false);
  });

  it('does not mark a restored, never-started cluster as running', () => {
    controller.loadMessages([
      {
        id: 'restored',
        role: 'assistant',
        content: 'earlier turn',
        timestamp: Date.now(),
        toolCalls: [
          { id: 'old-1', name: 'bash', input: { command: 'a' } },
          { id: 'old-2', name: 'bash', input: { command: 'b' } },
          { id: 'old-3', name: 'bash', input: { command: 'c' } },
        ],
      },
    ]);
    const cluster = thread.querySelector<HTMLElement>('slicc-tool-cluster');
    expect(cluster).not.toBeNull();
    expect(cluster?.querySelectorAll('slicc-action-row')).toHaveLength(3);

    expect(cluster?.hasAttribute('data-progress')).toBe(false);
    expect(cluster?.querySelector('.slicc-cluster__head .wcmsg-dots')).toBeNull();
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
    expect(thread.querySelector('[data-progress]')).toBeNull();
  });

  it('drops tracked progress on dispose', () => {
    emit(progress({ fraction: 0.3 }));
    expect(ring).toEqual([0.3]);
    controller.dispose();
    expect(ring).toEqual([0.3, null]);
  });
});

describe('format helpers', () => {
  it('formats ETAs and byte counts coarsely', () => {
    expect(formatEta(14_600)).toBe('15s');
    expect(formatEta(65_000)).toBe('1m05s');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_234_567)).toBe('1.2 MB');
  });
});
