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
  parseProcStatLine,
  scoopColor,
  thinkingLevelForAgent,
  toSwitcherScoops,
  type WcLiveWiring,
  wireWcChipTips,
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
    updateLickState: ReturnType<typeof vi.fn>;
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
    updateLickState: vi.fn(),
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
    lastActivity: new Map(),
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

  it('moves switcher attention onto a non-selected, actively-streaming scoop', () => {
    // Cone is selected, but a different scoop is streaming an agent turn —
    // the eyes must follow the activity even though selection is unchanged.
    const streamer = scoop({ jid: 'scoop-stream', name: 'researcher' });
    const wiring = makeWiring({ selected: cone, scoops: [cone, streamer] });
    const callbacks = createWcLiveCallbacks(wiring);
    callbacks.onScoopActivity?.(streamer.jid);
    expect(wiring.refs.switcher.getAttribute('attention')).toBe(streamer.jid);
    // Selection is intentionally untouched — thread routing is owned elsewhere.
    expect(wiring.getSelected()).toBe(cone);
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
      1,
      // Non-actionable licks (webhook) carry no lickId.
      undefined
    );
  });

  it('flips an actionable lick state for the selected scoop only', () => {
    const wiring = makeWiring({ selected: cone });
    const callbacks = createWcLiveCallbacks(wiring);
    const update = { messageId: 'sudo-request-lick-1', lickId: 'lick-1', lickState: 'confirmed' };
    callbacks.onMessageUpdate?.(cone.jid, update as never);
    // A non-selected scoop's update is a no-op (its thread isn't mounted).
    callbacks.onMessageUpdate?.('other', update as never);
    // An update lacking lickId/lickState is ignored.
    callbacks.onMessageUpdate?.(cone.jid, { messageId: 'x' } as never);
    expect(wiring.controller.updateLickState).toHaveBeenCalledTimes(1);
    expect(wiring.controller.updateLickState).toHaveBeenCalledWith('lick-1', 'confirmed');
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

describe('wireWcChipTips (richer hover tooltips)', () => {
  function makeSwitcherWithChip(jid: string): { switcher: HTMLElement; chip: HTMLElement } {
    const switcher = document.createElement('slicc-scoop-switcher');
    const seed = document.createElement('slicc-pill');
    seed.className = 'scoop';
    seed.dataset.k = jid;
    switcher.appendChild(seed);
    document.body.appendChild(switcher);
    // The real switcher ADOPTS slotted pills and rebuilds them canonically —
    // re-query for the live chip instead of holding the detached seed.
    const chip = switcher.querySelector('slicc-pill.scoop') as HTMLElement;
    return { switcher, chip };
  }

  it('summarizes the scoop activity on hover and caches per snapshot', async () => {
    const { switcher, chip } = makeSwitcherWithChip('scoop-1');
    const lastActivity = new Map([['scoop-1', 'comparing tray-hub pricing pages']]);
    const labelFn = vi.fn(async () => 'Comparing tray-hub pricing pages for the report');
    wireWcChipTips({
      switcher,
      getScoops: () => [scoop({ jid: 'scoop-1', name: 'researcher' })],
      lastActivity,
      labelFn,
    });

    chip.dispatchEvent(new Event('pointerover', { bubbles: true }));
    // Instant fallback while the call runs…
    expect(chip.title).toBe('researcher');
    await vi.waitFor(() => {
      expect(chip.title).toBe('Comparing tray-hub pricing pages for the report');
    });
    expect(labelFn).toHaveBeenCalledTimes(1);
    expect(((labelFn.mock.calls[0] as unknown[])[0] as { prompt: string }).prompt).toContain(
      'comparing tray-hub pricing pages'
    );

    // Same activity snapshot → cached, no second call.
    chip.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(labelFn).toHaveBeenCalledTimes(1);

    // New activity → fresh summary.
    lastActivity.set('scoop-1', 'now writing the summary');
    chip.dispatchEvent(new Event('pointerover', { bubbles: true }));
    await vi.waitFor(() => {
      expect(labelFn).toHaveBeenCalledTimes(2);
    });
  });

  it('makes no LLM call for a scoop with no recorded activity', () => {
    const { switcher, chip } = makeSwitcherWithChip('cone-1');
    const labelFn = vi.fn(async () => 'never');
    wireWcChipTips({
      switcher,
      getScoops: () => [cone],
      lastActivity: new Map(),
      labelFn,
    });
    chip.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(chip.title).toBe('sliccy');
    expect(labelFn).not.toHaveBeenCalled();
  });
});

describe('parseProcStatLine', () => {
  // Regression coverage for the "processes never show as active" bug:
  // getProcesses() used to read the verbose /proc/<pid>/status dump
  // (`Name:\t...\nState:\tR (running)\n...`) and pass the whole multi-line
  // blob through as `status`. wc-monitor.ts's `proc.status === 'running'`
  // check could never match that, so the active/ended dot was always grey
  // regardless of real process state. The fix reads /proc/<pid>/stat (a
  // clean single-line record from proc-mount.ts's renderStat()) instead —
  // these tests pin the exact field-index parsing and letter→word mapping.

  it('parses a running process (state letter R)', () => {
    expect(parseProcStatLine('1024 (shell) R 1 - 1700000000000 -')).toBe('running');
  });

  it('parses a pending process (state letter S)', () => {
    expect(parseProcStatLine('1025 (jsh) S 1024 - 1700000000000 -')).toBe('pending');
  });

  it('parses an exited process (state letter Z)', () => {
    expect(parseProcStatLine('1026 (tool) Z 1024 0 1700000000000 1700000001000')).toBe('exited');
  });

  it('parses a killed process (state letter K)', () => {
    expect(parseProcStatLine('1027 (py) K 1024 137 1700000000000 1700000002000')).toBe('killed');
  });

  it('falls back to "unknown" for an unrecognized state letter', () => {
    expect(parseProcStatLine('1028 (net) ? 1024 - 1700000000000 -')).toBe('unknown');
  });

  it('falls back to "unknown" for a malformed/empty line', () => {
    expect(parseProcStatLine('')).toBe('unknown');
    expect(parseProcStatLine('1029')).toBe('unknown');
  });

  it('tolerates surrounding whitespace (as a real file read would include a trailing newline)', () => {
    expect(parseProcStatLine('1030 (shell) R 1 - 1700000000000 -\n')).toBe('running');
  });

  it('never returns the raw multi-line /proc/<pid>/status dump this bug used to produce', () => {
    // The exact shape of the OLD buggy input, to document why this
    // function exists at all — verbatim status-dump text is not a valid
    // stat line, so it can never accidentally parse as 'running'.
    const oldBuggyStatusDump = [
      'Name:\tshell',
      'Pid:\t1024',
      'PPid:\t1',
      'State:\tR (running)',
      'Owner:\tcone',
      'StartedAt:\t2026-01-01T00:00:00.000Z',
      'Cmdline:\tbash -lc "sleep 5"',
    ].join('\n');
    expect(parseProcStatLine(oldBuggyStatusDump)).not.toBe('running');
    expect(parseProcStatLine(oldBuggyStatusDump)).toBe('unknown');
  });
});
