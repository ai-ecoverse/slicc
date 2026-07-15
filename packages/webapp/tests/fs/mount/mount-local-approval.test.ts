/**
 * `LocalMountBackend.create()` regression guard. The agent-driven mount
 * flow drives `showToolUI` and waits on the panel to settle the request;
 * if the panel never mounts the dip (commit d222f1385 deleted the
 * renderer entirely) the worker used to hang for `MOUNT_TOOL_UI_TIMEOUT_MS`
 * (5 minutes). These tests pin the simulated-panel ack route end-to-end
 * (drive `toolUIRegistry` directly, the same way `WcChatController` does
 * after the fix) AND the fast-fail detector — `create()` must surface a
 * clear `panel did not render` error within seconds when no ack arrives.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalMountBackend } from '../../../src/fs/mount/backend-local.js';
import { toolUIRegistry } from '../../../src/tools/tool-ui.js';

interface CapturedToolUI {
  requestId: string;
  html: string;
}

function captureToolUI(updates: CapturedToolUI[]) {
  // Mirrors the wire shape `showToolUI` posts through `onUpdate` — the
  // first entry is the `tool_ui` envelope carrying the registry id; a
  // matching `tool_ui_done` is posted later when the request settles.
  return (partial: { content?: Array<{ type: string; requestId?: string; html?: string }> }) => {
    const block = partial?.content?.[0];
    if (block?.type === 'tool_ui' && typeof block.requestId === 'string') {
      updates.push({ requestId: block.requestId, html: block.html ?? '' });
    }
  };
}

describe('LocalMountBackend.create — agent-driven approval', () => {
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

    const pending = LocalMountBackend.create({
      mountId: 'm1',
      isScoop: () => false,
      toolContext: { onUpdate, toolName: 'mount', toolCallId: 't1' },
      isExtension: false,
      targetPath: '/workspace/mnt/test',
    });

    // Yield once so the synchronous `showToolUI` registers + emits.
    await Promise.resolve();
    expect(updates).toHaveLength(1);
    const { requestId, html } = updates[0];
    expect(html).toContain('data-action');

    // Simulated panel: ack the mount (the `__mounted` channel), then
    // settle the request with a deny action. The ack alone unblocks the
    // fast-fail detector; the deny action races the safe UI promise to
    // completion well within the 5-minute upper bound.
    toolUIRegistry.markMounted(requestId);
    await toolUIRegistry.handleAction(requestId, { action: 'deny', data: undefined });

    await expect(pending).rejects.toThrow(/mount: denied by user/);
  });

  it('fast-fails when no panel ever acks the mount (regression d222f1385)', async () => {
    const updates: CapturedToolUI[] = [];
    const onUpdate = captureToolUI(updates);

    const pending = LocalMountBackend.create({
      mountId: 'm2',
      isScoop: () => false,
      toolContext: { onUpdate, toolName: 'mount', toolCallId: 't2' },
      isExtension: false,
      targetPath: '/workspace/mnt/test',
    });
    // Make sure showToolUI registered before we advance time, otherwise
    // `waitForMount` would not yet have its waiter installed.
    await Promise.resolve();
    expect(updates).toHaveLength(1);

    // No panel listening → advance past the 5-second ack window. The
    // backend cancels the request via `toolUIRegistry.cancel` and
    // surfaces a clear "chat panel did not render" error rather than
    // hanging for the full 5-minute approval timeout. Attach the
    // rejection assertion BEFORE advancing timers so `pending` always
    // has a handler when it settles (otherwise Node logs the rejection
    // as briefly unhandled between the timer microtask and the await).
    const assertion = expect(pending).rejects.toThrow(
      /chat panel did not render the approval card/
    );
    await vi.advanceTimersByTimeAsync(5_100);
    await assertion;
  });

  it('refuses scoop-initiated mounts without ever emitting tool_ui', async () => {
    const updates: CapturedToolUI[] = [];
    const onUpdate = captureToolUI(updates);

    await expect(
      LocalMountBackend.create({
        mountId: 'm3',
        isScoop: () => true,
        toolContext: { onUpdate, toolName: 'mount', toolCallId: 't3' },
        isExtension: false,
        targetPath: '/workspace/mnt/test',
      })
    ).rejects.toThrow(/cannot mount local directories from a scoop/);
    expect(updates).toHaveLength(0);
  });

  it('includes the target path in the rendered approval card', async () => {
    const updates: CapturedToolUI[] = [];
    const onUpdate = captureToolUI(updates);

    const pending = LocalMountBackend.create({
      mountId: 'm4',
      isScoop: () => false,
      toolContext: { onUpdate, toolName: 'mount', toolCallId: 't4' },
      isExtension: false,
      targetPath: '/workspace/mnt/docs',
    });

    await Promise.resolve();
    expect(updates).toHaveLength(1);
    expect(updates[0].html).toContain('Target: /workspace/mnt/docs');

    toolUIRegistry.markMounted(updates[0].requestId);
    await toolUIRegistry.handleAction(updates[0].requestId, { action: 'deny', data: undefined });
    await expect(pending).rejects.toThrow(/mount: denied by user/);
  });
});
