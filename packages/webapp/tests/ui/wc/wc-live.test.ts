// @vitest-environment jsdom
/**
 * Tests for the live-mode wiring helpers: scoop→chip mapping and the kernel
 * callback factory, driven entirely with fakes (no worker, no CDP).
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { RegisteredScoop } from '../../../src/scoops/types.js';
import {
  createWcLiveCallbacks,
  scoopColor,
  toSwitcherScoops,
  type WcLiveWiring,
} from '../../../src/ui/wc/wc-live.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';

function scoop(overrides: Partial<RegisteredScoop>): RegisteredScoop {
  return {
    jid: 'scoop-1',
    name: 'researcher',
    folder: 'researcher',
    isCone: false,
    type: 'scoop',
    requiresTrigger: false,
    assistantLabel: 'researcher',
    addedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as RegisteredScoop;
}

const cone = scoop({ jid: 'cone-1', name: 'sliccy', isCone: true, type: 'cone' });

describe('scoopColor / toSwitcherScoops', () => {
  it('gives the cone its fixed waffle color', () => {
    expect(scoopColor(cone)).toBe('#b07823');
  });

  it('assigns scoops a stable palette color by name', () => {
    const a = scoopColor(scoop({ name: 'researcher' }));
    expect(scoopColor(scoop({ name: 'researcher' }))).toBe(a);
    expect(a).toMatch(/^#/);
  });

  it('puts the cone first and labels it sliccy', () => {
    const chips = toSwitcherScoops([scoop({}), cone]);
    expect(chips[0]).toMatchObject({ key: 'cone-1', type: 'cone', label: 'sliccy' });
    expect(chips[1]).toMatchObject({ key: 'scoop-1', type: 'scoop', label: 'researcher' });
  });
});

interface FakeWiring extends WcLiveWiring {
  controller: {
    setProcessing: ReturnType<typeof vi.fn>;
    addLickMessage: ReturnType<typeof vi.fn>;
    loadMessages: ReturnType<typeof vi.fn>;
  };
}

function makeWiring(options: {
  selected?: RegisteredScoop | null;
  scoops?: RegisteredScoop[];
}): FakeWiring {
  const controller = {
    setProcessing: vi.fn(),
    addLickMessage: vi.fn(),
    loadMessages: vi.fn(),
  };
  const switcher = document.createElement('slicc-scoop-switcher') as WcShellRefs['switcher'];
  const refs = { switcher } as unknown as WcShellRefs;
  let selected = options.selected ?? null;
  return {
    refs,
    controller,
    getController: () => controller as never,
    getClient: () =>
      ({
        getScoops: () => options.scoops ?? [],
      }) as never,
    getSelected: () => selected,
    selectScoop: vi.fn((s: RegisteredScoop) => {
      selected = s;
    }),
  };
}

describe('createWcLiveCallbacks', () => {
  it('routes status changes for the selected scoop into processing state', () => {
    const wiring = makeWiring({ selected: cone });
    const callbacks = createWcLiveCallbacks(wiring);
    callbacks.onStatusChange(cone.jid, 'processing' as never);
    callbacks.onStatusChange(cone.jid, 'ready' as never);
    callbacks.onStatusChange('other-jid', 'processing' as never);
    expect(wiring.controller.setProcessing.mock.calls).toEqual([[true], [false]]);
  });

  it('selects the first created scoop when nothing is selected', () => {
    const wiring = makeWiring({ selected: null, scoops: [cone] });
    const callbacks = createWcLiveCallbacks(wiring);
    callbacks.onScoopCreated(cone);
    expect(wiring.selectScoop).toHaveBeenCalledWith(cone);
    expect(wiring.refs.switcher.scoops).toHaveLength(1);
  });

  it('refreshes switcher chips on scoop list updates', () => {
    const wiring = makeWiring({ selected: cone, scoops: [cone, scoop({})] });
    createWcLiveCallbacks(wiring).onScoopListUpdate([] as never);
    expect(wiring.refs.switcher.scoops.map((c) => c.key)).toEqual(['cone-1', 'scoop-1']);
  });

  it('renders licks for the selected scoop only, skipping web messages', () => {
    const wiring = makeWiring({ selected: cone });
    const callbacks = createWcLiveCallbacks(wiring);
    const msg = { id: 'l1', content: '[Webhook Event: x]', channel: 'webhook', timestamp: 1 };
    callbacks.onIncomingMessage(cone.jid, msg as never);
    callbacks.onIncomingMessage('other', msg as never);
    callbacks.onIncomingMessage(cone.jid, { ...msg, channel: 'web' } as never);
    expect(wiring.controller.addLickMessage).toHaveBeenCalledTimes(1);
    expect(wiring.controller.addLickMessage).toHaveBeenCalledWith(
      'l1',
      '[Webhook Event: x]',
      'webhook',
      1
    );
  });

  it('replaces history for the selected scoop', () => {
    const wiring = makeWiring({ selected: cone });
    const callbacks = createWcLiveCallbacks(wiring);
    const messages = [{ id: 'h1' }];
    callbacks.onScoopMessagesReplaced?.(cone.jid, messages as never);
    callbacks.onScoopMessagesReplaced?.('other', [] as never);
    expect(wiring.controller.loadMessages).toHaveBeenCalledTimes(1);
    expect(wiring.controller.loadMessages).toHaveBeenCalledWith(messages);
  });

  it('selects the cone when the kernel reports ready', () => {
    const wiring = makeWiring({ selected: null, scoops: [scoop({}), cone] });
    createWcLiveCallbacks(wiring).onReady?.();
    expect(wiring.selectScoop).toHaveBeenCalledWith(cone);
  });
});
