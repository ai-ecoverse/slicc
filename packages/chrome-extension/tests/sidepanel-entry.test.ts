// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { SwToPanelMessage } from '../src/cherry-panel-protocol.js';
import { createSidePanelController } from '../src/sidepanel-entry.js';

function makePort() {
  const listeners: Array<(m: unknown) => void> = [];
  const disc: Array<() => void> = [];
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (cb: (m: unknown) => void) => listeners.push(cb),
      removeListener: vi.fn(),
    },
    onDisconnect: { addListener: (cb: () => void) => disc.push(cb) },
    _emit: (m: SwToPanelMessage) => {
      for (const l of listeners) l(m);
    },
    _drop: () => {
      for (const d of disc) d();
    },
  };
}

describe('sidepanel-entry controller', () => {
  let iframe: HTMLIFrameElement;
  let statuses: string[];
  let mountSlicc: Mock;
  let destroy: Mock;
  let srcAtMount: string[]; // iframe.src observed at each mountSlicc call
  let port: ReturnType<typeof makePort>;

  beforeEach(() => {
    iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    statuses = [];
    destroy = vi.fn();
    srcAtMount = [];
    // Capture iframe.src AT mount time to prove blank-before-remount ordering
    // (destroy() does not clear caller iframes).
    mountSlicc = vi.fn(() => {
      srcAtMount.push(iframe.getAttribute('src') ?? '');
      return { iframe, emitHostEvent: vi.fn(), destroy };
    });
    port = makePort();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const make = () =>
    createSidePanelController({
      connect: () => port as never,
      mountSlicc: mountSlicc as never,
      iframe,
      setStatus: (s) => statuses.push(s),
      sliccOrigin: 'https://www.sliccy.ai',
    });

  it('sends hello on connect', () => {
    make();
    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'hello' });
  });

  it('booting → spinner, no mount', () => {
    make();
    port._emit({ kind: 'join-url', state: 'booting' });
    expect(mountSlicc).not.toHaveBeenCalled();
    expect(statuses).toContain('starting');
  });

  it('ready → mounts with uiOnly + chat features + joinToken', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    expect(mountSlicc).toHaveBeenCalledWith(
      expect.objectContaining({
        iframe,
        joinToken: 'https://tray/join/t.s',
        uiOnly: true,
        sliccOrigin: 'https://www.sliccy.ai',
        capabilities: { navigate: false, screenshot: 'none', openUrl: false },
        features: {
          terminal: false,
          files: false,
          memory: false,
          browser: false,
          newSprinkle: false,
          monitor: false,
          modelPicker: false,
          history: true,
          nav: true,
        },
      })
    );
  });

  it('ready → status live (overlay hidden so the follower owns its own sub-status)', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    // The panel does NOT keep a covering overlay after mount — the follower iframe
    // shows its own connecting/connected/"reload to retry" UI.
    expect(statuses[statuses.length - 1]).toBe('live');
  });

  it('duplicate identical ready is a no-op (no remount), stays live', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    expect(mountSlicc).toHaveBeenCalledTimes(1);
    expect(statuses[statuses.length - 1]).toBe('live');
  });

  it('post-eviction blip (ready → booting → same ready): re-shows live, no remount', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    port._emit({ kind: 'join-url', state: 'booting' }); // SW cache lost on eviction → overlay
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' }); // replay
    expect(mountSlicc).toHaveBeenCalledTimes(1); // NOT remounted
    expect(statuses[statuses.length - 1]).toBe('live'); // overlay hidden again
  });

  it('new ready joinUrl remounts: destroy + blank-BEFORE-mount + mount', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/a.1' });
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/b.2' });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(mountSlicc).toHaveBeenCalledTimes(2);
    // The 2nd mount must have observed the blanked iframe (ordering proof: the
    // stale follower was cleared before the new one mounted).
    expect(srcAtMount[1]).toBe('about:blank');
  });

  it('disconnected → destroy + blank iframe + disconnected status', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    port._emit({ kind: 'join-url', state: 'disconnected' });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(iframe.getAttribute('src')).toBe('about:blank');
    expect(statuses).toContain('disconnected');
  });

  it('reconnects (new port + re-sends hello) after the port drops', () => {
    vi.useFakeTimers();
    const ports = [makePort(), makePort()];
    let i = 0;
    createSidePanelController({
      connect: () => ports[i++] as never,
      mountSlicc: mountSlicc as never,
      iframe,
      setStatus: (s) => statuses.push(s),
      sliccOrigin: 'https://www.sliccy.ai',
    });
    expect(ports[0].postMessage).toHaveBeenCalledWith({ kind: 'hello' });
    ports[0]._drop(); // SW evicted / restarted
    vi.advanceTimersByTime(300); // backoff
    expect(ports[1].postMessage).toHaveBeenCalledWith({ kind: 'hello' });
    vi.useRealTimers();
  });

  it('boot watchdog: stuck on booting escalates to disconnected', () => {
    vi.useFakeTimers();
    make();
    port._emit({ kind: 'join-url', state: 'booting' });
    expect(statuses).toContain('starting');
    vi.advanceTimersByTime(20_000); // BOOT_TIMEOUT_MS
    expect(statuses[statuses.length - 1]).toBe('disconnected');
    vi.useRealTimers();
  });

  it('iframe watchdog: a follower that never loads escalates to disconnected', () => {
    vi.useFakeTimers();
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    expect(statuses[statuses.length - 1]).toBe('live'); // overlay hidden, follower shown
    vi.advanceTimersByTime(15_000); // IFRAME_LOAD_TIMEOUT_MS, no load event fired
    expect(statuses[statuses.length - 1]).toBe('disconnected');
    expect(destroy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('iframe watchdog is cancelled once the follower iframe loads', () => {
    vi.useFakeTimers();
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    iframe.setAttribute('src', 'https://www.sliccy.ai/?cherry=1'); // mountSlicc points it here
    iframe.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(30_000);
    expect(statuses[statuses.length - 1]).toBe('live'); // did NOT escalate
    vi.useRealTimers();
  });

  it('a booting blip while a follower is live does NOT cover it (stays live, no remount)', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    statuses.length = 0;
    port._emit({ kind: 'join-url', state: 'booting' }); // SW-eviction replay
    expect(statuses).toEqual(['live']); // stayed live; never showed 'starting'
    expect(mountSlicc).toHaveBeenCalledTimes(1);
  });

  it('survives connect() throwing (extension context invalidated) without crashing', () => {
    expect(() =>
      createSidePanelController({
        connect: () => {
          throw new Error('Extension context invalidated');
        },
        mountSlicc: mountSlicc as never,
        iframe,
        setStatus: (s) => statuses.push(s),
        sliccOrigin: 'https://www.sliccy.ai',
      })
    ).not.toThrow();
  });
});
