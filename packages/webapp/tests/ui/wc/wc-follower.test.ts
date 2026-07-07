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

// The follower must load the dip + sprinkle "chrome" stylesheets itself (the
// leader loads them in leader-only paths). Mock the module so we can assert the
// loaders fire — and so the real `.css` imports don't run under jsdom.
const loadDipStyles = vi.fn(async (..._a: unknown[]) => {});
const loadSprinkleStyles = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../../src/ui/legacy-styles.js', () => ({
  loadDipStyles: (...a: unknown[]) => loadDipStyles(...a),
  loadSprinkleStyles: (...a: unknown[]) => loadSprinkleStyles(...a),
  loadLegacyStyles: vi.fn(async () => {}),
  loadLegacyDialogStyles: vi.fn(async () => {}),
}));

const ALL_CHERRY_FEATURES = {
  terminal: true,
  files: true,
  memory: true,
  browser: true,
  modelPicker: true,
  history: true,
  nav: true,
  newSprinkle: true,
  monitor: true,
};

/** Re-mock the prelude to return a cherry transport whose host-event emitter is
 *  `emit`, so a test can observe the follower's leader hand-off signals. */
function mockCherryPrelude(emit: () => void): void {
  vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
    setupStandalonePrelude: vi.fn(async () => ({
      browser: { getTransport: () => ({}), listPages: async () => [] },
      realCdpTransport: {},
      cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
      cherryTransport: {
        emitSliccEventToHost: emit,
        onHostEvent: null,
        features: ALL_CHERRY_FEATURES,
      },
      instanceId: 'i',
    })),
  }));
}

/** Override `window.location` so `isExtensionSidePanel` resolves to the given
 *  ancestor origin. The extension side panel's immediate ancestor is the
 *  extension's `sidepanel.html` (a `chrome-extension://` origin); a general
 *  cherry embed's ancestor is the third-party host page. */
function setCherryLocation(ancestorOrigin: string): void {
  Object.defineProperty(window, 'location', {
    value: {
      href: 'https://www.sliccy.ai/join/tray-1.cap-token?cherry=1&ui-only=1',
      search: '?cherry=1&ui-only=1',
      ancestorOrigins: [ancestorOrigin],
    },
    writable: true,
  });
}

describe('mountWcUiFollower', () => {
  beforeEach(() => {
    spawnSpy.mockClear();
    startFollowerSpy.mockClear();
    loadDipStyles.mockClear();
    loadSprinkleStyles.mockClear();
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

  // Must run BEFORE the "Disconnect from leader" test below: that test's
  // switch-out mutates window location/localStorage so a later non-cherry
  // mount can't resolve its join URL (it falls back to mountWcUiLive).
  it('wires the composer add-menu so a staged attachment forwards to the leader on submit', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');

    // Simulate the WebRTC channel connecting: the tray installs the real
    // follower-sync agent via setChatAgent. We hand the controller a fake one
    // so we can observe what the follower forwards to the leader.
    const opts = startFollowerSpy.mock.calls[0]![0];
    const sendMessage = vi.fn();
    opts.setChatAgent?.({ sendMessage, onEvent: () => () => {}, stop: () => {} });

    const inputCard = app.querySelector('slicc-input-card') as HTMLElement;

    // The "+" menu's "Upload from this computer" pick lands as a slicc-add
    // upload event. A follower has NO VFS writer, so the image stays inline
    // (base64 data, no path) — exactly what survives the wire to the leader.
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'snap.png', { type: 'image/png' });
    inputCard.dispatchEvent(
      new CustomEvent('slicc-add', {
        bubbles: true,
        detail: { kind: 'upload', name: 'snap.png', size: 4, file },
      })
    );

    // Staging reads the file bytes asynchronously — wait for the chip to render.
    await vi.waitFor(() => {
      expect(inputCard.querySelector('.wcatt__chip')).toBeTruthy();
    });

    // Submitting collects the staged attachment and forwards it to the agent.
    inputCard.dispatchEvent(new CustomEvent('submit', { detail: { value: 'look at this' } }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [text, , attachments] = sendMessage.mock.calls[0]! as [
      string,
      string,
      Array<{ kind: string; data?: string; path?: string }>,
    ];
    expect(text).toBe('look at this');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.kind).toBe('image');
    expect(attachments[0]!.data).toBeTruthy();
    expect(attachments[0]!.path).toBeUndefined();
  });

  it('arms push-to-talk on a real-tab follower (non-ui-only) so voice can activate', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    // Non-cherry follower → not ui-only → a real tab where getUserMedia works.
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');

    // The follower reuses the WC shell WITHOUT attachWcClient — which is where
    // the live/leader mount sets `ptt`. `<slicc-composer>` gates the entire
    // hold-to-dictate gesture on this attribute, so without it the mic never
    // activates. A real-tab follower CAN capture, so it gets PTT + camera.
    const composer = app.querySelector('slicc-composer') as HTMLElement | null;
    expect(composer).toBeTruthy();
    expect(composer!.hasAttribute('ptt')).toBe(true);
    const menu = app.querySelector('slicc-add-menu') as HTMLElement | null;
    expect(menu?.hasAttribute('no-camera')).toBe(false);
  });

  it('loads the dip + sprinkle chrome stylesheets (leader-only paths the follower skips)', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    // Without these the follower's dips render with no card background and its
    // synced sprinkles lose their chrome — both are lazy legacy stylesheets the
    // leader loads in `wc-live` / `wireWcSprinkles`, which the follower doesn't run.
    await vi.waitFor(() => {
      expect(loadDipStyles).toHaveBeenCalled();
      expect(loadSprinkleStyles).toHaveBeenCalled();
    });
  });

  it('hydrates inline dips (shtml) in the follower so the welcome/onboarding nudge renders', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];

    // The leader's snapshot carries an assistant message with an inline dip
    // (a ```shtml block). Without follower-side hydration this renders as a raw
    // code block; hydrateDips replaces it with a `.msg__dip` mount.
    opts.onSnapshot?.(
      [
        {
          id: 'dip-msg',
          role: 'assistant',
          content: '```shtml\n<div class="sprinkle-action-card">connect</div>\n```',
          timestamp: 1000,
        },
      ],
      'cone'
    );

    await vi.waitFor(() => {
      expect(app.querySelector('.msg__dip')).toBeTruthy();
    });
  });

  it('renders a leader-broadcast tool_ui approval card as a static "waiting on the leader" placeholder, not live buttons', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');

    // Simulate the WebRTC channel connecting: the tray installs the real
    // follower-sync agent, which relays the leader's `agent_event` (including
    // `tool_ui`) via onEvent.
    const opts = startFollowerSpy.mock.calls[0]![0];
    let emit: ((event: unknown) => void) | undefined;
    opts.setChatAgent?.({
      sendMessage: () => {},
      onEvent: (cb) => {
        emit = cb as (event: unknown) => void;
        return () => {};
      },
      stop: () => {},
    });

    emit?.({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'bash',
      requestId: 'req-1',
      html: `<div class="sprinkle-action-card">
        <div class="sprinkle-action-card__header">Mount local directory <span class="sprinkle-badge sprinkle-badge--notice">approval</span></div>
        <div class="sprinkle-action-card__actions">
          <button class="sprinkle-btn sprinkle-btn--secondary" data-action="deny">Deny</button>
          <button class="sprinkle-btn sprinkle-btn--primary" data-action="approve" data-picker="directory">Select directory</button>
        </div>
      </div>`,
    });

    const container = app.querySelector('[data-tool-ui-request="req-1"]');
    const iframe = container?.querySelector('iframe');
    expect(iframe?.srcdoc).toContain('Mount local directory');
    expect(iframe?.srcdoc).toContain('Waiting for approval on the leader');
    expect(iframe?.srcdoc).not.toContain('data-action="approve"');
    expect(iframe?.srcdoc).not.toContain('data-action="deny"');
  });

  it('replaces the inert Files/Terminal/Memory/Monitor panels with a placeholder (no local VFS/shell/kernel)', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');

    // The file tree is never wired in follower mode — it's hidden…
    const fileTree = app.querySelector('slicc-file-tree') as HTMLElement | null;
    expect(fileTree).toBeTruthy();
    expect(fileTree!.style.display).toBe('none');

    // …and so is the monitor dashboard — it's entirely kernel/orchestrator-backed
    // (scoops, cost, processes, cron, webhooks, mounts, MCP), and a follower has
    // no kernel worker to source any of that from.
    const monitor = app.querySelector('slicc-monitor') as HTMLElement | null;
    expect(monitor).toBeTruthy();
    expect(monitor!.style.display).toBe('none');

    // …and explanatory placeholders take the Files + Terminal + Memory + Monitor panels.
    const texts = Array.from(app.querySelectorAll('.wcui-placeholder')).map(
      (e) => e.textContent ?? ''
    );
    expect(texts.some((t) => t.includes('Files live on the leader'))).toBe(true);
    expect(texts.some((t) => t.includes('The shell runs on the leader'))).toBe(true);
    expect(texts.some((t) => t.includes('Memory lives on the leader'))).toBe(true);
    expect(texts.some((t) => t.includes('Monitor reads the leader'))).toBe(true);
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

  it('populates the nav switcher when the leader broadcasts a scoops.list', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];

    const switcher = app.querySelector('slicc-scoop-switcher') as HTMLElement & {
      scoops: { key: string; type: string; label: string }[];
    };
    expect(switcher).toBeTruthy();
    expect(switcher.scoops).toEqual([]);

    opts.onScoopsList?.(
      [
        {
          jid: 'cone-jid',
          name: 'cone',
          folder: '/workspace',
          isCone: true,
          assistantLabel: 'sliccy',
        },
        {
          jid: 'scoop-1',
          name: 'research',
          folder: '/scoops/research',
          isCone: false,
          assistantLabel: 'research',
        },
      ],
      'cone-jid'
    );

    expect(switcher.scoops.map((s) => s.key)).toEqual(['cone-jid', 'scoop-1']);
    expect(switcher.scoops.map((s) => s.type)).toEqual(['cone', 'scoop']);
    expect(switcher.scoops[0]!.label).toBe('sliccy');
    expect(switcher.scoops[1]!.label).toBe('research');
    expect(switcher.getAttribute('active')).toBe('cone-jid');
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
        cherryTransport: {
          emitSliccEventToHost: vi.fn(),
          onHostEvent: null,
          features: {
            terminal: true,
            files: true,
            memory: true,
            browser: true,
            modelPicker: true,
            history: true,
            nav: true,
            newSprinkle: true,
            monitor: true,
          },
        },
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

  it('cherry: emits slicc.follower.ready/disconnected via transport on connection-state changes', async () => {
    const emit = vi.fn();
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: {
          emitSliccEventToHost: emit,
          onHostEvent: null,
          features: {
            terminal: true,
            files: true,
            memory: true,
            browser: true,
            modelPicker: true,
            history: true,
            nav: true,
            newSprinkle: true,
            monitor: true,
          },
        },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');
    const opts = startFollowerSpy.mock.calls[0]![0];

    // Connect → 'slicc.follower.ready'.
    opts.onConnectionChange?.(true);
    expect(emit).toHaveBeenCalledWith('slicc.follower.ready');

    // Transient disconnect → 'slicc.follower.disconnected'.
    opts.onConnectionChange?.(false);
    expect(emit).toHaveBeenCalledWith('slicc.follower.disconnected');

    // Terminal give-up also emits 'disconnected' (detachSync suppresses the
    // matching onConnectionChange(false) in that path, so the host would
    // otherwise wait forever).
    emit.mockClear();
    opts.onGaveUp?.(new Error('bad join url'));
    expect(emit).toHaveBeenCalledWith('slicc.follower.disconnected');
  });

  it('extension side panel: routes the cone-error "Open settings" CTA to the leader tab (settings/OAuth run there, not the panel)', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();
    // The extension side panel's ancestor is the extension origin.
    setCherryLocation('chrome-extension://abcdef');
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    // The cone-error card's "Open settings" CTA bubbles this on the thread. In
    // the leader `wireWcNav` opens the settings dialog; the follower can't, so
    // it hands off to the leader tab + shows the redirect card instead.
    const thread = app.querySelector('slicc-chat-thread')!;
    thread.dispatchEvent(
      new CustomEvent('slicc-error-open-settings', { bubbles: true, composed: true })
    );

    expect(emit).toHaveBeenCalledWith('slicc.open-leader-tab');
    expect(app.querySelector('.wc-signin-redirect')).toBeTruthy();
  });

  it('general cherry embed (NOT side panel): does NOT route the error-card CTA to a leader tab', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();
    // A third-party host page (not the extension origin) — no leader tab to open.
    setCherryLocation('https://third-party.example');
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    const thread = app.querySelector('slicc-chat-thread')!;
    thread.dispatchEvent(
      new CustomEvent('slicc-error-open-settings', { bubbles: true, composed: true })
    );

    // The hand-off is extension-side-panel-only: no open-leader-tab, no card.
    expect(emit).not.toHaveBeenCalledWith('slicc.open-leader-tab');
    expect(app.querySelector('.wc-signin-redirect')).toBeNull();
  });

  it('extension side panel: replaces the onboarding welcome dip with a leader hand-off card', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();
    setCherryLocation('chrome-extension://abcdef');
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');
    const opts = startFollowerSpy.mock.calls[0]![0];

    // The leader's snapshot carries the onboarding connect-llm welcome dip (an
    // `![…](/shared/sprinkles/welcome/…)` image ref). It can't complete in the
    // panel (no LLM connected follower-side, OAuth can't run here), so the panel
    // swaps it in place for a hand-off card instead of hydrating a dead wizard.
    opts.onSnapshot?.(
      [
        {
          id: 'welcome-msg',
          role: 'assistant',
          content: '![Connect a model](/shared/sprinkles/welcome/connect-llm.shtml)',
          timestamp: 1000,
        },
      ],
      'cone'
    );

    await vi.waitFor(() => {
      expect(app.querySelector('.wc-signin-redirect')).toBeTruthy();
    });
    expect(app.querySelector('.wc-signin-redirect')!.textContent).toContain(
      'Set up SLICC in the main tab'
    );
    // The welcome dip was NOT hydrated — it became the card.
    expect(app.querySelector('.msg__dip')).toBeNull();
    // Building the card does not focus the tab; only clicking the button does.
    expect(emit).not.toHaveBeenCalledWith('slicc.open-leader-tab');
    (app.querySelector('.wc-signin-redirect__open') as HTMLButtonElement).click();
    expect(emit).toHaveBeenCalledWith('slicc.open-leader-tab');
  });

  it('general cherry embed: keeps the real welcome dip (no leader hand-off replacement)', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();
    setCherryLocation('https://third-party.example');
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');
    const opts = startFollowerSpy.mock.calls[0]![0];

    opts.onSnapshot?.(
      [
        {
          id: 'welcome-msg',
          role: 'assistant',
          content: '![Connect a model](/shared/sprinkles/welcome/connect-llm.shtml)',
          timestamp: 1000,
        },
      ],
      'cone'
    );

    // A third-party embed owns its own onboarding — the welcome dip hydrates
    // normally (a `.msg__dip` mount) and no hand-off card is inserted.
    await vi.waitFor(() => {
      expect(app.querySelector('.msg__dip')).toBeTruthy();
    });
    expect(app.querySelector('.wc-signin-redirect')).toBeNull();
  });

  it('reads ?ui-only=1 and passes uiOnly:true to startPageFollowerTray when cherry', async () => {
    // Change the URL to include ui-only=1
    Object.defineProperty(window, 'location', {
      value: {
        href: 'https://www.sliccy.ai/join/tray-1.cap-token?cherry=1&ui-only=1',
        search: '?cherry=1&ui-only=1',
      },
      writable: true,
    });

    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    expect(startFollowerSpy).toHaveBeenCalledTimes(1);
    const opts = startFollowerSpy.mock.calls[0]![0];
    expect(opts.uiOnly).toBe(true);

    // The ui-only follower is the extension side-panel cockpit — a cross-origin
    // iframe where getUserMedia can't be granted. So mic/camera capture is
    // gated: NO `ptt` on the composer, and the add-menu gets `no-camera` (which
    // drops "Take a photo" but keeps screenshot + upload).
    const composer = app.querySelector('slicc-composer') as HTMLElement;
    expect(composer.hasAttribute('ptt')).toBe(false);
    const menu = app.querySelector('slicc-add-menu') as HTMLElement | null;
    expect(menu?.hasAttribute('no-camera')).toBe(true);
  });

  it('cherry: applies host theme AFTER mounting the shell (overrides ensureSystemTheme)', async () => {
    const callOrder: string[] = [];
    vi.doMock('../../../src/ui/theme-engine.js', () => ({
      applyCherryTheme: vi.fn(() => callOrder.push('applyCherryTheme')),
    }));
    vi.doMock('../../../src/ui/wc/wc-live.js', async (importOriginal) => {
      const orig = (await importOriginal()) as Record<string, unknown>;
      return {
        ...orig,
        prepareWcShell: vi.fn((...args: unknown[]) => {
          callOrder.push('prepareWcShell');
          return (orig.prepareWcShell as (...a: unknown[]) => unknown)(...args);
        }),
      };
    });
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: {
          emitSliccEventToHost: vi.fn(),
          onHostEvent: null,
          theme: { mode: 'dark', accent: '#ff0000' },
          features: {
            terminal: true,
            files: true,
            memory: true,
            browser: true,
            modelPicker: true,
            history: true,
            nav: true,
            newSprinkle: true,
            monitor: true,
          },
        },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');
    expect(callOrder.indexOf('prepareWcShell')).toBeLessThan(callOrder.indexOf('applyCherryTheme'));
  });

  it('does not set uiOnly when ?ui-only=1 is present but NOT cherry mode', async () => {
    // Regular follower with ui-only param should ignore it. This is a NON-cherry
    // follower, so it starts the follower-navigate-watcher, which calls
    // `realCdpTransport.on(...)`. Establish our own prelude mock with a complete
    // realCdpTransport (on/off/send) — a prior cherry test's doMock leaves an
    // empty `realCdpTransport: {}` that would otherwise leak in and crash the
    // watcher with "transport.on is not a function".
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: { on: vi.fn(), off: vi.fn(), send: vi.fn(async () => ({})) },
        cherryJoinUrl: undefined,
        cherryTransport: undefined,
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    Object.defineProperty(window, 'location', {
      value: {
        href: 'https://www.sliccy.ai/join/tray-1.cap-token?ui-only=1',
        search: '?ui-only=1',
      },
      writable: true,
    });

    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');

    const opts = startFollowerSpy.mock.calls[0]![0];
    // uiOnly should be undefined or false for non-cherry
    expect(opts.uiOnly).toBeFalsy();
  });
});
