// @vitest-environment jsdom
/**
 * The stop of slicc#4051: a six page holds `slicc-six-kernel` shared, stops
 * on the exporter's broadcast (kernel, tray, moved notice, then the lock),
 * and the exporter gets the lock exclusive only after that. A page booting
 * while the exporter runs shows the notice and boots nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSixUpgradeStop } from '../../src/ui/boot/setup-six-upgrade-stop.js';
import {
  claimSixKernelLock,
  holdSixKernelLock,
  installSixUpgradeStopListener,
  registerSixKernelStop,
  resetSixUpgradeStopForTests,
  SEVEN_OS_PATH,
  SIX_KERNEL_LOCK,
  SIX_MOVED_TEXT,
  SIX_UPGRADE_CHANNEL,
  stopSixPageForUpgrade,
} from '../../src/ui/six-upgrade-stop.js';
import {
  registerTrayLeaderFatalCleanup,
  resetTrayLeaderFatalForTests,
} from '../../src/ui/tray-leader-fatal.js';
import {
  runSixUpgradeExport,
  SIX_STOP_TIMEOUT_ERROR,
  type SixUpgradeMessage,
  stopSixPages,
} from '../../src/ui/upgrade-to-seven/exporter.js';
import { FakeChannelBus, FakeWebLocks } from './fake-web-locks.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetSixUpgradeStopForTests();
  resetTrayLeaderFatalForTests();
  document.body.innerHTML = '<div id="app">six</div>';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the names seven relies on', () => {
  it('are slicc-six-upgrade and slicc-six-kernel', () => {
    expect(SIX_UPGRADE_CHANNEL).toBe('slicc-six-upgrade');
    expect(SIX_KERNEL_LOCK).toBe('slicc-six-kernel');
  });
});

describe('claimSixKernelLock', () => {
  it('takes the lock shared, so many six pages hold it at once', async () => {
    const locks = new FakeWebLocks();
    const a = await claimSixKernelLock(locks);
    const b = await claimSixKernelLock(locks);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(locks.heldModes(SIX_KERNEL_LOCK)).toEqual(['shared', 'shared']);
    a!.release();
    b!.release();
    await flush();
    expect(locks.heldModes(SIX_KERNEL_LOCK)).toEqual([]);
  });

  it('gets nothing while the exporter waits for the lock', async () => {
    const locks = new FakeWebLocks();
    const six = await claimSixKernelLock(locks);
    void locks.request(SIX_KERNEL_LOCK, { mode: 'exclusive' }, () => new Promise(() => {}));
    expect(await claimSixKernelLock(locks)).toBeNull();
    six!.release();
  });

  it('runs as before without Web Locks', async () => {
    expect(await claimSixKernelLock(null)).not.toBeNull();
  });
});

describe('a six page on the stop broadcast', () => {
  it('terminates its kernel, stops its tray, shows the moved notice, then releases the lock', async () => {
    const bus = new FakeChannelBus();
    const locks = new FakeWebLocks();
    const order: string[] = [];
    expect(await setupSixUpgradeStop(document, { locks, channel: bus.open() })).toBe(false);
    registerSixKernelStop(() => {
      order.push('kernel');
    });
    registerTrayLeaderFatalCleanup(() => {
      order.push('tray');
    });
    expect(locks.heldModes(SIX_KERNEL_LOCK)).toEqual(['shared']);

    bus.open().postMessage({ type: 'stop' });
    await flush();

    expect(order).toEqual(['kernel', 'tray']);
    const notice = document.getElementById('slicc-six-moved')!;
    expect(notice.textContent).toContain(SIX_MOVED_TEXT);
    expect(notice.querySelector('a')!.getAttribute('href')).toBe(SEVEN_OS_PATH);
    expect(document.getElementById('app')).toBeNull();
    expect(locks.heldModes(SIX_KERNEL_LOCK)).toEqual([]);
  });

  it('ignores other messages on the channel', async () => {
    const bus = new FakeChannelBus();
    const locks = new FakeWebLocks();
    const kernel = vi.fn();
    await setupSixUpgradeStop(document, { locks, channel: bus.open() });
    registerSixKernelStop(kernel);
    bus.open().postMessage({ type: 'slicc-six-upgrade', phase: 'reading' });
    await flush();
    expect(kernel).not.toHaveBeenCalled();
    expect(locks.heldModes(SIX_KERNEL_LOCK)).toEqual(['shared']);
  });

  it('releases the lock only after the kernel finished flushing', async () => {
    const bus = new FakeChannelBus();
    const locks = new FakeWebLocks();
    let flushed!: () => void;
    await setupSixUpgradeStop(document, { locks, channel: bus.open() });
    registerSixKernelStop(
      () =>
        new Promise<void>((resolve) => {
          flushed = resolve;
        })
    );
    bus.open().postMessage({ type: 'stop' });
    await flush();
    // The notice is up at once, but the exporter must still wait.
    expect(document.getElementById('slicc-six-moved')).not.toBeNull();
    expect(locks.heldModes(SIX_KERNEL_LOCK)).toEqual(['shared']);
    flushed();
    await flush();
    expect(locks.heldModes(SIX_KERNEL_LOCK)).toEqual([]);
  });

  it('keeps the lock when the kernel could not confirm its flush', async () => {
    const bus = new FakeChannelBus();
    const locks = new FakeWebLocks();
    await setupSixUpgradeStop(document, { locks, channel: bus.open() });
    registerSixKernelStop(async () => false);
    bus.open().postMessage({ type: 'stop' });
    await flush();
    await flush();
    expect(document.getElementById('slicc-six-moved')).not.toBeNull();
    // The exporter's wait then times out and the upgrade fails instead.
    expect(locks.heldModes(SIX_KERNEL_LOCK)).toEqual(['shared']);
  });

  it('terminates a kernel spawned after the stop at once', async () => {
    installSixUpgradeStopListener(document, null);
    await stopSixPageForUpgrade();
    const kernel = vi.fn();
    registerSixKernelStop(kernel);
    expect(kernel).toHaveBeenCalledOnce();
  });

  it('releases a lock it is handed after the stop', async () => {
    await stopSixPageForUpgrade();
    const release = vi.fn();
    holdSixKernelLock(release);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('a six page booting while the exporter runs', () => {
  it('shows the moved notice and must not boot', async () => {
    const locks = new FakeWebLocks();
    void locks.request(SIX_KERNEL_LOCK, { mode: 'exclusive' }, () => new Promise(() => {}));
    expect(await setupSixUpgradeStop(document, { locks, channel: null })).toBe(true);
    expect(document.body.textContent).toContain(SIX_MOVED_TEXT);
  });
});

describe('stopSixPages (the exporter)', () => {
  it('broadcasts stop, and gets the lock exclusive only once the six page let go', async () => {
    const bus = new FakeChannelBus();
    const locks = new FakeWebLocks();
    const kernel = vi.fn();
    await setupSixUpgradeStop(document, { locks, channel: bus.open() });
    registerSixKernelStop(kernel);

    let acquired = false;
    const stopping = stopSixPages({
      post: () => {},
      channel: bus.open(),
      locks,
      plan: async () => {
        throw new Error('unused');
      },
      openWriter: async () => {
        throw new Error('unused');
      },
    }).then(() => {
      acquired = true;
    });
    expect(bus.posted).toEqual([{ type: 'stop' }]);
    await stopping;
    expect(acquired).toBe(true);
    expect(kernel).toHaveBeenCalledOnce();
    expect(locks.heldModes(SIX_KERNEL_LOCK)).toEqual(['exclusive']);
    // A page that boots now gets no lock, so it never spawns a kernel.
    expect(await claimSixKernelLock(locks)).toBeNull();
  });

  it('waits for every holder, re-sending the stop while it waits', async () => {
    const bus = new FakeChannelBus();
    const locks = new FakeWebLocks();
    const late = await claimSixKernelLock(locks);
    let tick: (() => void) | null = null;
    let done = false;
    const stopping = stopSixPages({
      post: () => {},
      channel: bus.open(),
      locks,
      plan: async () => {
        throw new Error('unused');
      },
      openWriter: async () => {
        throw new Error('unused');
      },
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        tick = null;
      },
    }).then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    tick!();
    expect(bus.posted).toEqual([{ type: 'stop' }, { type: 'stop' }]);
    late!.release();
    await stopping;
    expect(done).toBe(true);
    expect(tick).toBeNull();
  });

  it('asks older six builds to reload, only after this build stopped and flushed', async () => {
    const bus = new FakeChannelBus();
    const locks = new FakeWebLocks();
    const events: string[] = [];
    const page = await claimSixKernelLock(locks);
    const legacy = {
      postMessage: (m: unknown) => events.push(`legacy:${(m as { type: string }).type}`),
      close: () => events.push('legacy:closed'),
    };
    const stopping = stopSixPages({
      post: () => {},
      channel: bus.open(),
      locks,
      legacyReloadChannel: legacy,
      legacySettleMs: 1,
      plan: async () => {
        throw new Error('unused');
      },
      openWriter: async () => {
        throw new Error('unused');
      },
    }).then(() => events.push('read'));
    await flush();
    expect(events).toEqual([]);
    events.push('page released');
    page!.release();
    await stopping;
    expect(events).toEqual(['page released', 'legacy:nuke-reload', 'legacy:closed', 'read']);
  });

  it('gives up when a page never stops', async () => {
    const locks = new FakeWebLocks();
    await claimSixKernelLock(locks);
    const posts: SixUpgradeMessage[] = [];
    await runSixUpgradeExport({
      post: (m) => posts.push(m),
      channel: null,
      locks,
      stopTimeoutMs: 5,
      plan: async () => {
        throw new Error('must not read a live profile');
      },
      openWriter: async () => {
        throw new Error('unused');
      },
    });
    expect(posts.at(-1)).toEqual({ type: 'slicc-six-upgrade', error: SIX_STOP_TIMEOUT_ERROR });
    expect(locks.queued(SIX_KERNEL_LOCK)).toBe(0);
  });
});
