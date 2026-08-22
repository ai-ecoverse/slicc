// @vitest-environment jsdom
/**
 * Bash progress overlay rendering: `tool_progress` events dress the in-flight
 * tool row with three quiet cues (icon fill via `--slicc-progress`, a
 * three-dot badge, the body top bar via `data-progress`), survive a row
 * rebuild, clear on `end`/`tool_result`, and feed the composer ring through
 * `onToolProgressChange`.
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
    // Dots replace the "…" badge, before the chevron.
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
    expect(ring).toEqual([]); // unknown → ring stays indeterminate (no change from null)
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
    // beforeEach already started one bash call; two more collapse into a cluster.
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

    // Nothing finished yet, one call reporting 0.6 → (0 + 0.6) / 3.
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
    // The cluster keeps its "3 steps" count alongside the dots.
    expect(cluster()?.querySelector('.slicc-cluster__count')?.textContent).toContain('3');

    // A completed call advances the dots by a whole step.
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

    // A cluster never wears the row's top-border bar or icon fill — dots only.
    const css = document.getElementById('slicc-wcmsg-style')?.textContent ?? '';
    expect(css).toContain('slicc-action-row[data-progress] .slicc-act__body::before');
    expect(css).not.toContain('slicc-tool-cluster[data-progress] .slicc-cluster__ic');
    expect(css).not.toContain('slicc-tool-cluster[data-progress] .slicc-cluster__body::before');

    // Once every call has settled the treatment clears entirely.
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
    // Regression: a message's tool calls execute under Promise.all, so three
    // `bash` calls are in flight at once. Matching a result by "last unfinished
    // call with this name" attached outputs to the wrong row — `echo BBB`
    // rendered `CCC` on the live harness.
    for (const id of ['c2', 'c3']) {
      agent.emit({
        type: 'tool_use_start',
        messageId: 'm1',
        toolName: 'bash',
        toolInput: { command: `echo ${id}` },
        toolCallId: id,
      });
    }
    // Resolve the MIDDLE call first — the id must decide, not arrival order.
    agent.emit({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: 'output-for-c2',
      toolCallId: 'c2',
    });
    // Row ids are message-scoped (`<messageId>:<toolCallId>`) so a provider
    // that reuses an id in a later message cannot collide.
    const byId = (id: string) =>
      thread.querySelector<HTMLElement>(`slicc-action-row[data-tool-id="m1:${id}"]`);
    expect(byId('c2')?.getAttribute('result')).toBe('done');
    expect(byId('c3')?.getAttribute('result')).toBe('…');
    expect(byId('tc-1')?.getAttribute('result')).toBe('…');
    expect(byId('c2')?.textContent).toContain('output-for-c2');
    expect(byId('c3')?.textContent ?? '').not.toContain('output-for-c2');
  });

  it('scopes a reused provider call id per message (no cross-message bleed)', () => {
    // Review finding: a provider that reuses a tool-call id in a LATER message
    // would produce duplicate `data-tool-id`s, and the thread-wide row lookup
    // would paint the first (historical) match.
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
      toolCallId: 'tc-1', // same id as the m1 call
    });

    const ids = [...thread.querySelectorAll<HTMLElement>('slicc-action-row[data-tool-id]')].map(
      (r) => r.dataset.toolId
    );
    expect(new Set(ids).size).toBe(ids.length); // all distinct
    expect(ids).toContain('m1:tc-1');
    expect(ids).toContain('m2:tc-1');

    // Progress for the NEW call must land on the new row, not the old one.
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
    // Review finding: a transcript restored after an aborted turn keeps
    // result-less calls whose badge is a permanent `…`. Those are history, not
    // in-flight work, and must not pin a determinate 0% on the cluster.
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
    // Every row still reads `…`, but none of them was started this session.
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
