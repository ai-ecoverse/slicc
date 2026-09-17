import type { ComputerDescriptor, ComputerFrame } from '@slicc/shared-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import {
  ComputersRouter,
  type TrayComputersSource,
} from '../../../src/scoops/tray-leader/computers-router.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { LeaderToFollowerMessage } from '../../../src/scoops/tray-sync-protocol.js';

function descriptor(id = 'jsh:fake'): ComputerDescriptor {
  return {
    id,
    kind: 'jsh',
    title: 'fake',
    size: { width: 8, height: 8 },
    state: 'live',
    capabilities: {
      screenshot: true,
      text: false,
      frames: 'poll',
      keyboard: true,
      mouse: 'absolute',
      scroll: true,
      exec: false,
      inputAllowed: true,
    },
    pid: null,
  };
}

function frame(seq = 1): ComputerFrame {
  return {
    seq,
    mime: 'image/jpeg',
    width: 8,
    height: 8,
    bytes: new Uint8Array([1, 2, 3]),
  };
}

function createSource(initial: ComputerDescriptor[] = []): {
  source: TrayComputersSource;
  watched: string[];
  unwatched: string[];
  emitList: (next: ComputerDescriptor[]) => void;
  emitFrame: (id: string, next: ComputerFrame) => void;
  setLast: (id: string, next: ComputerFrame) => void;
} {
  let computers = initial.slice();
  const frames = new Map<string, ComputerFrame>();
  const listListeners = new Set<(computers: ComputerDescriptor[]) => void>();
  const frameListeners = new Set<(id: string, next: ComputerFrame) => void>();
  const watched: string[] = [];
  const unwatched: string[] = [];
  return {
    watched,
    unwatched,
    source: {
      list: () => computers.slice(),
      onList: (listener) => {
        listListeners.add(listener);
        return () => listListeners.delete(listener);
      },
      onFrame: (listener) => {
        frameListeners.add(listener);
        return () => frameListeners.delete(listener);
      },
      lastFrame: (id) => frames.get(id) ?? null,
      watch: (id) => {
        watched.push(id);
      },
      unwatch: (id) => {
        unwatched.push(id);
      },
    },
    emitList: (next) => {
      computers = next.slice();
      for (const listener of listListeners) listener(computers);
    },
    emitFrame: (id, next) => {
      frames.set(id, next);
      for (const listener of frameListeners) listener(id, next);
    },
    setLast: (id, next) => {
      frames.set(id, next);
    },
  };
}

function createHarness(computers?: TrayComputersSource) {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const sent = new Map<string, LeaderToFollowerMessage[]>();
  const addFollower = (bootstrapId: string, trust: 'full' | 'biscotto' = 'full'): void => {
    const messages: LeaderToFollowerMessage[] = [];
    sent.set(bootstrapId, messages);
    followers.followers.set(bootstrapId, {
      bootstrapId,
      trust,
      sync: {
        send: vi.fn((message: LeaderToFollowerMessage) => {
          messages.push(message);
          return true;
        }),
      },
    } as unknown as ConnectedFollower);
  };
  const options = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    computers,
  } satisfies LeaderSyncManagerOptions;
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  const router = new ComputersRouter(context);
  router.start();
  return { router, addFollower, sent, log };
}

describe('ComputersRouter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends computers.list to a full-trust follower and withholds it from a biscotto', () => {
    const { source } = createSource([descriptor()]);
    const { router, addFollower, sent } = createHarness(source);
    addFollower('full');
    addFollower('guest', 'biscotto');
    router.sendListToFollower('full');
    router.sendListToFollower('guest');
    expect(sent.get('full')).toEqual([{ type: 'computers.list', computers: [descriptor()] }]);
    expect(sent.get('guest')).toEqual([]);
  });

  it('watches the store once for two followers and fans frames at 2 fps', () => {
    const harness = createSource([descriptor()]);
    const { router, addFollower, sent } = createHarness(harness.source);
    addFollower('a');
    addFollower('b');
    router.handleWatch('a', 'jsh:fake');
    router.handleWatch('b', 'jsh:fake');
    expect(harness.watched).toEqual(['jsh:fake']);

    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    harness.emitFrame('jsh:fake', frame(1));
    vi.spyOn(Date, 'now').mockReturnValue(1_100);
    harness.emitFrame('jsh:fake', frame(2));
    vi.spyOn(Date, 'now').mockReturnValue(1_600);
    harness.emitFrame('jsh:fake', frame(3));

    const framesA = sent.get('a')?.filter((m) => m.type === 'computer.frame') ?? [];
    expect(framesA.map((m) => (m.type === 'computer.frame' ? m.seq : null))).toEqual([1, 3]);
    const framesB = sent.get('b')?.filter((m) => m.type === 'computer.frame') ?? [];
    expect(framesB).toHaveLength(2);

    router.handleUnwatch('a', 'jsh:fake');
    expect(harness.unwatched).toEqual([]);
    router.removeFollower('b');
    expect(harness.unwatched).toEqual(['jsh:fake']);
  });

  it('sends the last cached frame immediately on watch', () => {
    const harness = createSource([descriptor()]);
    harness.setLast('jsh:fake', frame(9));
    const { router, addFollower, sent } = createHarness(harness.source);
    addFollower('a');
    router.handleWatch('a', 'jsh:fake');
    expect(sent.get('a')?.[0]).toMatchObject({ type: 'computer.frame', seq: 9, data: 'AQID' });
  });

  it('drops watches when a computer leaves the roster', () => {
    const harness = createSource([descriptor()]);
    const { router, addFollower } = createHarness(harness.source);
    addFollower('a');
    router.handleWatch('a', 'jsh:fake');
    harness.emitList([]);
    expect(harness.unwatched).toEqual(['jsh:fake']);
  });
});
