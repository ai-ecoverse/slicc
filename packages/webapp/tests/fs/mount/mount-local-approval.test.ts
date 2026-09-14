import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMountDirectoryApproval } from '../../../src/shell/supplemental-commands/mount-directory-approval.js';
import { toolUIRegistry } from '../../../src/tools/tool-ui.js';

interface CapturedToolUI {
  requestId: string;
  html: string;
}

function captureToolUI(updates: CapturedToolUI[]) {
  return (partial: { content?: Array<{ type: string; requestId?: string; html?: string }> }) => {
    const block = partial?.content?.[0];
    if (block?.type === 'tool_ui' && typeof block.requestId === 'string') {
      updates.push({ requestId: block.requestId, html: block.html ?? '' });
    }
  };
}

describe('runMountDirectoryApproval — agent-driven approval', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    toolUIRegistry.cancelAll('test cleanup');
  });

  it('resolves via the simulated panel ack — denial surfaces a clean error, never hits the 5-min timeout', async () => {
    const updates: CapturedToolUI[] = [];
    const onUpdate = captureToolUI(updates);

    const pending = runMountDirectoryApproval(
      { onUpdate, toolName: 'mount', toolCallId: 't1' },
      '/workspace/mnt/test'
    );

    await Promise.resolve();
    expect(updates).toHaveLength(1);
    const { requestId, html } = updates[0];
    expect(html).toContain('data-action');

    toolUIRegistry.markMounted(requestId);
    await toolUIRegistry.handleAction(requestId, { action: 'deny', data: undefined });

    await expect(pending).rejects.toThrow(/mount: denied by user/);
  });

  it('fast-fails when no panel ever acks the mount (regression d222f1385)', async () => {
    const updates: CapturedToolUI[] = [];
    const onUpdate = captureToolUI(updates);

    const pending = runMountDirectoryApproval(
      { onUpdate, toolName: 'mount', toolCallId: 't2' },
      '/workspace/mnt/test'
    );

    await Promise.resolve();
    expect(updates).toHaveLength(1);

    const assertion = expect(pending).rejects.toThrow(
      /chat panel did not render the approval card/
    );
    await vi.advanceTimersByTimeAsync(5_100);
    await assertion;
  });

  it('includes the target path in the rendered approval card', async () => {
    const updates: CapturedToolUI[] = [];
    const onUpdate = captureToolUI(updates);

    const pending = runMountDirectoryApproval(
      { onUpdate, toolName: 'mount', toolCallId: 't4' },
      '/workspace/mnt/docs'
    );

    await Promise.resolve();
    expect(updates).toHaveLength(1);
    expect(updates[0].html).toContain('Target: /workspace/mnt/docs');

    toolUIRegistry.markMounted(updates[0].requestId);
    await toolUIRegistry.handleAction(updates[0].requestId, { action: 'deny', data: undefined });
    await expect(pending).rejects.toThrow(/mount: denied by user/);
  });
});
