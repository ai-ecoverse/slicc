/**
 * End-to-end wiring of the bash progress overlay through
 * `AlmostBashShellHeadless`: `sleep` ticks via `BashOptions.sleep`, ordinary
 * commands get a start/end pair, and everything reaches the tool execution
 * context's `onUpdate` as `progress` partial results.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  popToolExecutionContext,
  pushToolExecutionContext,
} from '../../../src/base/tool-execution-context.js';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';
import type { ProgressEvent } from '../../../src/shell/progress/index.js';

function captureProgress() {
  const events: ProgressEvent[] = [];
  const onUpdate = vi.fn((partial: unknown) => {
    const content = (partial as { content?: Array<{ type: string; progress?: ProgressEvent }> })
      .content;
    for (const c of content ?? []) if (c.type === 'progress' && c.progress) events.push(c.progress);
  });
  return { events, onUpdate };
}

describe('AlmostBashShellHeadless progress wiring', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-progress-${dbCounter++}`, wipe: true });
  });

  it('reports determinate progress for sleep inside a tool context', async () => {
    const shell = new AlmostBashShellHeadless({ fs });
    const { events, onUpdate } = captureProgress();
    const ctx = pushToolExecutionContext({ onUpdate, toolName: 'bash', toolCallId: 'tc1' });
    try {
      const result = await shell.executeCommand('sleep 0.6');
      expect(result.exitCode).toBe(0);
    } finally {
      popToolExecutionContext(ctx);
    }
    const sleepEvents = events.filter((e) => e.id.startsWith('sleep-'));
    expect(sleepEvents[0]).toMatchObject({ phase: 'start', label: 'sleep 0.6', total: 600 });
    expect(sleepEvents.at(-1)).toMatchObject({ phase: 'end', fraction: 1 });
    expect(sleepEvents.some((e) => e.phase === 'update')).toBe(true);
  });

  it('wraps ordinary commands with an indeterminate start/end pair', async () => {
    const shell = new AlmostBashShellHeadless({ fs });
    const { events, onUpdate } = captureProgress();
    const ctx = pushToolExecutionContext({ onUpdate, toolName: 'bash', toolCallId: 'tc2' });
    try {
      await shell.executeCommand('ls /');
    } finally {
      popToolExecutionContext(ctx);
    }
    const ls = events.filter((e) => e.label === 'ls /');
    expect(ls.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(ls[0].fraction).toBeUndefined();
  });

  it('emits nothing for the human terminal (no tool context)', async () => {
    const shell = new AlmostBashShellHeadless({ fs });
    const { events, onUpdate } = captureProgress();
    await shell.executeCommand('sleep 0.3; ls /');
    expect(onUpdate).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('runs labels through the configured scrubber', async () => {
    const shell = new AlmostBashShellHeadless({
      fs,
      scrubProgressLabel: async (text) => text.replace('hunter2', '***'),
    });
    const { events, onUpdate } = captureProgress();
    const ctx = pushToolExecutionContext({ onUpdate, toolName: 'bash', toolCallId: 'tc3' });
    try {
      await shell.executeCommand('ls hunter2 2>/dev/null; true');
    } finally {
      popToolExecutionContext(ctx);
    }
    await vi.waitFor(() => expect(events.some((e) => e.label.startsWith('ls '))).toBe(true));
    for (const e of events) expect(e.label).not.toContain('hunter2');
    expect(events.find((e) => e.label.startsWith('ls '))?.label).toBe('ls ***');
  });
});
