// @vitest-environment jsdom
/**
 * Boot deep-link to a frozen session (`?ctx=freezer:<file>`) when the
 * sessions INDEX is corrupt: the archive is the ground truth, so the thaw
 * must read it directly instead of dead-ending on the index miss — and a
 * genuinely failed thaw must fall back to the cone, never a blank shell.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

const SLUG = '2026-06-11T08-48-20-287Z-corrupt-index-session.md';

const ARCHIVE = `---
title: "Corrupt Index Session"
frozenAt: "2026-06-11T08:48:20.287Z"
messageCount: 2
---

<!-- slicc:session-data
[{"id":"m1","role":"user","content":"hello from the archive","timestamp":1},{"id":"m2","role":"assistant","content":"still here","timestamp":2}]
-->

# Corrupt Index Session
`;

const vfs = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('../../../src/kernel/remote-vfs-client.js', () => ({
  createRemoteVfsClient: () => ({
    readFile: async (path: string) => {
      const text = vfs.files.get(path);
      if (text === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return text;
    },
    readDir: async () =>
      Array.from(vfs.files.keys())
        .filter((p) => p.startsWith('/sessions/') && p.endsWith('.md'))
        .map((p) => ({ name: p.slice('/sessions/'.length), type: 'file' as const })),
  }),
}));
vi.mock('../../../src/kernel/writable-vfs-client.js', () => ({
  createRemoteWritableVfsClient: () => ({ writeFile: vi.fn(async () => undefined) }),
}));

import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import type { AgentEvent, AgentHandle } from '../../../src/ui/types.js';
import { attachWcClient, prepareWcShell } from '../../../src/ui/wc/wc-live.js';

function cone(): RegisteredScoop {
  return {
    jid: 'cone-1',
    name: 'sliccy',
    folder: 'cone',
    isCone: true,
    type: 'cone',
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: '2026-01-01T00:00:00Z',
  } as RegisteredScoop;
}

function makeFakeClient(): OffscreenClient {
  const handle: AgentHandle = {
    sendMessage: vi.fn(),
    onEvent: (_cb: (event: AgentEvent) => void) => () => undefined,
    stop: vi.fn(),
  };
  return {
    createAgentHandle: () => handle,
    setSelectedScoopJid: vi.fn(),
    requestScoopMessages: vi.fn(),
    isProcessing: vi.fn(() => false),
    getScoops: vi.fn(() => [cone()]),
    sendSprinkleLick: vi.fn(),
    setScoopThinkingLevel: vi.fn(),
    stopScoop: vi.fn(),
    updateModel: vi.fn(),
    clearAllMessages: vi.fn(async () => undefined),
    getTransport: () => ({ onMessage: () => () => undefined, send: vi.fn() }),
    getSessionStats: vi.fn(async () => ({ totalCost: 0, fills: [] })),
  } as unknown as OffscreenClient;
}

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setFreezerCtx(slug: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('ctx', `freezer:${slug}`);
  history.replaceState(null, '', url);
}

function clearCtx(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('ctx');
  url.searchParams.delete('at');
  url.searchParams.delete('ws');
  history.replaceState(null, '', url);
}

describe('freezer boot deep link vs corrupt index', () => {
  it('thaws straight from the archive when index.json is corrupt', async () => {
    vfs.files.clear();
    vfs.files.set('/sessions/index.json', '[{"filename": truncated-mid-wri');
    vfs.files.set(`/sessions/${SLUG}`, ARCHIVE);
    setFreezerCtx(SLUG);

    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    attachWcClient(boot, makeFakeClient(), log);
    boot.wiring.notifyReady?.();

    await vi.waitFor(() => {
      expect(boot.refs.thread.getAttribute('context')).toBe(`freezer:${SLUG}`);
      expect(boot.refs.thread.querySelectorAll('slicc-user-message')).toHaveLength(1);
      expect(boot.refs.thread.querySelectorAll('slicc-agent-message')).toHaveLength(1);
    });
    // Read-only view: composer disabled, no live scoop selected.
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(true);
    expect(boot.getSelected()).toBeNull();
    clearCtx();
  });

  it('falls back to the cone when the named archive is gone too', async () => {
    vfs.files.clear();
    vfs.files.set('/sessions/index.json', '[{"filename": truncated-mid-wri');
    setFreezerCtx('2026-01-01T00-00-00-000Z-vanished.md');

    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    attachWcClient(boot, makeFakeClient(), log);
    boot.wiring.notifyReady?.();

    // The dead-end guard lands the user on the cone instead of leaving the
    // shell with no selection and an empty thread.
    await vi.waitFor(() => expect(boot.getSelected()?.isCone).toBe(true));
    clearCtx();
  });
});
