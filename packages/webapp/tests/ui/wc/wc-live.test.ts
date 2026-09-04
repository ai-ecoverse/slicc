// @vitest-environment jsdom
/**
 * Tests for the live-mode wiring helpers: scoop→chip mapping and the kernel
 * callback factory, driven entirely with fakes (no worker, no CDP).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type { BootStageLogger } from '../../../src/ui/boot/types.js';
import {
  DEFAULT_DOCK_TREE_ON_BOOT,
  DOCK_TREE_STORAGE_KEY,
  prepareWcShell,
  wireDockTreePersistence,
  wireWcChipTips,
} from '../../../src/ui/wc/wc-live.js';
import {
  createWcLiveCallbacks,
  toSwitcherScoops,
  type WcLiveWiring,
} from '../../../src/ui/wc/wc-live-callbacks.js';
import { parseProcStatLine, parseProcTable } from '../../../src/ui/wc/wc-live-monitor-deps.js';
import {
  applyLeaderLocalThinkingChange,
  metaThinkingForScoop,
  thinkingLevelForAgent,
} from '../../../src/ui/wc/wc-live-thinking-hydration.js';
import { scoopColor } from '../../../src/ui/wc/wc-scoop-color.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';
import { recordToWorkUnitSummary } from '../../../src/work-unit/client/from-record.js';
import type { WorkUnitSummary } from '../../../src/work-unit/client/types.js';

function fakeLog(): BootStageLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as BootStageLogger;
}

function scoop(overrides: Partial<RegisteredScoop>): RegisteredScoop {
  return {
    jid: 'scoop-1',
    name: 'researcher',
    folder: 'researcher',
    isCone: false,
    parentJid: 'scoop-1',
    type: 'scoop',
    requiresTrigger: false,
    assistantLabel: 'researcher',
    addedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as RegisteredScoop;
}

/** The shell selects SUMMARIES; the fixtures still author records. */
function asUnit(record: RegisteredScoop): WorkUnitSummary {
  return recordToWorkUnitSummary(record, {});
}

const cone = scoop({
  jid: 'cone-1',
  name: 'sliccy',
  folder: 'cone',
  parentJid: null,
  assistantLabel: 'sliccy',
});

describe('wc-live compatibility re-exports', () => {
  it('keeps moved helpers available to existing importers', async () => {
    const live = await import('../../../src/ui/wc/wc-live.js');
    expect(live.createWcLiveCallbacks).toBe(createWcLiveCallbacks);
    expect(live.toSwitcherScoops).toBe(toSwitcherScoops);
    expect(live.applyLeaderLocalThinkingChange).toBe(applyLeaderLocalThinkingChange);
    expect(live.parseProcStatLine).toBe(parseProcStatLine);
  });
});

describe('leader-local thinking bridge', () => {
  it('notifies only after a successful persistence ack', async () => {
    let resolve!: (applied: boolean) => void;
    const setScoopThinkingLevel = vi.fn(() => new Promise<boolean>((done) => (resolve = done)));
    const notify = vi.fn();
    const pending = applyLeaderLocalThinkingChange(
      { setScoopThinkingLevel },
      'cone-1',
      'xhigh',
      'max',
      notify
    );

    expect(notify).not.toHaveBeenCalled();
    resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('does not notify when persistence returns false or times out', async () => {
    const notify = vi.fn();
    await expect(
      applyLeaderLocalThinkingChange(
        { setScoopThinkingLevel: vi.fn().mockResolvedValue(false) },
        'cone-1',
        'high',
        undefined,
        notify
      )
    ).resolves.toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('scoopColor / toSwitcherScoops', () => {
  it('gives the cone its fixed waffle color', () => {
    expect(scoopColor({ isRoot: true, name: cone.name })).toBe('#b07823');
  });

  it('assigns scoops a stable palette color by name', () => {
    const a = scoopColor({ isRoot: false, name: 'researcher' });
    expect(scoopColor({ isRoot: false, name: 'researcher' })).toBe(a);
    expect(a).toMatch(/^#/);
  });

  it('puts the cone first and labels it sliccy', () => {
    const chips = toSwitcherScoops([scoop({}), cone]);
    expect(chips[0]).toMatchObject({ key: 'cone-1', type: 'cone', label: 'sliccy' });
    expect(chips[1]).toMatchObject({ key: 'scoop-1', type: 'scoop', label: 'researcher' });
  });

  it('marks only the scoop that is waiting on the user as awaiting', () => {
    const chips = toSwitcherScoops([cone, scoop({})], undefined, undefined, undefined, cone.jid);
    expect(chips.find((c) => c.key === cone.jid)?.awaiting).toBe(true);
    expect(chips.find((c) => c.key === 'scoop-1')?.awaiting).toBeUndefined();
    // No one waiting is the common case and must stay absent, not `false`.
    expect(toSwitcherScoops([cone])[0]?.awaiting).toBeUndefined();
  });
});

interface FakeWiring extends WcLiveWiring {
  controller: {
    setProcessing: ReturnType<typeof vi.fn>;
    setLickBackpressure: ReturnType<typeof vi.fn>;
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
    setLickBackpressure: vi.fn(),
    addLickMessage: vi.fn(),
    updateLickState: vi.fn(),
    loadMessages: vi.fn(),
  };
  const switcher = document.createElement('slicc-agent-tabs') as WcShellRefs['switcher'];
  const thread = document.createElement('slicc-chat-thread');
  const refs = { switcher, thread } as unknown as WcShellRefs;
  let selected: WorkUnitSummary | null = options.selected ? asUnit(options.selected) : null;
  return {
    refs,
    controller,
    statuses: new Map(),
    fills: new Map(),
    phases: new Map(),
    lickBackpressure: new Map(),
    lastActivity: new Map(),
    pendingUrlContext: null,
    getController: () => controller as never,
    getClient: () =>
      ({
        getScoops: () => options.scoops ?? [],
        requestScoopMessages: vi.fn(),
      }) as never,
    getSelected: () => selected,
    selectScoop: vi.fn((unit: WorkUnitSummary) => {
      selected = unit;
    }),
  };
}

describe('toSwitcherScoops context fill', () => {
  it('maps 0..1 fills onto the pill 0-100 scale, reporting an unknown fill as 0', () => {
    const fills = new Map([[cone.jid, 0.42]]);
    const chips = toSwitcherScoops([cone, scoop({})], undefined, fills);
    expect(chips.find((c) => c.key === cone.jid)?.fill).toBe(42);
    // A unit with no measured fill reads as 0 rather than absent (#2274): the
    // wire has always sent 0 for it, the tabs clamp `undefined` to 0
    // (`boundedFill`), and one answer for both transports is the point of the
    // shared projection.
    expect(chips.find((c) => c.key === 'scoop-1')?.fill).toBe(0);
  });
});

describe('toSwitcherScoops runtime state', () => {
  it.each([
    { status: 'initializing', state: 'initializing' },
    { status: 'ready', state: 'idle' },
    { status: 'processing', state: 'working' },
    { status: 'error', state: 'broken' },
  ] as const)('maps $status to $state', ({ status, state }) => {
    const tabs = toSwitcherScoops([cone], new Map([[cone.jid, status]]));
    expect(tabs[0]?.state).toBe(state);
  });

  it('treats a missing first status broadcast as idle', () => {
    expect(toSwitcherScoops([cone])[0]?.state).toBe('idle');
  });
});

describe('toSwitcherScoops busy phase', () => {
  const processing = new Map([[cone.jid, 'processing' as const]]);

  it('forwards the phase of a processing scoop to its tab', () => {
    const tabs = toSwitcherScoops(
      [cone],
      processing,
      undefined,
      new Map([[cone.jid, 'tool' as const]])
    );
    expect(tabs[0]?.phase).toBe('tool');
  });

  it('leaves the phase unset when no crossing has been observed yet', () => {
    expect(toSwitcherScoops([cone], processing)[0]?.phase).toBeUndefined();
  });

  it('drops a stale phase once the scoop stops processing', () => {
    // The tab paints no pin at all when idle, so a leftover map entry must not
    // survive into the descriptor and shape one the next time it goes busy.
    const phases = new Map([[cone.jid, 'tool' as const]]);
    const tabs = toSwitcherScoops(
      [cone],
      new Map([[cone.jid, 'ready' as const]]),
      undefined,
      phases
    );
    expect(tabs[0]?.state).toBe('idle');
    expect(tabs[0]?.phase).toBeUndefined();
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

  it('stops awaiting the user as soon as the scoop works again, and exposes a refresh', () => {
    const wiring = makeWiring({ selected: cone, scoops: [cone] });
    const callbacks = createWcLiveCallbacks(wiring);
    // The factory hands the rest of the wiring a way to rebuild the row.
    expect(typeof wiring.refreshScoops).toBe('function');

    wiring.awaitingInput = cone.jid;
    wiring.refreshScoops?.();
    expect(wiring.refs.switcher.scoops[0]?.awaiting).toBe(true);

    callbacks.onStatusChange(cone.jid, 'processing' as never);
    expect(wiring.awaitingInput).toBeNull();
    expect(wiring.refs.switcher.scoops[0]?.awaiting).toBeUndefined();

    // A `ready` broadcast must NOT clear it — that is the state it waits in.
    wiring.awaitingInput = cone.jid;
    callbacks.onStatusChange(cone.jid, 'ready' as never);
    expect(wiring.awaitingInput).toBe(cone.jid);
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

  it('re-renders segment state across ready → processing → ready', () => {
    const worker = scoop({ jid: 'scoop-worker', name: 'worker' });
    const wiring = makeWiring({ selected: cone, scoops: [cone, worker] });
    const notifyScoopStateChanged = vi.fn();
    wiring.notifyScoopStateChanged = notifyScoopStateChanged;
    document.body.appendChild(wiring.refs.switcher);
    const callbacks = createWcLiveCallbacks(wiring);
    callbacks.onScoopListUpdate?.([cone, worker] as never);
    const segment = (): HTMLElement | null =>
      wiring.refs.switcher.querySelector(`[data-k="${worker.jid}"]`);

    callbacks.onStatusChange(worker.jid, 'ready' as never);
    expect(segment()?.dataset.state).toBe('idle');
    expect(notifyScoopStateChanged).not.toHaveBeenCalled();
    const idleSegment = segment();
    callbacks.onStatusChange(worker.jid, 'ready' as never);
    expect(segment()).toBe(idleSegment);
    expect(notifyScoopStateChanged).not.toHaveBeenCalled();

    callbacks.onStatusChange(worker.jid, 'processing' as never);
    expect(segment()?.dataset.state).toBe('working');
    expect(notifyScoopStateChanged).toHaveBeenCalledTimes(1);
    callbacks.onStatusChange(worker.jid, 'ready' as never);
    expect(segment()?.dataset.state).toBe('idle');
    expect(notifyScoopStateChanged).toHaveBeenCalledTimes(2);
    wiring.refs.switcher.remove();
  });

  it('caches lick backpressure for every scoop and renders only the selected scoop', () => {
    const researcher = scoop({ jid: 'scoop-r', name: 'researcher' });
    const wiring = makeWiring({ selected: researcher });
    const callbacks = createWcLiveCallbacks(wiring);
    callbacks.onLickBackpressure?.(researcher.jid, { count: 3, waitingMs: 300_000 });
    callbacks.onLickBackpressure?.('other-jid', { count: 2, waitingMs: 300_000 });
    expect(wiring.controller.setLickBackpressure).toHaveBeenCalledOnce();
    expect(wiring.controller.setLickBackpressure).toHaveBeenCalledWith(3, 300_000, 'researcher');
    expect(wiring.lickBackpressure.get('other-jid')).toEqual({ count: 2, waitingMs: 300_000 });
  });

  it('selects the first created scoop when nothing is selected', () => {
    const wiring = makeWiring({ selected: null, scoops: [cone] });
    const callbacks = createWcLiveCallbacks(wiring);
    callbacks.onScoopCreated(cone);
    expect(wiring.selectScoop).toHaveBeenCalledWith(asUnit(cone));
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
    expect(wiring.selectScoop).toHaveBeenCalledWith(asUnit(cone));
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
    expect(wiring.getSelected()?.id).toBe(cone.jid);
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

  it('renders preview lifecycle announcements as live lick messages', () => {
    const wiring = makeWiring({ selected: cone });
    const callbacks = createWcLiveCallbacks(wiring);
    const msg = {
      id: 'preview-1',
      content: 'Preview tab connected from https://example.test',
      channel: 'preview',
      timestamp: 1,
    };
    callbacks.onIncomingMessage(cone.jid, msg as never);
    expect(wiring.controller.addLickMessage).toHaveBeenCalledWith(
      'preview-1',
      'Preview tab connected from https://example.test',
      'preview',
      1,
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

  it('routes a replay onto the client protocol instead of the callback bag', () => {
    // The unit has to be in the roster: the adapter describes a snapshot from
    // the record, and holds a replay for a unit the page has not listed yet.
    const wiring = makeWiring({ selected: cone, scoops: [cone] });
    const callbacks = createWcLiveCallbacks(wiring);
    const seen: unknown[] = [];
    // The mount reads the transcript from `subscribe` now (#2382); the bag has
    // no `onScoopMessagesReplaced` handler of its own, and the ADAPTER is what
    // turns the kernel's envelope into a snapshot event.
    wiring.workUnits?.subscribe(cone.jid, (event) => {
      if (event.type === 'snapshot') seen.push(event.snapshot);
    });
    const messages = [{ id: 'h1' }];
    callbacks.onScoopMessagesReplaced?.(cone.jid, messages as never, ['q1']);
    expect(seen).toHaveLength(1);
    // The backend queue snapshot rides the same envelope (#2354/#2362).
    expect(seen[0]).toMatchObject({ messages, queuedIds: ['q1'] });
    // A replay for another unit reaches that unit's subscribers, not this one.
    callbacks.onScoopMessagesReplaced?.('other', [] as never);
    expect(seen).toHaveLength(1);
  });

  it('selects the cone when the kernel reports ready', () => {
    const wiring = makeWiring({ selected: null, scoops: [scoop({}), cone] });
    createWcLiveCallbacks(wiring).onReady?.();
    expect(wiring.selectScoop).toHaveBeenCalledWith(asUnit(cone));
  });
});

describe('prepareWcShell scoop selection', () => {
  it('reads the selected unit’s thinking level from its RECORD at the leaf (#2382 D2a)', async () => {
    // Selection is expressed in summaries, and a summary carries no reasoning
    // level — so the mount has to hand `applyThreadContext` a record lookup.
    // Without it the pill would silently go blank on every selection.
    const app = document.createElement('div');
    const boot = prepareWcShell(app, 'test');
    const record = scoop({
      jid: 'cone-thinking',
      name: 'sliccy',
      folder: 'cone',
      parentJid: null,
      thinking: { level: 'high' },
    });
    boot.setClient({
      selectedScoopJid: null,
      setSelectedScoopJid: vi.fn(),
      getScoops: vi.fn(() => [record]),
      requestScoopMessages: vi.fn(),
      isProcessing: vi.fn(() => false),
    } as never);

    boot.selectScoop(asUnit(record));
    await vi.waitFor(() => expect(boot.refs.composerMeta.getAttribute('thinking')).toBe('high'));
  });

  it('activates the selected tab before applying its shader context', () => {
    const app = document.createElement('div');
    const boot = prepareWcShell(app, 'test');
    const selected = scoop({ jid: 'scoop-order', name: 'order' });
    const writes: string[] = [];
    const switcherSetAttribute = boot.refs.switcher.setAttribute.bind(boot.refs.switcher);
    const shaderSetAttribute = boot.refs.shader.setAttribute.bind(boot.refs.shader);
    vi.spyOn(boot.refs.switcher, 'setAttribute').mockImplementation((name, value) => {
      if (name === 'active') writes.push(`switcher.active=${value}`);
      switcherSetAttribute(name, value);
    });
    vi.spyOn(boot.refs.shader, 'setAttribute').mockImplementation((name, value) => {
      if (name === 'mode' || name === 'tint') writes.push(`shader.${name}=${value}`);
      shaderSetAttribute(name, value);
    });
    boot.setClient({
      selectedScoopJid: null,
      setSelectedScoopJid: vi.fn(),
      getScoops: vi.fn(() => []),
      requestScoopMessages: vi.fn(),
      isProcessing: vi.fn(() => false),
    } as never);

    boot.selectScoop(asUnit(selected));

    expect(writes).toEqual([
      `switcher.active=${selected.jid}`,
      `shader.tint=${scoopColor({ isRoot: selected.parentJid === null, name: selected.name })}`,
      'shader.mode=scoop',
    ]);
  });

  it('republishes the switcher descriptors on selection, after the new selection lands (Codex P2)', () => {
    // The strip puts the SELECTED cone's scoops ahead of the rest
    // (`orderForSwitcher`), and nothing else recomputes that on a click — the
    // next roster/status event or the 15s stats poll would, which reads as the
    // strip ignoring the click. The refresh must also run AFTER `selected` is
    // updated, or it would re-publish the OLD ordering.
    const app = document.createElement('div');
    const boot = prepareWcShell(app, 'test');
    const selectedAtRefresh: Array<string | undefined> = [];
    boot.wiring.refreshScoops = () => selectedAtRefresh.push(boot.getSelected()?.id);
    boot.setClient({
      selectedScoopJid: null,
      setSelectedScoopJid: vi.fn(),
      getScoops: vi.fn(() => []),
      requestScoopMessages: vi.fn(),
      isProcessing: vi.fn(() => false),
    } as never);

    const research = scoop({ jid: 'cone-research', name: 'research' });
    boot.selectScoop(asUnit(research));
    expect(selectedAtRefresh).toEqual(['cone-research']);
  });

  it('shows cached backpressure when its scoop is selected and honors an unselected retraction', () => {
    const app = document.createElement('div');
    const boot = prepareWcShell(app, 'test');
    let noticeCount = 0;
    const controller = {
      getQueuedMessages: () => [],
      stashQueued: () => [],
      restoreQueued: vi.fn(),
      setReadOnly: vi.fn(),
      setLickBackpressure: vi.fn((count: number) => {
        noticeCount = count;
      }),
      setProcessing: vi.fn(),
    };
    let selectedScoopJid: string | null = null;
    const unresolvedMessageLoad = new Promise<never>(() => undefined);
    const first = scoop({ jid: 'scoop-a', name: 'first' });
    const second = scoop({ jid: 'scoop-b', name: 'second' });
    const client = {
      get selectedScoopJid() {
        return selectedScoopJid;
      },
      setSelectedScoopJid: vi.fn((jid: string) => {
        selectedScoopJid = jid;
      }),
      requestScoopMessages: vi.fn(() => unresolvedMessageLoad),
      isProcessing: vi.fn(() => false),
      deleteQueuedMessage: vi.fn(async () => undefined),
      getScoops: vi.fn(() => [first, second]),
    };
    boot.setController(controller as never);
    boot.setClient(client as never);
    boot.selectScoop(asUnit(second));
    const callbacks = createWcLiveCallbacks(boot.wiring);
    callbacks.onLickBackpressure?.(first.jid, {
      count: 3,
      waitingMs: 300_000,
    });
    expect(noticeCount).toBe(0);

    boot.selectScoop(asUnit(first));
    expect(noticeCount).toBe(3);
    expect(controller.setLickBackpressure).toHaveBeenLastCalledWith(3, 300_000, 'first');

    boot.selectScoop(asUnit(second));
    callbacks.onLickBackpressure?.(first.jid, { count: 0, waitingMs: 0 });
    boot.selectScoop(asUnit(first));
    expect(noticeCount).toBe(0);
    expect(controller.setLickBackpressure).toHaveBeenLastCalledWith(0, 0, 'first');
    expect(client.requestScoopMessages).toHaveBeenLastCalledWith(first.jid);
  });

  it('evicts cached backpressure when a scoop disappears from the registered list', () => {
    const wiring = makeWiring({ selected: cone, scoops: [cone] });
    const callbacks = createWcLiveCallbacks(wiring);
    callbacks.onLickBackpressure?.('removed-scoop', { count: 4, waitingMs: 300_000 });
    expect(wiring.lickBackpressure.has('removed-scoop')).toBe(true);

    callbacks.onScoopListUpdate([] as never);
    expect(wiring.lickBackpressure.has('removed-scoop')).toBe(false);
  });
});

describe('URL boot-context routing (pendingUrlContext)', () => {
  it('selects the URL scoop instead of the cone, then clears the pending context', () => {
    const target = scoop({ jid: 'scoop-r', name: 'researcher' });
    const wiring = makeWiring({ selected: null, scoops: [cone, target] });
    wiring.pendingUrlContext = 'scoop:researcher';
    createWcLiveCallbacks(wiring).onScoopListUpdate([] as never);
    expect(wiring.selectScoop).toHaveBeenCalledWith(asUnit(target));
    expect(wiring.pendingUrlContext).toBeNull();
  });

  it('falls back to the cone when the URL scoop is gone (dropped since)', () => {
    const wiring = makeWiring({ selected: null, scoops: [cone] });
    wiring.pendingUrlContext = 'scoop:long-gone';
    createWcLiveCallbacks(wiring).onScoopListUpdate([] as never);
    expect(wiring.selectScoop).toHaveBeenCalledWith(asUnit(cone));
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
    const switcher = document.createElement('slicc-agent-tabs');
    const chip = document.createElement('button');
    chip.className = 'slicc-agent-tabs__segment';
    chip.dataset.k = jid;
    document.body.appendChild(switcher);
    // Append after connection because the real light-DOM component performs
    // its initial canonical render from the `scoops` property when connected.
    switcher.appendChild(chip);
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

// Fake dockTree ref for the persistence tests: a plain div carrying a
// `setTree` spy — enough to drive `wireDockTreePersistence` without pulling
// in the real `@slicc/webcomponents` element.
function makeDockTreeRef(): HTMLElement & { setTree: ReturnType<typeof vi.fn> } {
  return Object.assign(document.createElement('div'), { setTree: vi.fn() });
}

describe('wireDockTreePersistence', () => {
  beforeEach(() => {
    localStorage.removeItem(DOCK_TREE_STORAGE_KEY);
  });

  it('boot restore seeds the default tree (a chat leaf in `left`, nothing else) when nothing is persisted', () => {
    const dockTree = makeDockTreeRef();
    const refs = { dockTree } as unknown as WcShellRefs;

    wireDockTreePersistence(refs, fakeLog());

    expect(dockTree.setTree).toHaveBeenCalledTimes(1);
    expect(dockTree.setTree).toHaveBeenCalledWith(DEFAULT_DOCK_TREE_ON_BOOT);
  });

  it('DEFAULT_DOCK_TREE_ON_BOOT contains only a chat leaf in the left zone — tool panels start closed', () => {
    expect(DEFAULT_DOCK_TREE_ON_BOOT.zones.left).toEqual({ type: 'leaf', surfaceId: 'chat' });
    expect(DEFAULT_DOCK_TREE_ON_BOOT.zones.top).toBeNull();
    expect(DEFAULT_DOCK_TREE_ON_BOOT.zones.middle).toBeNull();
    expect(DEFAULT_DOCK_TREE_ON_BOOT.zones.right).toBeNull();
    expect(DEFAULT_DOCK_TREE_ON_BOOT.zones.bottom).toBeNull();
  });

  it('boot restore parses and applies a persisted tree via setTree', () => {
    const persisted = {
      zones: {
        top: null,
        left: null,
        middle: { type: 'leaf', surfaceId: 'sprinkle:hero' },
        right: null,
        bottom: null,
      },
      rowFr: { top: 1, center: 1, bottom: 1 },
      colFr: { left: 1, middle: 1, right: 1 },
    };
    localStorage.setItem(DOCK_TREE_STORAGE_KEY, JSON.stringify(persisted));
    const dockTree = makeDockTreeRef();
    const refs = { dockTree } as unknown as WcShellRefs;

    wireDockTreePersistence(refs, fakeLog());

    expect(dockTree.setTree).toHaveBeenCalledWith(persisted);
  });

  it('falls back to the default tree when the persisted value is corrupt JSON (best-effort)', () => {
    localStorage.setItem(DOCK_TREE_STORAGE_KEY, '{not json');
    const dockTree = makeDockTreeRef();
    const refs = { dockTree } as unknown as WcShellRefs;
    const log = fakeLog();
    const warn = vi.spyOn(log, 'warn');

    expect(() => wireDockTreePersistence(refs, log)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(dockTree.setTree).toHaveBeenCalledWith(DEFAULT_DOCK_TREE_ON_BOOT);
  });

  it('a dock-tree-change event persists the new tree to localStorage', () => {
    const dockTree = makeDockTreeRef();
    const refs = { dockTree } as unknown as WcShellRefs;
    wireDockTreePersistence(refs, fakeLog());
    const tree = { zones: {}, rowFr: {}, colFr: {} };

    dockTree.dispatchEvent(
      new CustomEvent('dock-tree-change', { detail: { tree }, bubbles: true })
    );

    expect(JSON.parse(localStorage.getItem(DOCK_TREE_STORAGE_KEY) ?? 'null')).toEqual(tree);
  });

  it('a dock-tree-resize event also persists the new tree to localStorage', () => {
    const dockTree = makeDockTreeRef();
    const refs = { dockTree } as unknown as WcShellRefs;
    wireDockTreePersistence(refs, fakeLog());
    const tree = { zones: {}, rowFr: { top: 1.4, center: 1, bottom: 0.6 }, colFr: {} };

    dockTree.dispatchEvent(
      new CustomEvent('dock-tree-resize', { detail: { tree }, bubbles: true })
    );

    expect(JSON.parse(localStorage.getItem(DOCK_TREE_STORAGE_KEY) ?? 'null')).toEqual(tree);
  });

  it('a persist write failure (e.g. quota) is swallowed — best-effort, never throws', () => {
    const dockTree = makeDockTreeRef();
    const refs = { dockTree } as unknown as WcShellRefs;
    wireDockTreePersistence(refs, fakeLog());
    const original = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('quota exceeded');
    };
    try {
      expect(() =>
        dockTree.dispatchEvent(
          new CustomEvent('dock-tree-change', { detail: { tree: {} }, bubbles: true })
        )
      ).not.toThrow();
    } finally {
      localStorage.setItem = original;
    }
  });

  it('restoring a persisted tree via setTree does not trigger a persist write back to localStorage (no persist loop)', () => {
    const persisted = {
      zones: {
        top: null,
        left: null,
        middle: { type: 'leaf', surfaceId: 'sprinkle:hero' },
        right: null,
        bottom: null,
      },
      rowFr: { top: 1, center: 1, bottom: 1 },
      colFr: { left: 1, middle: 1, right: 1 },
    };
    localStorage.setItem(DOCK_TREE_STORAGE_KEY, JSON.stringify(persisted));
    const dockTree = makeDockTreeRef();
    const refs = { dockTree } as unknown as WcShellRefs;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    wireDockTreePersistence(refs, fakeLog());

    expect(dockTree.setTree).toHaveBeenCalledWith(persisted);
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });
});

describe('parseProcTable', () => {
  const doc = JSON.stringify({
    stats: { live: 2, retained: 4, terminated: 1435, spawned: 1437 },
    processes: [
      { pid: 1024, argv: 'sleep 9', status: 'running' },
      { pid: 1025, argv: 'rg --json x', status: 'pending' },
      { pid: 1026, argv: 'npm run lint', status: 'exited' },
      { pid: 1027, argv: 'tsc --noEmit', status: 'killed' },
    ],
  });

  it('keeps only live rows', () => {
    const snapshot = parseProcTable(doc);
    expect(snapshot.processes.map((p) => p.pid)).toEqual([1024, 1025]);
  });

  it('reports the session total, not the retained count', () => {
    // The whole point of the counter: 1,435 exited, only 2 dead records are
    // still resident, and the number the UI shows is the former.
    expect(parseProcTable(doc).terminated).toBe(1435);
  });

  it('degrades to an empty snapshot on malformed input', () => {
    expect(parseProcTable('not json')).toEqual({ processes: [], terminated: 0 });
    expect(parseProcTable('')).toEqual({ processes: [], terminated: 0 });
    expect(parseProcTable('{}')).toEqual({ processes: [], terminated: 0 });
    expect(parseProcTable('null')).toEqual({ processes: [], terminated: 0 });
  });

  it('tolerates rows missing fields', () => {
    const snapshot = parseProcTable(
      JSON.stringify({ stats: {}, processes: [{ status: 'running' }] })
    );
    expect(snapshot.processes).toEqual([{ pid: 0, argv: '', status: 'running' }]);
    expect(snapshot.terminated).toBe(0);
  });
});
