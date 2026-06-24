// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.sliccy.ai/join/tray-1.cap-token" }
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartPageFollowerTrayOptions } from '../../../src/ui/page-follower-tray.js';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

// Spy on the kernel-worker spawn to PROVE the follower path never calls it.
const spawnSpy = vi.fn();
vi.mock('../../../src/kernel/spawn.js', () => ({
  spawnKernelWorker: (...args: unknown[]) => spawnSpy(...args),
}));

const startFollowerSpy = vi.fn((_options: StartPageFollowerTrayOptions) => ({
  stop: vi.fn(),
  currentSync: null,
}));
vi.mock('../../../src/ui/page-follower-tray.js', () => ({
  startPageFollowerTray: (options: StartPageFollowerTrayOptions) => startFollowerSpy(options),
  CHERRY_RUNTIME_TAG: 'slicc-cherry',
}));

vi.mock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
  setupStandalonePrelude: vi.fn(async () => ({
    browser: { getTransport: () => ({}), listPages: async () => [] },
    realCdpTransport: {
      on: vi.fn(),
      off: vi.fn(),
      send: vi.fn(async () => ({})),
    },
    cherryJoinUrl: undefined,
    cherryTransport: undefined,
    instanceId: 'i',
  })),
}));

describe('mountWcUiFollower', () => {
  beforeEach(() => {
    spawnSpy.mockClear();
    startFollowerSpy.mockClear();
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('starts the follower tray and NEVER spawns the kernel worker', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    expect(startFollowerSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).not.toHaveBeenCalled();
    // The follower tray was handed the page BrowserAPI + a non-cherry runtime tag.
    const opts = startFollowerSpy.mock.calls[0]![0];
    expect(opts.runtime).toBe('slicc-standalone');
    expect(opts.browserAPI).toBeTruthy();
  });

  it('replaces the inert Files/Terminal panels with a placeholder (no local VFS/shell)', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');

    // The file tree is never wired in follower mode — it's hidden…
    const fileTree = app.querySelector('slicc-file-tree') as HTMLElement | null;
    expect(fileTree).toBeTruthy();
    expect(fileTree!.style.display).toBe('none');

    // …and explanatory placeholders take the Files + Terminal panels.
    const texts = Array.from(app.querySelectorAll('.wcui-placeholder')).map(
      (e) => e.textContent ?? ''
    );
    expect(texts.some((t) => t.includes('Files live on the leader'))).toBe(true);
    expect(texts.some((t) => t.includes('The shell runs on the leader'))).toBe(true);
  });

  it('disables the composer with a connecting placeholder until the leader connects', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;

    // Pre-connect: disabled, "Connecting to leader…" — input can't be silently dropped.
    expect(inputCard.hasAttribute('disabled')).toBe(true);
    expect(inputCard.getAttribute('placeholder')).toBe('Connecting to leader…');

    // On connect, the tray fires onConnectionChange(true) → enabled + normal placeholder.
    const opts = startFollowerSpy.mock.calls[0]![0];
    opts.onConnectionChange?.(true);
    expect(inputCard.hasAttribute('disabled')).toBe(false);
    expect(inputCard.getAttribute('placeholder')).toBe('Ask the leader, or describe a change…');

    // A disconnect re-disables + re-shows connecting.
    opts.onConnectionChange?.(false);
    expect(inputCard.hasAttribute('disabled')).toBe(true);
    expect(inputCard.getAttribute('placeholder')).toBe('Connecting to leader…');
  });

  it('shows a terminal "reload to retry" state when the tray gives up', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const opts = startFollowerSpy.mock.calls[0]![0];
    opts.onGaveUp?.(new Error('bad join url'));
    expect(inputCard.hasAttribute('disabled')).toBe(true);
    expect(inputCard.getAttribute('placeholder')).toBe(
      "Couldn't reach the leader. Reload to retry."
    );
  });

  it('the avatar-menu "Disconnect from leader" action dispatches slicc:tray-leave', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');

    const leaveSpy = vi.fn();
    window.addEventListener('slicc:tray-leave', leaveSpy);
    const avatarMenu = app.querySelector('slicc-avatar-menu')!;
    avatarMenu.dispatchEvent(
      new CustomEvent('slicc-avatar-action', { detail: { id: 'tray-stop' } })
    );
    window.removeEventListener('slicc:tray-leave', leaveSpy);

    expect(leaveSpy).toHaveBeenCalledTimes(1);
    const detail = (leaveSpy.mock.calls[0]![0] as CustomEvent<{ workerBaseUrl: string | null }>)
      .detail;
    expect(detail.workerBaseUrl).toBeNull();
  });

  it('cherry: wires cherry transport + onCherrySliccEvent, no navigate watcher, no worker', async () => {
    // Re-mock the prelude to return a cherry transport + joinUrl.
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: { emitSliccEventToHost: vi.fn(), onHostEvent: null },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');
    expect(startFollowerSpy).toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    // runtime tag is the cherry tag
    const opts = startFollowerSpy.mock.calls[0]![0];
    expect(opts.runtime).toBe('slicc-cherry');
    expect(opts.onCherrySliccEvent).toBeTypeOf('function');
  });
});
