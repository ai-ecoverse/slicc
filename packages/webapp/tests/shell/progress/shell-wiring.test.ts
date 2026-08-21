/**
 * End-to-end wiring of the bash progress overlay through
 * `AlmostBashShellHeadless`: every tool-call script gets ONE script-level unit;
 * `sleep`/`timeout` ticks and per-command start/end fold into it; everything
 * reaches the tool execution context's `onUpdate` as `progress` partials.
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

async function runInTool(shell: AlmostBashShellHeadless, script: string) {
  const { events, onUpdate } = captureProgress();
  const ctx = pushToolExecutionContext({ onUpdate, toolName: 'bash', toolCallId: 'tc' });
  try {
    const result = await shell.executeCommand(script);
    return { events, onUpdate, result };
  } finally {
    popToolExecutionContext(ctx);
  }
}

describe('AlmostBashShellHeadless progress wiring', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-progress-${dbCounter++}`, wipe: true });
  });

  it('emits exactly one unit per script, ticking once per completed command', async () => {
    const shell = new AlmostBashShellHeadless({ fs });
    const { events } = await runInTool(shell, 'echo a; echo b; echo c');
    expect(new Set(events.map((e) => e.id)).size).toBe(1);
    expect(events[0]).toMatchObject({ phase: 'start', fraction: 0, total: 3, done: 0 });
    // Sub-millisecond steps are throttled; the end event carries the count.
    expect(events.at(-1)).toMatchObject({ phase: 'end', fraction: 1, done: 3, total: 3 });
  });

  it('folds sleep ticks into the script fraction', async () => {
    const shell = new AlmostBashShellHeadless({ fs });
    const { events, result } = await runInTool(shell, 'sleep 0.6; echo done');
    expect(result.exitCode).toBe(0);
    expect(new Set(events.map((e) => e.id)).size).toBe(1);
    const mid = events.filter(
      (e) => e.phase === 'update' && (e.fraction ?? 0) > 0 && (e.fraction ?? 0) < 0.5
    );
    expect(mid.length).toBeGreaterThan(0);
    expect(mid[0].label).toContain('sleep 0.6');
    expect(events.at(-1)).toMatchObject({ phase: 'end', fraction: 1, total: 2 });
  });

  it('ticks timeout against its limit', async () => {
    const shell = new AlmostBashShellHeadless({ fs });
    const { events } = await runInTool(shell, 'timeout 2 sleep 0.6');
    expect(events[0]).toMatchObject({ phase: 'start', total: 2 });
    const withTimeout = events.filter((e) => e.label.includes('timeout 2'));
    expect(withTimeout.length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ phase: 'end', fraction: 1, done: 2 });
  });

  it('reports an indeterminate unit for unplannable scripts', async () => {
    const shell = new AlmostBashShellHeadless({ fs });
    const { events } = await runInTool(shell, 'for f in /*; do echo $f; done');
    expect(events[0]).toMatchObject({ phase: 'start', fraction: undefined });
    expect(events[0].total).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ phase: 'end', fraction: 1 });
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
      scrubProgressLabel: async (text) => text.replace(/hunter2/g, '***'),
    });
    const { events } = await runInTool(
      shell,
      'sleep 0.3 hunter2 2>/dev/null; ls hunter2 2>/dev/null; true'
    );
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    for (const e of events) expect(e.label).not.toContain('hunter2');
    expect(events[0].label).toContain('***');
  });
});
