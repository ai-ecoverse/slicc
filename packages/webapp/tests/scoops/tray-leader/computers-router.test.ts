import type { ComputerDescriptor, ComputerFrame, ComputerInputEvent } from '@slicc/shared-ts';
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
        return watched.length;
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
  const addFollower = (
    bootstrapId: string,
    trust: 'full' | 'biscotto' = 'full',
    caps: { computer?: boolean; exec?: boolean; pairId?: string } = {}
  ): void => {
    const messages: LeaderToFollowerMessage[] = [];
    sent.set(bootstrapId, messages);
    followers.followers.set(bootstrapId, {
      bootstrapId,
      trust,
      peerPairId: caps.pairId,
      peerCapabilities:
        caps.computer || caps.exec
          ? { ...(caps.computer ? { computer: true } : {}), ...(caps.exec ? { exec: true } : {}) }
          : undefined,
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

  it('forwards computer.input to the store and drops biscotto', async () => {
    const events: ComputerInputEvent[] = [{ type: 'key', keysym: 'Home' }];
    const received: { id: string; events: ComputerInputEvent[] }[] = [];
    const harness = createSource([descriptor()]);
    harness.source.input = (id, ev) => {
      received.push({ id, events: ev });
    };
    const { router, addFollower } = createHarness(harness.source);
    addFollower('full');
    addFollower('guest', 'biscotto');
    router.handleInput('full', 'jsh:fake', events);
    router.handleInput('guest', 'jsh:fake', events);
    await vi.waitFor(() => expect(received).toEqual([{ id: 'jsh:fake', events }]));
  });

  it('fans computer.native messages to listeners', () => {
    const { router, addFollower } = createHarness();
    addFollower('full');
    const seen: string[] = [];
    const stop = router.onNative((_id, message) => {
      seen.push(message.type);
    });
    router.handleNative('full', {
      type: 'computer.native.error',
      requestId: 'cap-1',
      error: 'denied',
    });
    expect(seen).toEqual(['computer.native.error']);
    stop();
    router.handleNative('full', {
      type: 'computer.native.error',
      requestId: 'cap-2',
      error: 'later',
    });
    expect(seen).toEqual(['computer.native.error']);
  });

  it('resolves captureNative when the follower returns a JPEG frame', async () => {
    const { router, addFollower, sent } = createHarness();
    addFollower('mac', 'full', { computer: true });
    const pending = router.captureNative('mac', { maxWidth: 480, timeoutMs: 5_000 });
    const capture = sent.get('mac')?.find((m) => m.type === 'computer.native.capture');
    expect(capture).toMatchObject({
      type: 'computer.native.capture',
      maxWidth: 480,
      watch: false,
    });
    if (capture?.type !== 'computer.native.capture') {
      throw new Error('missing native capture');
    }
    router.handleNative('mac', {
      type: 'computer.native.frame',
      requestId: capture.requestId,
      seq: 1,
      mime: 'image/jpeg',
      width: 480,
      height: 270,
      nativeWidth: 1920,
      nativeHeight: 1080,
      data: 'abc',
    });
    await expect(pending).resolves.toEqual({
      jpeg: 'abc',
      mime: 'image/jpeg',
      width: 480,
      height: 270,
      nativeWidth: 1920,
      nativeHeight: 1080,
    });
  });

  it('rejects captureNative on follower error and missing computer cap', async () => {
    const { router, addFollower, sent } = createHarness();
    addFollower('plain');
    await expect(router.captureNative('plain')).rejects.toThrow('does not advertise computer');
    addFollower('mac', 'full', { computer: true });
    const pending = router.captureNative('mac', { timeoutMs: 5_000 });
    const capture = sent.get('mac')?.find((m) => m.type === 'computer.native.capture');
    if (capture?.type !== 'computer.native.capture') {
      throw new Error('missing native capture');
    }
    router.handleNative('mac', {
      type: 'computer.native.error',
      requestId: capture.requestId,
      error: 'Screen Recording is off — open System Settings',
    });
    await expect(pending).rejects.toThrow('System Settings');
    addFollower('guest', 'biscotto', { computer: true });
    await expect(router.captureNative('guest')).rejects.toThrow('cannot drive computer.native');
  });

  it('routes native capture and input at a paired CLI to its launcher', async () => {
    // `slicc … follow --computer`: the agent addresses the CLI, which captures
    // nothing itself — the frames have to come from the Sliccstart it spawned
    // (#3260).
    const { router, addFollower, sent } = createHarness();
    addFollower('cli', 'full', { exec: true, pairId: 'pair-a' });
    addFollower('mac', 'full', { computer: true, pairId: 'pair-a' });

    const pending = router.captureNative('cli', { timeoutMs: 5_000 });
    expect(sent.get('cli')).toEqual([]);
    const capture = sent.get('mac')?.find((m) => m.type === 'computer.native.capture');
    if (capture?.type !== 'computer.native.capture') {
      throw new Error('capture was not routed to the paired launcher');
    }
    router.handleNative('mac', {
      type: 'computer.native.frame',
      requestId: capture.requestId,
      seq: 1,
      mime: 'image/jpeg',
      width: 4,
      height: 2,
      nativeWidth: 8,
      nativeHeight: 4,
      data: 'abc',
    });
    await expect(pending).resolves.toMatchObject({ jpeg: 'abc' });

    router.unwatchNative('cli');
    expect(sent.get('mac')?.some((m) => m.type === 'computer.native.unwatch')).toBe(true);
  });

  it('still refuses an exec follower with no paired launcher', async () => {
    const { router, addFollower } = createHarness();
    addFollower('cli', 'full', { exec: true, pairId: 'pair-a' });
    await expect(router.captureNative('cli')).rejects.toThrow('does not advertise computer');
  });

  it('never folds a guest seat into a paired entry', async () => {
    // A biscotto that echoed the owner's token would otherwise take over the
    // roster entry native capture is routed to.
    const { router, addFollower } = createHarness();
    addFollower('cli', 'full', { exec: true, pairId: 'pair-a' });
    addFollower('guest', 'biscotto', { computer: true, pairId: 'pair-a' });
    await expect(router.captureNative('cli')).rejects.toThrow('does not advertise computer');
  });

  it('times out captureNative when no frame arrives', async () => {
    const { router, addFollower } = createHarness();
    addFollower('mac', 'full', { computer: true });
    await expect(router.captureNative('mac', { timeoutMs: 20 })).rejects.toThrow('timed out');
  });

  it('sends computer.native.input and unwatch to a computer follower', async () => {
    const { router, addFollower, sent } = createHarness();
    addFollower('mac', 'full', { computer: true });
    const pending = router.inputNative('mac', [{ type: 'key', keysym: 'Return' }]);
    router.unwatchNative('mac');
    expect(sent.get('mac')).toEqual([
      expect.objectContaining({
        type: 'computer.native.input',
        events: [{ type: 'key', keysym: 'Return' }],
      }),
      { type: 'computer.native.unwatch' },
    ]);
    const input = sent.get('mac')?.find((m) => m.type === 'computer.native.input');
    if (input?.type !== 'computer.native.input') throw new Error('missing native input');
    router.handleNative('mac', {
      type: 'computer.native.input.result',
      requestId: input.requestId,
    });
    await expect(pending).resolves.toBeUndefined();
  });

  it('names the display on computer.native.input when one is picked', () => {
    const { router, addFollower, sent } = createHarness();
    addFollower('mac', 'full', { computer: true });
    void router
      .inputNative('mac', [{ type: 'key', keysym: 'Return' }], { display: 3, timeoutMs: 5 })
      .catch(() => {});
    expect(sent.get('mac')?.[0]).toMatchObject({ type: 'computer.native.input', display: 3 });
  });

  it('rejects inputNative when the follower reports Accessibility denial', async () => {
    const { router, addFollower, sent } = createHarness();
    addFollower('mac', 'full', { computer: true });
    const pending = router.inputNative('mac', [{ type: 'key', keysym: 'Return' }], {
      timeoutMs: 5_000,
    });
    const input = sent.get('mac')?.find((m) => m.type === 'computer.native.input');
    if (input?.type !== 'computer.native.input') throw new Error('missing native input');
    router.handleNative('mac', {
      type: 'computer.native.input.result',
      requestId: input.requestId,
      error:
        'Accessibility is not allowed. Grant it in System Settings → Privacy & Security → Accessibility, then try again.',
    });
    await expect(pending).rejects.toThrow(/Accessibility is not allowed/);
    await expect(pending).rejects.toThrow(/System Settings/);
  });

  it('rejects inputNative when computer.native.error matches the request', async () => {
    const { router, addFollower, sent } = createHarness();
    addFollower('mac', 'full', { computer: true });
    const pending = router.inputNative(
      'mac',
      [{ type: 'click', button: 1, count: 1, x: 1, y: 1 }],
      { timeoutMs: 5_000 }
    );
    const input = sent.get('mac')?.find((m) => m.type === 'computer.native.input');
    if (input?.type !== 'computer.native.input') throw new Error('missing native input');
    router.handleNative('mac', {
      type: 'computer.native.error',
      requestId: input.requestId,
      error: 'Accessibility is not allowed. Grant it in System Settings.',
    });
    await expect(pending).rejects.toThrow(/Accessibility is not allowed/);
  });

  it('drops incomplete native frames when the follower is removed', async () => {
    const { router, addFollower, sent } = createHarness();
    addFollower('mac', 'full', { computer: true });
    const pending = router.captureNative('mac', { timeoutMs: 40 });
    const capture = sent.get('mac')?.find((m) => m.type === 'computer.native.capture');
    if (capture?.type !== 'computer.native.capture') throw new Error('missing native capture');
    router.handleNative('mac', {
      type: 'computer.native.frame',
      requestId: capture.requestId,
      seq: 1,
      mime: 'image/jpeg',
      width: 8,
      height: 8,
      nativeWidth: 8,
      nativeHeight: 8,
      chunkData: 'AA',
      chunkIndex: 0,
      totalChunks: 2,
    });
    router.removeFollower('mac');
    router.handleNative('mac', {
      type: 'computer.native.frame',
      requestId: capture.requestId,
      seq: 1,
      mime: 'image/jpeg',
      width: 8,
      height: 8,
      nativeWidth: 8,
      nativeHeight: 8,
      chunkData: 'BB',
      chunkIndex: 1,
      totalChunks: 2,
    });
    await expect(pending).rejects.toThrow('timed out');
  });
});
