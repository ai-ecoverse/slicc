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
  metaThinkingForScoop,
  scoopColor,
  thinkingLevelForAgent,
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
  const thread = document.createElement('slicc-chat-thread');
  const refs = { switcher, thread } as unknown as WcShellRefs;
  let selected = options.selected ?? null;
  return {
    refs,
    controller,
    statuses: new Map(),
    fills: new Map(),
    pendingUrlContext: null,
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

describe('toSwitcherScoops context fill', () => {
  it('maps 0..1 fills onto the pill 0-100 scale, omitting unknown scoops', () => {
    const fills = new Map([[cone.jid, 0.42]]);
    const chips = toSwitcherScoops([cone, scoop({})], undefined, fills);
    expect(chips.find((c) => c.key === cone.jid)?.fill).toBe(42);
    expect(chips.find((c) => c.key === 'scoop-1')?.fill).toBeUndefined();
  });
});

describe('thinking level bridges', () => {
  it('maps the composer-meta scale onto pi levels, capping max at xhigh', () => {
    expect(thinkingLevelForAgent('off')).toBe('off');
    expect(thinkingLevelForAgent('medium')).toBe('medium');
    expect(thinkingLevelForAgent('max')).toBe('xhigh');
    expect(thinkingLevelForAgent('bogus')).toBeUndefined();
    expect(thinkingLevelForAgent(undefined)).toBeUndefined();
  });

  it('maps pi levels back for display, folding minimal into low', () => {
    expect(metaThinkingForScoop('minimal')).toBe('low');
    expect(metaThinkingForScoop('xhigh')).toBe('xhigh');
    expect(metaThinkingForScoop(undefined)).toBe('off');
  });
});

describe('createWcLiveCallbacks', () => {
  it('routes status changes for the selected scoop into processing state', () => {
    const wiring = makeWiring({ selected: cone });
    const callbacks = createWcLiveCallbacks(wiring);
    callbacks.onStatusChange(cone.jid, 'processing' as never);
    callbacks.onStatusChange(cone.jid, 'ready' as never);
    callbacks.onStatusChange('other-jid', 'processing' as never);
    expect(wiring.controller.setProcessing.mock.calls).toEqual([[true], [false]]);
  });

  it('records statuses and re-chips the switcher on eye-state transitions', () => {
    const erroring = scoop({ jid: 'scoop-err', name: 'tester' });
    const wiring = makeWiring({ selected: cone, scoops: [cone, erroring] });
    const callbacks = createWcLiveCallbacks(wiring);
    callbacks.onStatusChange(erroring.jid, 'error' as never);
    expect(wiring.statuses.get(erroring.jid)).toBe('error');
    const chips = wiring.refs.switcher.scoops;
    expect(chips.find((c) => c.key === 'scoop-err')?.eyes).toBe('dead');
    expect(chips.find((c) => c.key === 'cone-1')?.eyes).toBe('open');
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

  it('selects the cone on a scoop-list update when nothing is selected yet', () => {
    // The first state snapshot can land BEFORE the cone restores; a restored
    // cone arrives only via list updates (no scoop-created) — without this,
    // sending failed with "no scoop selected" until a manual chip click.
    const wiring = makeWiring({ selected: null, scoops: [cone] });
    createWcLiveCallbacks(wiring).onScoopListUpdate([] as never);
    expect(wiring.selectScoop).toHaveBeenCalledWith(cone);
  });

  it('leaves the frozen-session view alone on scoop-list updates', () => {
    const wiring = makeWiring({ selected: null, scoops: [cone] });
    wiring.refs.thread.setAttribute('context', 'freezer:2026-06-11-some-session.md');
    createWcLiveCallbacks(wiring).onScoopListUpdate([] as never);
    expect(wiring.selectScoop).not.toHaveBeenCalled();
  });

  it('stamps the switcher attention with the scoop that received a message', () => {
    // The navbar eyes follow most-recent activity: any incoming message moves
    // the blinking pair to its scoop — selected or not.
    const wiring = makeWiring({ selected: cone, scoops: [cone, scoop({})] });
    const callbacks = createWcLiveCallbacks(wiring);
    const msg = { id: 'l1', content: 'done', channel: 'scoop-notify', timestamp: 1 };
    callbacks.onIncomingMessage('scoop-1', msg as never);
    expect(wiring.refs.switcher.getAttribute('attention')).toBe('scoop-1');
    callbacks.onIncomingMessage(cone.jid, msg as never);
    expect(wiring.refs.switcher.getAttribute('attention')).toBe('cone-1');
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

describe('URL boot-context routing (pendingUrlContext)', () => {
  it('selects the URL scoop instead of the cone, then clears the pending context', () => {
    const target = scoop({ jid: 'scoop-r', name: 'researcher' });
    const wiring = makeWiring({ selected: null, scoops: [cone, target] });
    wiring.pendingUrlContext = 'scoop:researcher';
    createWcLiveCallbacks(wiring).onScoopListUpdate([] as never);
    expect(wiring.selectScoop).toHaveBeenCalledWith(target);
    expect(wiring.pendingUrlContext).toBeNull();
  });

  it('falls back to the cone when the URL scoop is gone (dropped since)', () => {
    const wiring = makeWiring({ selected: null, scoops: [cone] });
    wiring.pendingUrlContext = 'scoop:long-gone';
    createWcLiveCallbacks(wiring).onScoopListUpdate([] as never);
    expect(wiring.selectScoop).toHaveBeenCalledWith(cone);
    expect(wiring.pendingUrlContext).toBeNull();
  });

  it('keeps the selection empty for a URL frozen session (the host thaws it)', () => {
    const wiring = makeWiring({ selected: null, scoops: [cone] });
    wiring.pendingUrlContext = 'freezer:2026-06-11-some-session.md';
    createWcLiveCallbacks(wiring).onScoopListUpdate([] as never);
    expect(wiring.selectScoop).not.toHaveBeenCalled();
    expect(wiring.pendingUrlContext).toBe('freezer:2026-06-11-some-session.md');
  });

  it('does not let scoop-created steal a pending URL context', () => {
    const other = scoop({ jid: 'scoop-x', name: 'other' });
    const wiring = makeWiring({ selected: null, scoops: [cone, other] });
    wiring.pendingUrlContext = 'freezer:abc.md';
    createWcLiveCallbacks(wiring).onScoopCreated(other);
    expect(wiring.selectScoop).not.toHaveBeenCalled();
  });
});
