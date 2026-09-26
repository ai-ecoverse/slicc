// @vitest-environment jsdom

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

import { FEATURE_FLAG_STORAGE_KEY, initFeatureFlags } from '../../../src/core/feature-flags.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type { OffscreenClient, SessionStats } from '../../../src/ui/offscreen-client.js';
import type { AgentEvent, AgentHandle } from '../../../src/ui/types.js';
import { prepareWcShell } from '../../../src/ui/wc/wc-live.js';
import { recordToWorkUnitSummary } from '../../../src/work-unit/client/from-record.js';
import { attachLeaderShell } from './leader-chat-host.js';

function cone(): RegisteredScoop {
  return {
    jid: 'cone-1',
    name: 'sliccy',
    folder: 'cone',
    isCone: true,
    parentJid: null,
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
  let selectedScoopJid: string | null = null;
  const client = {
    createAgentHandle: () => handle,

    sendUserMessage: vi.fn(async () => undefined),
    emitAgentError: vi.fn(),
    get selectedScoopJid(): string | null {
      return selectedScoopJid;
    },
    setSelectedScoopJid: vi.fn((jid: string | null) => {
      selectedScoopJid = jid;
    }),
    requestScoopMessages: vi.fn(),
    isProcessing: vi.fn(() => false),
    getScoops: vi.fn(() => [cone()]),
    sendSprinkleLick: vi.fn(),
    setScoopThinkingLevel: vi.fn(),
    stopScoop: vi.fn(),
    updateModel: vi.fn(),
    clearAllMessages: vi.fn(async () => undefined),

    getTransport: () => ({
      onMessage: () => () => undefined,
      send: () => {
        throw new Error('no transport in tests');
      },
    }),
    getSessionStats: vi.fn(
      async (): Promise<SessionStats> => ({
        totalCost: 1.234,
        burnRate: 2.345,
        fills: [{ jid: 'cone-1', fill: 0.5 }],
        models: [{ model: 'model-a', cost: 1.234, turns: 2, tokens: 123 }],
        scoops: [{ name: 'sliccy', model: 'model-a', cost: 1.234, type: 'cone', source: 'live' }],
      })
    ),
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

describe('prepareWcShell + attachLeaderShell', () => {
  it.each([
    ['off', false],
    ['on', true],
  ] as const)('sets dock-tree tile movement from panel-layouts=%s at attach', (value, expected) => {
    localStorage.removeItem(FEATURE_FLAG_STORAGE_KEY);
    initFeatureFlags('standalone', { 'panel-layouts': value });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();

    attachLeaderShell(boot, fake.client, log);

    expect(boot.refs.dockTree.tilesMovable).toBe(expected);
    initFeatureFlags('standalone');
  });

  it('mounts the shell and routes composer submissions to the agent', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachLeaderShell(boot, fake.client, log);
    boot.selectScoop(recordToWorkUnitSummary(cone(), {}));

    expect(root.querySelector('slicc-shell')).toBeTruthy();
    boot.refs.inputCard.setAttribute('value', 'hello cone');
    boot.refs.inputCard.dispatchEvent(
      new CustomEvent('submit', { bubbles: true, detail: { value: 'hello cone' } })
    );

    expect(fake.raw.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: expect.any(String),
        scoopJid: 'cone-1',
        text: 'hello cone',
      })
    );

    expect(boot.refs.inputCard.getAttribute('value') ?? '').toBe('');
  });

  it('selectScoop routes selection, history request, and re-enables input', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachLeaderShell(boot, fake.client, log);

    boot.refs.inputCard.setAttribute('disabled', '');
    boot.selectScoop(recordToWorkUnitSummary(cone(), {}));
    expect(fake.raw.setSelectedScoopJid).toHaveBeenCalledWith('cone-1');
    expect(fake.raw.requestScoopMessages).toHaveBeenCalledWith('cone-1');
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(false);
    expect(boot.getSelected()?.id).toBe('cone-1');

    expect(boot.refs.switcher.getAttribute('attention')).toBe('cone-1');
  });

  it('user input moves the navbar eyes to the addressed scoop', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachLeaderShell(boot, fake.client, log);
    boot.selectScoop(recordToWorkUnitSummary(cone(), {}));
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
    attachLeaderShell(boot, fake.client, log);
    boot.selectScoop(recordToWorkUnitSummary(cone(), {}));

    boot.refs.inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true }));
    expect(fake.raw.stopScoop).not.toHaveBeenCalled();

    fake.emit({ type: 'message_start', messageId: 'm1' });
    boot.refs.inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true }));

    expect(fake.raw.stopScoop).toHaveBeenCalledWith('cone-1');
  });

  it('persists thinking-level changes for the selected scoop', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachLeaderShell(boot, fake.client, log);
    boot.selectScoop(recordToWorkUnitSummary(cone(), {}));

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
    attachLeaderShell(boot, fake.client, log);

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
    attachLeaderShell(boot, fake.client, log);

    boot.wiring.notifyReady?.();
    await vi.waitFor(() => {
      expect(boot.refs.floatbar.getAttribute('spent')).toBe('1.23');
    });
    expect(boot.refs.floatbar.getAttribute('rate')).toBe('2.35');
    const floatbar = boot.refs.floatbar as HTMLElement & {
      costModels?: unknown;
      costScoops?: unknown;
    };
    expect(floatbar.costModels).toEqual([{ model: 'model-a', cost: 1.234, turns: 2, tokens: 123 }]);
    expect(floatbar.costScoops).toEqual([
      { name: 'sliccy', model: 'model-a', cost: 1.234, type: 'cone', source: 'live' },
    ]);

    expect(boot.wiring.fills.get('cone-1')).toBe(0.5);
    expect(boot.refs.switcher.scoops.find((s) => s.key === 'cone-1')?.fill).toBe(50);
  });

  it('removes the rate when an older stats payload omits burnRate', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    fake.raw.getSessionStats.mockResolvedValueOnce({
      totalCost: 1.234,
      fills: [],
      models: [],
      scoops: [],
    } as unknown as SessionStats);
    boot.refs.floatbar.setAttribute('rate', '9.99');
    attachLeaderShell(boot, fake.client, log);

    boot.wiring.notifyReady?.();
    await vi.waitFor(() => {
      expect(boot.refs.floatbar.hasAttribute('rate')).toBe(false);
    });
  });

  it('hands the provider budget to the floatbar, with the reset already formatted', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    fake.raw.getSessionStats.mockResolvedValueOnce({
      totalCost: 29.06,
      burnRate: 1.4,
      fills: [],
      models: [],
      scoops: [],
      budget: {
        percent: 9.5,
        status: 'ok',
        window: 'weekly',

        resetsAt: new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString(),
      },
    } as unknown as SessionStats);
    attachLeaderShell(boot, fake.client, log);

    boot.wiring.notifyReady?.();
    const floatbar = boot.refs.floatbar as HTMLElement & { budget?: unknown };
    await vi.waitFor(() => {
      expect(floatbar.budget).toEqual({
        percent: 9.5,
        status: 'ok',
        window: 'weekly',
        resets: 'resets in 18h',
      });
    });

    expect(boot.refs.floatbar.getAttribute('spent')).toBe('29.06');
  });

  it('clears the floatbar budget for a provider that reports none', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    fake.raw.getSessionStats.mockResolvedValueOnce({
      totalCost: 1.234,
      burnRate: 0.5,
      fills: [],
      models: [],
      scoops: [],
    } as unknown as SessionStats);
    const floatbar = boot.refs.floatbar as HTMLElement & { budget?: unknown };
    floatbar.budget = { percent: 63, status: 'ok', window: 'weekly' };
    attachLeaderShell(boot, fake.client, log);

    boot.wiring.notifyReady?.();
    await vi.waitFor(() => {
      expect(floatbar.budget).toBeNull();
    });
    expect(boot.refs.floatbar.getAttribute('rate')).toBe('0.50');
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
    attachLeaderShell(boot, fake.client, log);

    fake.emit({ type: 'message_start', messageId: 'm1' });
    fake.emit({ type: 'content_delta', messageId: 'm1', text: 'old conversation' });
    fake.emit({ type: 'content_done', messageId: 'm1' });
    expect(boot.refs.thread.querySelector('slicc-agent-message')).toBeTruthy();

    const freezerNew = boot.refs.freezer.querySelector('slicc-freezer-new') as HTMLElement;

    freezerNew.setAttribute('busy', '');
    boot.refs.freezer.dispatchEvent(new CustomEvent('new-chat-save', { bubbles: true }));

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
    attachLeaderShell(boot, fake.client, log);

    boot.refs.freezer.dispatchEvent(new CustomEvent(`new-chat-${action}`, { bubbles: true }));

    await vi.waitFor(() => expect(fake.raw.clearAllMessages).toHaveBeenCalledTimes(1));
    expect(newSessionMocks.order).toEqual(expectedOrder);
    expect(newSessionMocks.reset).toHaveBeenCalledTimes(1);
    expect(newSessionMocks.freeze).toHaveBeenCalledTimes(action === 'save' ? 1 : 0);
    expect(newSessionMocks.freezeQuick).toHaveBeenCalledTimes(action === 'skip' ? 1 : 0);
  });

  it('still clears the chat when /tmp cleanup fails', async () => {
    log.warn.mockClear();
    log.error.mockClear();
    newSessionMocks.reset.mockRejectedValueOnce(new Error('EIO'));
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');
    const fake = makeFakeClient();
    attachLeaderShell(boot, fake.client, log);
    const freezerNew = boot.refs.freezer.querySelector('slicc-freezer-new') as HTMLElement;

    boot.refs.freezer.dispatchEvent(new CustomEvent('new-chat-erase', { bubbles: true }));

    await vi.waitFor(() => expect(freezerNew.hasAttribute('busy')).toBe(false));
    expect(fake.raw.clearAllMessages).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'WC new session /tmp reset failed — clearing anyway',
      expect.any(Error)
    );

    expect(log.error).not.toHaveBeenCalledWith('WC new session failed', expect.anything());
  });
});

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

    expect(boot.wiring.pendingUrlContext).toBe('scoop:researcher');
    clearUrlParams();
  });

  it('re-fires the surface activator for every tool panel already placed in the restored dock-tree', () => {
    clearUrlParams();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const boot = prepareWcShell(root, 'test · wc');

    (
      boot.refs.dockTree as unknown as { placeSurface(id: string, zone: string): void }
    ).placeSurface('files', 'right');
    const activate = vi.fn();
    boot.setActivateSurface({
      activate,
      deactivate: vi.fn(),
      refreshMemory: vi.fn(),
      refreshFiles: vi.fn(),
    });

    expect(activate).not.toHaveBeenCalled();
    boot.wiring.notifyReady?.();
    expect(activate).toHaveBeenCalledWith('files');

    (boot.refs.dockTree as unknown as { removeSurface(id: string): void }).removeSurface('files');
    const idle = vi.fn();
    boot.setActivateSurface({
      activate: idle,
      deactivate: vi.fn(),
      refreshMemory: vi.fn(),
      refreshFiles: vi.fn(),
    });
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
      parentJid: 'cone-1',
      type: 'scoop',
    } as RegisteredScoop;
    fake.raw.getScoops.mockReturnValue([cone(), researcher]);
    attachLeaderShell(boot, fake.client, log);
    boot.selectScoop(recordToWorkUnitSummary(cone(), {}));

    const url = new URL(window.location.href);
    url.searchParams.set('ctx', 'scoop:researcher');
    history.replaceState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(fake.raw.setSelectedScoopJid).toHaveBeenLastCalledWith('scoop-r');
    expect(boot.getSelected()?.id).toBe('scoop-r');
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
    attachLeaderShell(boot, fake.client, log);
    expect(boot.wiring.pendingUrlContext).toBe('freezer:2026-06-11-old.md');

    boot.wiring.notifyReady?.();
    expect(boot.wiring.pendingUrlContext).toBeNull();
    clearUrlParams();
  });
});
