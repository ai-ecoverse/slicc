// @vitest-environment jsdom

/**
 * Focused tests for the `setupFrozenSessions()` boot stage. The
 * archive parser and the freezer-write path have their own coverage
 * in `tests/ui/session-freezer.test.ts`; these tests pin the
 * stage-level contract that lives in `setup-frozen-sessions.ts`:
 *
 *   - Installs `layout.onFrozenSessionOpen`.
 *   - Returns an `attachScoopsVfs()` that calls
 *     `layout.panels.scoops.setVfs(vfs.panelReadVfs)` at call time
 *     (so the mutated post-`attachWorkerVfs` reader is what lands on
 *     the scoops panel).
 *   - The open handler reads via `vfs.panelReadVfs.readFile` (read at
 *     fire-time, not at install-time) and dispatches the parsed
 *     archive to the chat panel + thread header + active tab.
 *   - The open handler swallows read failures into `log.warn` rather
 *     than rejecting.
 */

import { describe, expect, it, vi } from 'vitest';
import type { LocalVfsClient } from '../../../src/kernel/local-vfs-client.js';
import { setupFrozenSessions } from '../../../src/ui/boot/setup-frozen-sessions.js';
import type { FrozenSessionsSetupDeps, VfsHandle } from '../../../src/ui/boot/types.js';
import type { Layout } from '../../../src/ui/layout.js';
import type { FrozenSessionIndexEntry } from '../../../src/ui/session-freezer.js';

function makeFakeLayout(): {
  layout: FrozenSessionsSetupDeps['layout'];
  setActiveTab: ReturnType<typeof vi.fn>;
  displayFrozenSession: ReturnType<typeof vi.fn>;
  setThreadHeaderName: ReturnType<typeof vi.fn>;
  scoopsSetVfs: ReturnType<typeof vi.fn>;
} {
  const setActiveTab = vi.fn();
  const displayFrozenSession = vi.fn(async () => {});
  const setThreadHeaderName = vi.fn();
  const scoopsSetVfs = vi.fn();
  const layout = {
    onFrozenSessionOpen: undefined as ((entry: FrozenSessionIndexEntry) => void) | undefined,
    setActiveTab,
    setThreadHeaderName,
    panels: {
      chat: { displayFrozenSession },
      scoops: { setVfs: scoopsSetVfs },
    },
  };
  return {
    layout: layout as unknown as Layout,
    setActiveTab,
    displayFrozenSession,
    setThreadHeaderName,
    scoopsSetVfs,
  };
}

function makeFakeVfs(reader: Partial<LocalVfsClient> = {}): VfsHandle {
  // Only the bits the stage touches need to be real; cast the rest.
  return {
    panelReadVfs: reader as LocalVfsClient,
  } as unknown as VfsHandle;
}

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ENTRY: FrozenSessionIndexEntry = {
  filename: '2026-05-13T19-30-00Z-test.md',
  title: 'Original',
  frozenAt: '2026-05-13T19:30:00Z',
  messageCount: 1,
};

const ARCHIVE = `---
title: "Parsed Title"
---

## User
hello
`;

describe('setupFrozenSessions', () => {
  it('installs layout.onFrozenSessionOpen', () => {
    const { layout } = makeFakeLayout();
    expect((layout as { onFrozenSessionOpen?: unknown }).onFrozenSessionOpen).toBeUndefined();

    setupFrozenSessions({ layout, vfs: makeFakeVfs(), log: silentLog });

    expect(typeof (layout as { onFrozenSessionOpen?: unknown }).onFrozenSessionOpen).toBe(
      'function'
    );
  });

  it('attachScoopsVfs() forwards the CURRENT panelReadVfs (post-mutation)', () => {
    const { layout, scoopsSetVfs } = makeFakeLayout();
    const vfs = makeFakeVfs();
    const initial = { tag: 'initial' } as unknown as LocalVfsClient;
    const mutated = { tag: 'mutated' } as unknown as LocalVfsClient;
    vfs.panelReadVfs = initial;
    const handle = setupFrozenSessions({ layout, vfs, log: silentLog });

    // Simulate `attachWorkerVfs` swapping in the remote reader.
    vfs.panelReadVfs = mutated;
    handle.attachScoopsVfs();

    expect(scoopsSetVfs).toHaveBeenCalledTimes(1);
    expect(scoopsSetVfs).toHaveBeenCalledWith(mutated);
  });

  it('open handler reads via vfs.panelReadVfs at fire-time and dispatches to chat + header + tab', async () => {
    const { layout, displayFrozenSession, setThreadHeaderName, setActiveTab } = makeFakeLayout();
    const reader = { readFile: vi.fn(async () => ARCHIVE) };
    const vfs = makeFakeVfs(reader as unknown as Partial<LocalVfsClient>);
    setupFrozenSessions({ layout, vfs, log: silentLog });

    (layout as unknown as Layout).onFrozenSessionOpen?.(ENTRY);
    // Wait for the embedded `void (async () => …)()` island to settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(reader.readFile).toHaveBeenCalledWith(`/sessions/${ENTRY.filename}`, {
      encoding: 'utf-8',
    });
    expect(displayFrozenSession).toHaveBeenCalledTimes(1);
    const call = displayFrozenSession.mock.calls[0][0] as {
      contextId: string;
      title: string;
    };
    expect(call.contextId).toBe(`frozen:${ENTRY.filename}`);
    expect(call.title).toBe('Parsed Title');
    expect(setThreadHeaderName).toHaveBeenCalledWith('❄ Parsed Title');
    expect(setActiveTab).toHaveBeenCalledWith('chat');
  });

  it('open handler swallows read failures into log.warn (does not throw)', async () => {
    const { layout, displayFrozenSession } = makeFakeLayout();
    const reader = {
      readFile: vi.fn(async () => {
        throw new Error('ENOENT: not found');
      }),
    };
    const vfs = makeFakeVfs(reader as unknown as Partial<LocalVfsClient>);
    const warn = vi.fn();
    setupFrozenSessions({
      layout,
      vfs,
      log: { ...silentLog, warn },
    });

    expect(() => (layout as unknown as Layout).onFrozenSessionOpen?.(ENTRY)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, meta] = warn.mock.calls[0] as [string, { filename: string; error: string }];
    expect(msg).toBe('Failed to open frozen session');
    expect(meta.filename).toBe(ENTRY.filename);
    expect(meta.error).toContain('ENOENT');
    expect(displayFrozenSession).not.toHaveBeenCalled();
  });
});
