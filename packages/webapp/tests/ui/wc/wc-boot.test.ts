// @vitest-environment jsdom
/**
 * Prepare/attach boot tests: the float-agnostic shell wiring driven by a
 * fake OffscreenClient — the same seam the standalone kernel worker and the
 * extension offscreen engine plug into.
 */

import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

const newSessionMocks = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    reset: vi.fn(async () => {
      order.push('cleanup');
    }),
    freeze: vi.fn(async () => {
      order.push('archive:save');
      return null;
    }),
    freezeQuick: vi.fn(async () => {
      order.push('archive:skip');
      return null;
    }),
  };
});

vi.mock('../../../src/ui/new-session.js', () => ({
  resetNewSessionTmp: newSessionMocks.reset,
  runNewSessionFreeze: newSessionMocks.freeze,
  runNewSessionFreezeQuick: newSessionMocks.freezeQuick,
}));

// The boot path dynamically imports real kernel modules that log via real
// `console` on the intentionally-throwing test transport's async catch-paths.
// Those late logs queue an `onUserConsoleLog` RPC that races worker teardown
// under full-suite scheduling on Node 26. Replacing Vitest's interceptor with
// a no-op spy stops any RPC from being queued. `scoop-context.ts` reaches for
// `console.log` directly on its model-resolution path, so `log` and `trace`
// are mocked alongside the four severity levels.
beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'trace').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

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
    getSessionStats: vi.fn(async () => ({
      totalCost: 1.234,
      fills: [{ jid: 'cone-1', fill: 0.5 }],
    })),
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
    // Boot default: the first selection wears the navbar eyes until real
    // activity (message/input) moves them.
    expect(boot.refs.switcher.getAttribute('attention')).toBe('cone-1');
  });

  it('user input moves the navbar eyes to the addressed scoop', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachWcClient(boot, fake.client, log);
    boot.selectScoop(cone());
    boot.refs.switcher.setAttribute('attention', 'scoop-elsewhere');

    boot.refs.inputCard.dispatchEvent(
      new CustomEvent('submit', { bubbles: true, detail: { value: 'hi' } })
    );
    expect(boot.refs.switcher.getAttribute('attention')).toBe('cone-1');
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
    expect(fake.raw.setScoopThinkingLevel).toHaveBeenCalledWith('cone-1', 'xhigh', 'max');
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

  it('refreshes the cost counter and chip pupils from session stats on ready', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachWcClient(boot, fake.client, log);

    boot.wiring.notifyReady?.();
    await vi.waitFor(() => {
      expect(boot.refs.floatbar.getAttribute('spent')).toBe('1.23');
    });
    // The cone chip's pupils dilate with its context fill (0.5 → fill 50).
    expect(boot.wiring.fills.get('cone-1')).toBe(0.5);
    expect(boot.refs.switcher.scoops.find((s) => s.key === 'cone-1')?.fill).toBe(50);
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
    newSessionMocks.reset.mockClear();
    newSessionMocks.freeze.mockClear();
    newSessionMocks.freezeQuick.mockClear();
    newSessionMocks.order.length = 0;
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
    expect(newSessionMocks.reset).toHaveBeenCalledTimes(1);
    expect(boot.refs.thread.querySelector('slicc-agent-message')).toBeNull();
  });

  it.each([
    ['save', ['archive:save', 'cleanup', 'clear']],
    ['skip', ['archive:skip', 'cleanup', 'clear']],
    ['erase', ['cleanup', 'clear']],
  ] as const)('runs archive → /tmp cleanup → chat clear for %s', async (action, expectedOrder) => {
    newSessionMocks.reset.mockClear();
    newSessionMocks.freeze.mockClear();
    newSessionMocks.freezeQuick.mockClear();
    newSessionMocks.order.length = 0;
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    fake.raw.clearAllMessages.mockImplementation(async () => {
      newSessionMocks.order.push('clear');
    });
    attachWcClient(boot, fake.client, log);

    boot.refs.freezer.dispatchEvent(new CustomEvent(`new-chat-${action}`, { bubbles: true }));

    await vi.waitFor(() => expect(fake.raw.clearAllMessages).toHaveBeenCalledTimes(1));
    expect(newSessionMocks.order).toEqual(expectedOrder);
    expect(newSessionMocks.reset).toHaveBeenCalledTimes(1);
    expect(newSessionMocks.freeze).toHaveBeenCalledTimes(action === 'save' ? 1 : 0);
    expect(newSessionMocks.freezeQuick).toHaveBeenCalledTimes(action === 'skip' ? 1 : 0);
  });

  it('keeps the current chat when /tmp cleanup fails', async () => {
    newSessionMocks.reset.mockRejectedValueOnce(new Error('EIO'));
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachWcClient(boot, fake.client, log);
    const freezerNew = boot.refs.freezer.querySelector('slicc-freezer-new') as HTMLElement;

    boot.refs.freezer.dispatchEvent(new CustomEvent('new-chat-erase', { bubbles: true }));

    await vi.waitFor(() => expect(freezerNew.hasAttribute('busy')).toBe(false));
    expect(fake.raw.clearAllMessages).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('WC new session failed', expect.any(Error));
  });
});

/** Reset the jsdom URL between url-state tests (params persist per file). */
function clearUrlParams(): void {
  const url = new URL(window.location.href);
  url.search = '';
  history.replaceState(null, '', url);
}

describe('URL state sync (live boot)', () => {
  it('opts the thread and shell into url-state and captures the boot ctx', () => {
    clearUrlParams();
    const url = new URL(window.location.href);
    url.searchParams.set('ctx', 'scoop:researcher');
    history.replaceState(null, '', url);

    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    expect(boot.refs.thread.hasAttribute('url-state')).toBe(true);
    expect(boot.refs.shell.hasAttribute('url-state')).toBe(true);
    // The thread component owns the param; the host only routes its value.
    expect(boot.wiring.pendingUrlContext).toBe('scoop:researcher');
    clearUrlParams();
  });

  it('re-fires the surface activator for a pre-attach URL workspace restore', () => {
    clearUrlParams();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');

    // The shell's connect-time `ws` restore opened the workbench before any
    // activator existed (it is only assigned during attach).
    boot.refs.shell.setAttribute('open', '');
    boot.refs.workbenchBody.setAttribute('active', 'files');
    const activate = vi.fn();
    boot.setActivateSurface(activate);
    // The re-fire is gated behind kernel ready (VFS RPCs need the worker).
    expect(activate).not.toHaveBeenCalled();
    boot.wiring.notifyReady?.();
    expect(activate).toHaveBeenCalledWith('files');

    // Without a restored surface the assignment stays passive.
    boot.refs.shell.removeAttribute('open');
    const idle = vi.fn();
    boot.setActivateSurface(idle);
    boot.wiring.notifyReady?.();
    expect(idle).not.toHaveBeenCalled();
  });

  it('routes a popstate context change to scoop selection', async () => {
    clearUrlParams();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    const researcher = {
      ...cone(),
      jid: 'scoop-r',
      name: 'researcher',
      isCone: false,
      type: 'scoop',
    } as RegisteredScoop;
    fake.raw.getScoops.mockReturnValue([cone(), researcher]);
    attachWcClient(boot, fake.client, log);
    boot.selectScoop(cone());

    // Back/forward: the URL now names the scoop context; the thread asks the
    // host to route it via `slicc-url-context`.
    const url = new URL(window.location.href);
    url.searchParams.set('ctx', 'scoop:researcher');
    history.replaceState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(fake.raw.setSelectedScoopJid).toHaveBeenLastCalledWith('scoop-r');
    expect(boot.getSelected()?.jid).toBe('scoop-r');
    clearUrlParams();
  });

  it('routes a URL frozen-session deep link once the kernel is ready', () => {
    clearUrlParams();
    const url = new URL(window.location.href);
    url.searchParams.set('ctx', 'freezer:2026-06-11-old.md');
    history.replaceState(null, '', url);

    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachWcClient(boot, fake.client, log);
    expect(boot.wiring.pendingUrlContext).toBe('freezer:2026-06-11-old.md');

    // Kernel ready → the thaw routing consumes the pending context (the VFS
    // read itself fails fast on the test transport — routing must still
    // resolve so later ready signals don't re-run it).
    boot.wiring.notifyReady?.();
    expect(boot.wiring.pendingUrlContext).toBeNull();
    clearUrlParams();
  });
});
