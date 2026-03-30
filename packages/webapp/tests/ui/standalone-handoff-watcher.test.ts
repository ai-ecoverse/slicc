import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StandaloneHandoffWatcher } from '../../src/ui/standalone-handoff-watcher.js';
import type { BrowserAPI } from '../../src/cdp/index.js';

function buildHandoffUrl(
  payload: Record<string, unknown>,
  origin = 'https://www.sliccy.ai'
): string {
  return `${origin}/handoff#${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function createBrowserMock() {
  let pages: Array<{ targetId: string; title: string; url: string }> = [];
  const eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  const transport = {
    send: vi.fn(async () => ({})),
    on: vi.fn((event: string, handler: (params: Record<string, unknown>) => void) => {
      let handlers = eventHandlers.get(event);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(event, handlers);
      }
      handlers.add(handler);
    }),
    off: vi.fn((event: string, handler: (params: Record<string, unknown>) => void) => {
      eventHandlers.get(event)?.delete(handler);
    }),
  };

  return {
    listPages: vi.fn(async () => pages),
    getTransport: () => transport,
    setPages(nextPages: Array<{ targetId: string; title: string; url: string }>) {
      pages = nextPages;
    },
    emit(event: string, params: Record<string, unknown>) {
      const handlers = eventHandlers.get(event);
      if (!handlers) return;
      for (const handler of handlers) {
        handler(params);
      }
    },
    transport,
  } as unknown as BrowserAPI & {
    setPages: (nextPages: Array<{ targetId: string; title: string; url: string }>) => void;
    emit: (event: string, params: Record<string, unknown>) => void;
    transport: {
      send: ReturnType<typeof vi.fn>;
    };
  };
}

describe('StandaloneHandoffWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('hydrates pending handoffs from already-open tabs and enables discovery', async () => {
    const browser = createBrowserMock();
    browser.setPages([
      {
        targetId: 'page-1',
        title: 'handoff',
        url: buildHandoffUrl({ instruction: 'Hydrate from startup scan.' }),
      },
    ]);
    const snapshots: string[][] = [];
    const watcher = new StandaloneHandoffWatcher({
      browser,
      onPendingHandoffsChange: (handoffs) => {
        snapshots.push(handoffs.map((handoff) => handoff.payload.instruction));
      },
    });

    await watcher.start();

    expect(snapshots).toEqual([['Hydrate from startup scan.']]);
    expect(browser.transport.send).toHaveBeenCalledWith('Target.setDiscoverTargets', {
      discover: true,
    });

    watcher.stop();
  });

  it('dedupes duplicate tabs for the same handoff and preserves all source targets', async () => {
    const browser = createBrowserMock();
    const url = buildHandoffUrl({ instruction: 'Handle duplicate tabs.' });
    const snapshots: number[] = [];
    const pendingHandoffIds: string[] = [];
    const watcher = new StandaloneHandoffWatcher({
      browser,
      onPendingHandoffsChange: (handoffs) => {
        snapshots.push(handoffs.length);
        if (handoffs[0]) pendingHandoffIds.push(handoffs[0].handoffId);
      },
    });

    await watcher.start();
    browser.emit('Target.targetCreated', {
      targetInfo: { targetId: 'page-1', type: 'page', title: 'first', url },
    });
    browser.emit('Target.targetCreated', {
      targetInfo: { targetId: 'page-2', type: 'page', title: 'second', url },
    });

    const cleared = watcher.clearHandoff(pendingHandoffIds.at(-1)!);

    expect(snapshots).toEqual([1, 1, 0]);
    expect(cleared.targetIds.sort()).toEqual(['page-1', 'page-2']);

    watcher.stop();
  });

  it('detects navigation into a handoff URL and removes stale mappings when the tab closes', async () => {
    const browser = createBrowserMock();
    const snapshots: Array<{ handoffIds: string[]; instructions: string[] }> = [];
    const watcher = new StandaloneHandoffWatcher({
      browser,
      onPendingHandoffsChange: (handoffs) => {
        snapshots.push({
          handoffIds: handoffs.map((handoff) => handoff.handoffId),
          instructions: handoffs.map((handoff) => handoff.payload.instruction),
        });
      },
    });

    await watcher.start();
    browser.emit('Target.targetInfoChanged', {
      targetInfo: {
        targetId: 'page-9',
        type: 'page',
        title: 'changed',
        url: buildHandoffUrl({ instruction: 'Catch navigation changes.' }),
      },
    });
    browser.emit('Target.targetDestroyed', { targetId: 'page-9' });

    expect(snapshots).toEqual([
      {
        handoffIds: [snapshots[0]?.handoffIds[0] ?? ''],
        instructions: ['Catch navigation changes.'],
      },
      {
        handoffIds: [],
        instructions: [],
      },
    ]);

    watcher.stop();
  });

  it('reconciles missed events on the 5-second safety-net interval', async () => {
    const browser = createBrowserMock();
    const snapshots: string[][] = [];
    const watcher = new StandaloneHandoffWatcher({
      browser,
      onPendingHandoffsChange: (handoffs) => {
        snapshots.push(handoffs.map((handoff) => handoff.payload.instruction));
      },
    });

    await watcher.start();

    browser.setPages([
      {
        targetId: 'page-12',
        title: 'handoff',
        url: buildHandoffUrl({ instruction: 'Recover from missed event.' }),
      },
    ]);
    await vi.advanceTimersByTimeAsync(5000);

    browser.setPages([]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(snapshots).toEqual([['Recover from missed event.'], []]);
    expect(browser.transport.send).toHaveBeenCalledTimes(3);

    watcher.stop();
  });
});
