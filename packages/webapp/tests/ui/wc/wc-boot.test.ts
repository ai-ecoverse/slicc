// @vitest-environment jsdom
/**
 * Prepare/attach boot tests: the float-agnostic shell wiring driven by a
 * fake OffscreenClient — the same seam the standalone kernel worker and the
 * extension offscreen engine plug into.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

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

function makeFakeClient() {
  const listeners = new Set<(event: AgentEvent) => void>();
  const handle: AgentHandle = {
    sendMessage: vi.fn(),
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    stop: vi.fn(),
  };
  const client = {
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
    // Remote-VFS clients are built over this; a throwing send fails their
    // requests fast so the async wiring takes its catch paths in tests.
    getTransport: () => ({
      onMessage: () => () => undefined,
      send: () => {
        throw new Error('no transport in tests');
      },
    }),
  };
  return {
    client: client as unknown as OffscreenClient,
    raw: client,
    handle,
    emit: (event: AgentEvent) => {
      for (const cb of listeners) cb(event);
    },
  };
}

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('prepareWcShell + attachWcClient', () => {
  it('mounts the shell and routes composer submissions to the agent', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachWcClient(boot, fake.client, log);

    expect(root.querySelector('slicc-shell')).toBeTruthy();
    boot.refs.inputCard.setAttribute('value', 'hello cone');
    boot.refs.inputCard.dispatchEvent(
      new CustomEvent('submit', { bubbles: true, detail: { value: 'hello cone' } })
    );
    expect(fake.handle.sendMessage).toHaveBeenCalledWith(
      'hello cone',
      expect.any(String),
      undefined
    );
    // The submit handler clears the input card for the next prompt.
    expect(boot.refs.inputCard.getAttribute('value') ?? '').toBe('');
  });

  it('selectScoop routes selection, history request, and re-enables input', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachWcClient(boot, fake.client, log);

    boot.refs.inputCard.setAttribute('disabled', '');
    boot.selectScoop(cone());
    expect(fake.raw.setSelectedScoopJid).toHaveBeenCalledWith('cone-1');
    expect(fake.raw.requestScoopMessages).toHaveBeenCalledWith('cone-1');
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(false);
    expect(boot.getSelected()?.jid).toBe('cone-1');
  });

  it('stops the agent only while a turn is processing', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachWcClient(boot, fake.client, log);

    boot.refs.inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true }));
    expect(fake.handle.stop).not.toHaveBeenCalled();

    fake.emit({ type: 'message_start', messageId: 'm1' });
    boot.refs.inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true }));
    expect(fake.handle.stop).toHaveBeenCalledTimes(1);
  });

  it('persists thinking-level changes for the selected scoop', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachWcClient(boot, fake.client, log);
    boot.selectScoop(cone());

    boot.refs.composerMeta.dispatchEvent(
      new CustomEvent('thinking-change', { bubbles: true, detail: { thinking: 'max' } })
    );
    expect(fake.raw.setScoopThinkingLevel).toHaveBeenCalledWith('cone-1', 'xhigh');
  });

  it('renders streamed agent events into the thread', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachWcClient(boot, fake.client, log);

    fake.emit({ type: 'message_start', messageId: 'm1' });
    fake.emit({ type: 'content_delta', messageId: 'm1', text: 'streaming works' });
    fake.emit({ type: 'content_done', messageId: 'm1' });
    expect(boot.refs.thread.querySelector('slicc-agent-message')?.textContent).toContain(
      'streaming works'
    );
  });

  it('onClientReady fires listeners on notifyReady, and immediately when already ready', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');

    const before = vi.fn();
    boot.onClientReady(before);
    expect(before).not.toHaveBeenCalled();
    boot.wiring.notifyReady?.();
    expect(before).toHaveBeenCalledTimes(1);

    // Late registration (worker was ready before this wiring ran) fires now —
    // the boot-time freezer refresh depends on this to recover from the
    // lost-RPC race on fresh loads.
    const after = vi.fn();
    boot.onClientReady(after);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('new-session runs once per gesture and always clears the busy spinner', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachWcClient(boot, fake.client, log);

    // Seed a visible conversation: the clear must empty it WITHOUT relying
    // on a history replay (the worker no-ops the reply for empty histories).
    fake.emit({ type: 'message_start', messageId: 'm1' });
    fake.emit({ type: 'content_delta', messageId: 'm1', text: 'old conversation' });
    fake.emit({ type: 'content_done', messageId: 'm1' });
    expect(boot.refs.thread.querySelector('slicc-agent-message')).toBeTruthy();

    const freezerNew = boot.refs.freezer.querySelector('slicc-freezer-new') as HTMLElement;
    // A save click is what the user reported stuck: the library enters the
    // busy state optimistically; the host must exit it when the flow ends.
    freezerNew.setAttribute('busy', '');
    boot.refs.freezer.dispatchEvent(new CustomEvent('new-chat-save', { bubbles: true }));
    // A second click while the first save is in flight must NOT run again
    // (this used to write duplicate archives seconds apart).
    boot.refs.freezer.dispatchEvent(new CustomEvent('new-chat-save', { bubbles: true }));

    await vi.waitFor(() => {
      expect(freezerNew.hasAttribute('busy')).toBe(false);
    });
    expect(fake.raw.clearAllMessages).toHaveBeenCalledTimes(1);
    expect(boot.refs.thread.querySelector('slicc-agent-message')).toBeNull();
  });
});
