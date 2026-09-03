// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.sliccy.ai/join/tray-1.cap-token" }
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    hasLocalCdpSurface: true,
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
      hasLocalCdpSurface: true,
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
  // Warm the module graph ONCE, outside any test's budget. Every case here
  // re-imports `wc-follower.js` after `vi.resetModules()` (deliberate — each
  // needs a fresh instance), but `resetModules` only drops evaluated modules,
  // never vitest's transform cache. So the FIRST importer paid the whole
  // transform: ~2.9s idle, and >10s under load, which timed the first test out.
  // Paying it in a hook keeps the one-time setup cost out of a per-test budget.
  beforeAll(async () => {
    await import('../../../src/ui/wc/wc-follower.js');
  }, 60_000);

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
  }, 10_000);

  it('drives the floatbar status beacon from the follower tray status (#1707)', async () => {
    // Integration guard: mount installs installFloatbarStatus and the beacon
    // tracks follower runtime transitions end to end.
    const { setFollowerTrayRuntimeStatus } = await import(
      '../../../src/scoops/tray-follower-status.js'
    );
    const inactive = {
      state: 'inactive' as const,
      joinUrl: null,
      trayId: null,
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
      attachAttempts: 0,
      lastAttachCode: null,
      connectingSince: null,
      lastError: null,
    };
    setFollowerTrayRuntimeStatus(inactive);
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');

    const floatbar = app.querySelector('slicc-floatbar') as HTMLElement;
    expect(floatbar).toBeTruthy();
    expect(floatbar.getAttribute('connection')).toBe('offline');

    setFollowerTrayRuntimeStatus({ ...inactive, state: 'connected' });
    expect(floatbar.getAttribute('connection')).toBe('live');

    setFollowerTrayRuntimeStatus({ ...inactive, state: 'error', error: 'Data channel closed' });
    expect(floatbar.getAttribute('connection')).toBe('error');
  });

  // Must run BEFORE the "Disconnect from leader" test below: that test's
  // switch-out mutates window location/localStorage so a later non-cherry
  // mount can't resolve its join URL (it falls back to mountWcUiLive).
  it('wires the composer add-menu so a staged attachment forwards to the leader on submit', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');

    // Simulate the WebRTC channel connecting. The composer's handle rides the
    // client protocol now (#2382), so the observable is the SYNC MANAGER's
    // `sendMessage` — what actually goes to the leader — not the handle
    // `setChatAgent` was given, which only supplies the agent event stream.
    const opts = startFollowerSpy.mock.calls[0]![0];
    const sendMessage = vi.fn();
    const selectScoop = vi.fn();
    (startFollowerSpy.mock.results[0]!.value as { currentSync: unknown }).currentSync = {
      sendMessage,
      selectScoop,
      stop: vi.fn(),
    };
    // A prompt has to name its unit, so the leader's roster comes first.
    opts.onScoopsList?.(
      [
        {
          assistantLabel: 'sliccy',
          folder: 'cone',
          isCone: true,
          jid: 'cone_1',
          name: 'sliccy',
          parentId: null,
          state: 'idle',
        },
      ] as never,
      'cone_1'
    );
    opts.setChatAgent?.({ sendMessage: vi.fn(), onEvent: () => () => {}, stop: () => {} });

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
    const [text, messageId, attachments] = sendMessage.mock.calls[0]! as [
      string,
      string,
      Array<{ kind: string; data?: string; path?: string }>,
    ];
    expect(text).toBe('look at this');
    // The controller's own id rides along: a follower suppresses its own echo
    // by it, so an adapter that minted a fresh one would double-render.
    expect(messageId).toEqual(expect.any(String));
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

  it('glowers at a failed tool result and scrutinizes what the user types', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');

    const switcher = app.querySelector('slicc-agent-tabs') as HTMLElement & {
      glower(): void;
      scrutinize(): void;
      wake(): void;
    };
    const glower = vi.spyOn(switcher, 'glower');
    const scrutinize = vi.spyOn(switcher, 'scrutinize');

    // The awaiting gaze needs something to make eye contact with.
    expect(switcher.getAttribute('gaze-target')).toBe('slicc-input-card');

    const opts = startFollowerSpy.mock.calls[0]![0];
    const subscribers: ((event: unknown) => void)[] = [];
    opts.setChatAgent?.({
      sendMessage: () => {},
      onEvent: (cb) => {
        subscribers.push(cb as (event: unknown) => void);
        return () => {};
      },
      stop: () => {},
    });
    const emit = (event: unknown): void => {
      for (const subscriber of [...subscribers]) subscriber(event);
    };

    // A tool that SUCCEEDS is not a reason to glower.
    emit({ type: 'tool_result', messageId: 'm1', toolName: 'bash', result: 'ok' });
    expect(glower).not.toHaveBeenCalled();

    emit({ type: 'tool_result', messageId: 'm2', toolName: 'bash', result: 'boom', isError: true });
    expect(glower).toHaveBeenCalledTimes(1);

    // Typing is local to whoever types — it never rides the wire.
    app.querySelector('slicc-input-card')?.dispatchEvent(new Event('input', { bubbles: true }));
    expect(scrutinize).toHaveBeenCalled();
  });

  it('renders a leader-broadcast tool_ui approval card as a static "waiting on the leader" placeholder, not live buttons', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');

    // Simulate the WebRTC channel connecting: the tray installs the real
    // follower-sync agent, which relays the leader's `agent_event` (including
    // `tool_ui`) via onEvent.
    const opts = startFollowerSpy.mock.calls[0]![0];
    // The real follower-sync agent FANS OUT to every subscriber; the shell now
    // takes one of its own (the avatar's glower on a failed tool result)
    // alongside the chat controller's, so a fake that keeps only the last
    // callback would silently starve whichever registered first.
    const subscribers: ((event: unknown) => void)[] = [];
    const emit = (event: unknown): void => {
      for (const subscriber of [...subscribers]) subscriber(event);
    };
    opts.setChatAgent?.({
      sendMessage: () => {},
      onEvent: (cb) => {
        subscribers.push(cb as (event: unknown) => void);
        return () => {};
      },
      stop: () => {},
    });

    emit({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'bash',
      requestId: 'req-1',
      html: `<div class="sprinkle-action-card">
        <div class="sprinkle-action-card__header">
          <div class="sprinkle-action-card__title-group">Mount local directory<div class="sprinkle-action-card__meta">Target: /workspace/mnt/docs</div></div>
          <span class="sprinkle-badge sprinkle-badge--notice">approval</span>
        </div>
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
    // The mount target path must not leak to the follower placeholder,
    // and the title must not mash together with the meta text.
    expect(iframe?.srcdoc).not.toContain('/workspace/mnt/docs');
    expect(iframe?.srcdoc).not.toContain('Mount local directoryTarget:');
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
    const switcher = app.querySelector('slicc-agent-tabs') as HTMLElement & {
      connection: string;
    };

    // Pre-connect: disabled, "Connecting to leader…" — input can't be silently dropped.
    expect(inputCard.hasAttribute('disabled')).toBe(true);
    expect(inputCard.getAttribute('placeholder')).toBe('Connecting to leader…');
    expect(switcher.connection).toBe('disconnected');

    // On connect, the tray fires onConnectionChange(true) — but the leader has
    // not named a unit yet (`activateFollowerSync` reports the connection
    // BEFORE it asks for the first snapshot). A send names its unit (#2382), so
    // the box stays shut for those few frames rather than accepting a prompt it
    // would drop after clearing the input.
    const opts = startFollowerSpy.mock.calls[0]![0];
    opts.onConnectionChange?.(true);
    expect(switcher.connection).toBe('connected');
    expect(inputCard.hasAttribute('disabled')).toBe(true);
    expect(inputCard.getAttribute('placeholder')).toBe('Connecting to leader…');

    // The leader's first snapshot names the unit → composer opens.
    opts.onSnapshot?.([], 'cone_1');
    expect(inputCard.hasAttribute('disabled')).toBe(false);
    expect(inputCard.getAttribute('placeholder')).toBe('Ask the leader, or describe a change…');

    // A disconnect re-disables + re-shows connecting.
    opts.onConnectionChange?.(false);
    expect(inputCard.hasAttribute('disabled')).toBe(true);
    expect(inputCard.getAttribute('placeholder')).toBe('Connecting to leader…');
    expect(switcher.connection).toBe('disconnected');
  });

  it('aborts the leader’s turn from the follower’s own Stop button (#2382)', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const opts = startFollowerSpy.mock.calls[0]![0];
    const stop = vi.fn(() => true);
    const selectScoop = vi.fn();
    (startFollowerSpy.mock.results[0]!.value as { currentSync: unknown }).currentSync = {
      sendMessage: vi.fn(() => true),
      selectScoop,
      stop,
    };
    opts.onConnectionChange?.(true);
    opts.setChatAgent?.({ sendMessage: vi.fn(), onEvent: () => () => {}, stop: () => {} });
    opts.onSnapshot?.([], 'cone_1');

    // Idle: a stop is meaningless and must not reach the leader — same guard
    // the leader's own composer uses.
    inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true }));
    expect(stop).not.toHaveBeenCalled();

    // Mid-turn the button has to work. Before this the follower installed NO
    // `stop` listener at all, so the button (and keyboard mode's `s`) emitted
    // into nothing and the leader's turn ran on.
    opts.onStatus?.('processing', 'cone_1');
    inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true }));
    expect(stop).toHaveBeenCalledTimes(1);
    // The leader is already mirroring `cone_1`, so the abort needs no
    // selection round trip. (That the client DOES select first when the unit
    // differs — the tray's `abort` frame carries none — is pinned by the
    // conformance suite's "stops a unit mid-turn" case.)
    expect(selectScoop).not.toHaveBeenCalled();
  });

  it('does not treat an empty activeScoopJid as an addressable unit', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const opts = startFollowerSpy.mock.calls[0]![0];

    opts.onConnectionChange?.(true);
    // A leader that sent a roster but could not name an active unit. `''` is
    // not a jid: enabling the composer on it means the handle accepts the
    // prompt, renders it, clears the input and then drops it as "No scoop
    // selected".
    opts.onScoopsList?.([] as never, '');
    expect(inputCard.hasAttribute('disabled')).toBe(true);

    opts.onScoopsList?.(
      [
        {
          assistantLabel: 'sliccy',
          folder: 'cone',
          isCone: true,
          jid: 'cone_1',
          name: 'sliccy',
          parentId: null,
          state: 'idle',
        },
      ] as never,
      'cone_1'
    );
    expect(inputCard.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the composer shut after a reconnect until the NEW session names a unit', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const opts = startFollowerSpy.mock.calls[0]![0];

    opts.onConnectionChange?.(true);
    opts.onSnapshot?.([], 'cone_1');
    expect(inputCard.hasAttribute('disabled')).toBe(false);

    opts.onConnectionChange?.(false);
    opts.onConnectionChange?.(true);
    // A reconnect is a fresh bootstrap and the leader may have dropped the
    // unit we were viewing, so the previous session's answer must not reopen
    // the box…
    expect(inputCard.hasAttribute('disabled')).toBe(true);
    // …while the viewed jid itself survives, because that is what the new
    // leader is asked for (`requestSnapshot`).
    expect(opts.getSelectedScoopJid?.()).toBe('cone_1');

    opts.onSnapshot?.([], 'cone_2');
    expect(inputCard.hasAttribute('disabled')).toBe(false);
    expect(opts.getSelectedScoopJid?.()).toBe('cone_2');
  });

  it('opens the composer off the first scoops.list when no snapshot arrived yet', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const opts = startFollowerSpy.mock.calls[0]![0];

    opts.onConnectionChange?.(true);
    expect(inputCard.hasAttribute('disabled')).toBe(true);

    // Either frame names a unit, and a leader may send the roster first — so
    // neither one may be the only door out of the un-addressable window.
    opts.onScoopsList?.(
      [
        {
          assistantLabel: 'sliccy',
          folder: 'cone',
          isCone: true,
          jid: 'cone_1',
          name: 'sliccy',
          parentId: null,
          state: 'idle',
        },
      ] as never,
      'cone_1'
    );
    expect(inputCard.hasAttribute('disabled')).toBe(false);
  });

  it('keeps model controls hidden before the catalog and for a legacy leader connection', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const meta = app.querySelector('slicc-composer-meta') as HTMLElement;
    const opts = startFollowerSpy.mock.calls[0]![0];

    expect(meta.style.display).toBe('none');
    // A pre-v5 leader connects and sends normal state, but never sends the v5
    // catalog callback. The empty model surface must remain unavailable.
    opts.onConnectionChange?.(true);
    opts.onStatus?.('idle');
    expect(meta.style.display).toBe('none');
  });

  it('populates authoritative model state and sends model/thinking selections without optimistic pills', async () => {
    const selectModel = vi.fn();
    const setThinkingLevel = vi.fn();
    startFollowerSpy.mockImplementationOnce(
      (_opts: StartPageFollowerTrayOptions) =>
        ({ stop: vi.fn(), currentSync: { selectModel, setThinkingLevel } }) as never
    );
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const meta = app.querySelector('slicc-composer-meta') as HTMLElement & {
      model: string;
      models: Array<{ id: string; name: string; provider: string }>;
    };
    const opts = startFollowerSpy.mock.calls[0]![0];
    const models = [
      {
        providerName: 'Anthropic',
        modelId: 'anthropic:claude-sonnet-4-6',
        modelName: 'Claude Sonnet 4.6',
        reasoning: true,
      },
      {
        providerName: 'OpenAI',
        modelId: 'openai:gpt-4.1',
        modelName: 'GPT-4.1',
        reasoning: false,
      },
    ];

    opts.onModelsList?.(models);
    expect(meta.models).toEqual([
      { id: 'anthropic:claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic' },
      { id: 'openai:gpt-4.1', name: 'GPT-4.1', provider: 'OpenAI' },
    ]);
    expect(meta.style.display).toBe('none');

    opts.onModelState?.({
      activeModelId: 'anthropic:claude-sonnet-4-6',
      scoopJid: 'cone-jid',
      thinkingLevel: 'medium',
    });
    expect(meta.style.display).toBe('');
    expect(meta.model).toBe('Claude Sonnet 4.6');
    expect(meta.getAttribute('thinking')).toBe('medium');
    expect(meta.hasAttribute('no-thinking')).toBe(false);

    // The component updates itself before emitting. The follower immediately
    // restores the leader state while the requested selection is in flight.
    meta.model = 'GPT-4.1';
    meta.dispatchEvent(
      new CustomEvent('model-change', {
        detail: { id: 'openai:gpt-4.1', model: 'GPT-4.1', provider: 'OpenAI' },
      })
    );
    expect(selectModel).toHaveBeenCalledWith('openai:gpt-4.1', 'cone-jid');
    expect(meta.model).toBe('Claude Sonnet 4.6');

    meta.setAttribute('thinking', 'max');
    meta.dispatchEvent(new CustomEvent('thinking-change', { detail: { thinking: 'max' } }));
    expect(setThinkingLevel).toHaveBeenCalledWith('cone-jid', 'xhigh', 'max');
    expect(meta.getAttribute('thinking')).toBe('medium');

    opts.onModelState?.({
      activeModelId: 'openai:gpt-4.1',
      scoopJid: 'cone-jid',
      thinkingLevel: 'off',
    });
    expect(meta.model).toBe('GPT-4.1');
    expect(meta.hasAttribute('no-thinking')).toBe(true);
  });

  it('populates the nav switcher when the leader broadcasts a scoops.list', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];

    const switcher = app.querySelector('slicc-agent-tabs') as HTMLElement & {
      scoops: { key: string; type: string; label: string; state: string; fill: number }[];
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
          parentId: null,
          assistantLabel: 'sliccy',
          state: 'working',
          fill: 64,
        },
        {
          jid: 'scoop-1',
          name: 'research',
          folder: '/scoops/research',
          isCone: false,
          parentId: 'cone-jid',
          assistantLabel: 'research',
          state: 'broken',
          fill: 82,
        },
      ],
      'cone-jid'
    );

    expect(switcher.scoops.map((s) => s.key)).toEqual(['cone-jid', 'scoop-1']);
    expect(switcher.scoops.map((s) => s.type)).toEqual(['cone', 'scoop']);
    expect(switcher.scoops[0]!.label).toBe('sliccy');
    expect(switcher.scoops[1]!.label).toBe('research');
    expect(switcher.scoops.map((s) => s.state)).toEqual(['working', 'broken']);
    expect(switcher.scoops.map((s) => s.fill)).toEqual([64, 82]);
    expect(switcher.getAttribute('active')).toBe('cone-jid');
  });

  it('preserves its viewed scoop across reconnect and falls back if it disappears', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];
    const switcher = app.querySelector('slicc-agent-tabs')!;
    opts.onScoopsList?.(
      [
        { jid: 'cone-jid', name: 'cone', isCone: true, parentId: null },
        { jid: 'research', name: 'research', isCone: false, parentId: 'cone-jid' },
      ] as never,
      'cone-jid'
    );
    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'research' } }));

    opts.onConnectionChange?.(false);
    expect(opts.getSelectedScoopJid?.()).toBe('research');

    opts.onScoopsList?.(
      [{ jid: 'cone-jid', name: 'cone', isCone: true, parentId: null }] as never,
      'cone-jid'
    );
    expect(opts.getSelectedScoopJid?.()).toBe('cone-jid');
    expect(switcher.getAttribute('active')).toBe('cone-jid');
  });

  it('re-orders the tab strip when the follower selects a cone (Codex P2)', async () => {
    // `toFollowerSwitcherScoops` puts the SELECTED cone's scoops ahead of the
    // rest, and the local click handler previously only moved `active` — so the
    // strip kept showing the previously selected cone's scoops first until the
    // leader happened to push a fresh roster.
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];
    const switcher = app.querySelector('slicc-agent-tabs')! as HTMLElement & {
      scoops: Array<{ key: string }>;
    };
    opts.onScoopsList?.(
      [
        { jid: 'cone-a', name: 'cone', isCone: true, parentId: null },
        { jid: 'cone-b', name: 'research', isCone: true, parentId: null },
        { jid: 'scoop-a', name: 'helper-a', isCone: false, parentId: 'cone-a' },
        { jid: 'scoop-b', name: 'helper-b', isCone: false, parentId: 'cone-b' },
      ] as never,
      'cone-a'
    );
    const orderFor = () => switcher.scoops.map((s) => s.key);
    // cone-a selected: both cones first, then cone-a's scoop, then the rest.
    expect(orderFor()).toEqual(['cone-a', 'cone-b', 'scoop-a', 'scoop-b']);

    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-b' } }));
    // Selecting cone-b must move ITS scoop ahead, without waiting on a roster push.
    expect(orderFor()).toEqual(['cone-a', 'cone-b', 'scoop-b', 'scoop-a']);
  });

  it('unmounts the composer when the follower views a scoop, and restores it on the cone (#2312)', async () => {
    // Same rule, same descriptor role as the leader: users never talk to a
    // scoop, on either side of the tray.
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];
    const switcher = app.querySelector('slicc-agent-tabs')!;
    const composer = app.querySelector('slicc-composer')!;
    const inputCard = app.querySelector('slicc-input-card')!;

    opts.onScoopsList?.(
      [
        { jid: 'cone-a', name: 'cone', isCone: true, parentId: null },
        { jid: 'scoop-a', name: 'helper', isCone: false, parentId: 'cone-a' },
      ] as never,
      'cone-a'
    );
    // Connected: the cone's composer is live.
    opts.onConnectionChange?.(true);
    expect(composer.hasAttribute('hidden')).toBe(false);
    expect(inputCard.hasAttribute('disabled')).toBe(false);

    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'scoop-a' } }));
    expect(composer.hasAttribute('hidden')).toBe(true);
    expect(inputCard.hasAttribute('disabled')).toBe(true);

    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-a' } }));
    expect(composer.hasAttribute('hidden')).toBe(false);
    expect(inputCard.hasAttribute('disabled')).toBe(false);
  });

  it('unmounts the follower composer for a scoop with the multiple-cones flag OFF (#2312)', async () => {
    // The read-only view is the one part of the multi-cones stack that ships
    // unflagged — the follower reaches it through `summaryRole`, which reads
    // no flag. Pins that against a future gate on the selection wiring.
    // Off via the worker's central value: since #2280 the flag is not
    // `userToggleable`, so a `localStorage` override would be dropped by
    // `canOverride` and leave this testing the ON state instead.
    const { initFeatureFlags } = await import('../../../src/core/feature-flags.js');
    initFeatureFlags('follower', { 'multiple-cones': 'off' });
    try {
      const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
      const app = document.getElementById('app')!;
      await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
      const opts = startFollowerSpy.mock.calls[0]![0];
      const switcher = app.querySelector('slicc-agent-tabs')!;
      const composer = app.querySelector('slicc-composer')!;

      opts.onScoopsList?.(
        [
          { jid: 'cone-a', name: 'cone', isCone: true, parentId: null },
          { jid: 'scoop-a', name: 'helper', isCone: false, parentId: 'cone-a' },
        ] as never,
        'cone-a'
      );
      opts.onConnectionChange?.(true);
      expect(composer.hasAttribute('hidden')).toBe(false);

      switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'scoop-a' } }));
      expect(composer.hasAttribute('hidden')).toBe(true);
    } finally {
      initFeatureFlags('follower');
    }
  });

  it('keeps a scoop’s composer unmounted across a reconnect (#2312)', async () => {
    // The connection state must never outrank the read-only rule: a
    // reconnect while a scoop is viewed used to be the one place that would
    // re-enable the input.
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];
    const switcher = app.querySelector('slicc-agent-tabs')!;
    const composer = app.querySelector('slicc-composer')!;
    const inputCard = app.querySelector('slicc-input-card')!;

    opts.onScoopsList?.(
      [
        { jid: 'cone-a', name: 'cone', isCone: true, parentId: null },
        { jid: 'scoop-a', name: 'helper', isCone: false, parentId: 'cone-a' },
      ] as never,
      'cone-a'
    );
    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'scoop-a' } }));
    opts.onConnectionChange?.(false);
    opts.onConnectionChange?.(true);

    expect(composer.hasAttribute('hidden')).toBe(true);
    expect(inputCard.hasAttribute('disabled')).toBe(true);
  });

  it('applies status only for the viewed scoop while accepting legacy unscoped status', async () => {
    const { WcChatController } = await import('../../../src/ui/wc/wc-chat-controller.js');
    const setProcessing = vi.spyOn(WcChatController.prototype, 'setProcessing');
    try {
      const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
      const app = document.getElementById('app')!;
      await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
      const opts = startFollowerSpy.mock.calls[0]![0];

      opts.onSnapshot([], 'cone-jid');
      expect(setProcessing).toHaveBeenLastCalledWith(false);
      setProcessing.mockClear();

      opts.onStatus('processing', 'research');
      expect(setProcessing).not.toHaveBeenCalled();

      opts.onStatus('processing', 'cone-jid');
      expect(setProcessing).toHaveBeenLastCalledWith(true);

      opts.onStatus('ready');
      expect(setProcessing).toHaveBeenLastCalledWith(false);
    } finally {
      setProcessing.mockRestore();
    }
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

  it('cherry: keeps the whole model surface hidden when modelPicker is false', async () => {
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: {
          emitSliccEventToHost: vi.fn(),
          onHostEvent: null,
          features: { ...ALL_CHERRY_FEATURES, modelPicker: false },
        },
        instanceId: 'i',
        hasLocalCdpSurface: true,
      })),
    }));
    vi.resetModules();
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');
    const opts = startFollowerSpy.mock.calls[0]![0];
    const meta = app.querySelector('slicc-composer-meta') as HTMLElement;

    opts.onModelsList?.([
      {
        providerName: 'Anthropic',
        modelId: 'anthropic:claude-sonnet-4-6',
        modelName: 'Claude Sonnet 4.6',
        reasoning: true,
      },
    ]);
    opts.onModelState?.({
      activeModelId: 'anthropic:claude-sonnet-4-6',
      scoopJid: 'cone-jid',
      thinkingLevel: 'high',
    });

    expect(meta.style.display).toBe('none');
    expect(
      [...document.head.querySelectorAll('style')].some((style) =>
        style.textContent?.includes('slicc-composer-meta')
      )
    ).toBe(true);
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

  it('extension side panel: the avatar menu offers "Bring leader to front" and focuses the tab', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();
    setCherryLocation('chrome-extension://abcdef');
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    const avatarMenu = app.querySelector('slicc-avatar-menu') as HTMLElement & {
      items?: Array<{ id?: string; label?: string }>;
    };
    expect(avatarMenu.items?.some((i) => i.id === 'focus-leader-tab')).toBe(true);

    // A plain focus — the panel host relays it as focus-leader WITHOUT Settings.
    avatarMenu.dispatchEvent(
      new CustomEvent('slicc-avatar-action', { detail: { id: 'focus-leader-tab' } })
    );
    expect(emit).toHaveBeenCalledWith('slicc.focus-leader-tab');
  });

  it('general cherry embed (NOT side panel): no "Bring leader to front" item', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();
    setCherryLocation('https://third-party.example');
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    const avatarMenu = app.querySelector('slicc-avatar-menu') as HTMLElement & {
      items?: Array<{ id?: string }>;
    };
    // No pinned leader tab to focus outside the extension side panel.
    expect(avatarMenu.items?.some((i) => i.id === 'focus-leader-tab')).toBe(false);
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

  it('reads ?ui-only=1 and suppresses CDP advertisement via startPageFollowerTray when cherry', async () => {
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
    expect(opts.advertisesCdpTargets).toBe(false);

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

  it('cherry: loads a host-pushed layout via dockTree.setTree, and a locked leaf in it rejects removeSurface (follower UI cannot close what the host pushed)', async () => {
    const pushedTree = {
      zones: {
        top: null,
        left: { type: 'leaf', surfaceId: 'chat' },
        middle: { type: 'leaf', surfaceId: 'files', locked: true },
        right: null,
        bottom: null,
      },
      rowFr: { top: 1, center: 1, bottom: 1 },
      colFr: { left: 1, middle: 1, right: 1 },
    };
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: {
          emitSliccEventToHost: vi.fn(),
          onHostEvent: null,
          layout: JSON.stringify(pushedTree),
          features: ALL_CHERRY_FEATURES,
        },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    // Enable the gate on the POST-reset module instance — `resetModules` discards
    // the flag state, so initializing before it would silently have no effect.
    // A pushed layout only applies when `panel-layouts` is on; the gate is uniform
    // across floats, so an embed is not an exception.
    const { initFeatureFlags } = await import('../../../src/core/feature-flags.js');
    initFeatureFlags('cherry', { 'panel-layouts': 'on' });
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    const dockTree = app.querySelector('slicc-dock-tree') as HTMLElement & {
      getSurfaceIds(): string[];
      removeSurface(id: string): void;
      tilesMovable: boolean;
    };
    expect(dockTree.tilesMovable).toBe(true);
    expect(dockTree.getSurfaceIds()).toEqual(expect.arrayContaining(['chat', 'files']));

    // Locked, not just pinned: the follower's own UI cannot remove it either.
    dockTree.removeSurface('files');
    expect(dockTree.getSurfaceIds()).toContain('files');

    // A locked leaf renders no move button — nothing to drag.
    const filesTile = [...dockTree.querySelectorAll('.dock-tree__tile')].find((tile) =>
      tile.querySelector('[surface-id="files"]')
    );
    expect(filesTile?.querySelector('.dock-tree__tile-move')).toBeNull();
    const chatTile = [...dockTree.querySelectorAll('.dock-tree__tile')].find((tile) =>
      tile.querySelector('[surface-id="chat"]')
    );
    expect(chatTile?.querySelector('.dock-tree__tile-move')).not.toBeNull();
  });

  it('cherry: applies a locked DockTreeSpec with panel-layouts off while keeping movement disabled', async () => {
    const pushedTree = {
      zones: {
        top: null,
        left: { type: 'leaf', surfaceId: 'chat' },
        middle: { type: 'leaf', surfaceId: 'files', locked: true },
        right: null,
        bottom: null,
      },
      rowFr: { top: 1, center: 1, bottom: 1 },
      colFr: { left: 1, middle: 1, right: 1 },
    };
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: {
          emitSliccEventToHost: vi.fn(),
          onHostEvent: null,
          layout: JSON.stringify(pushedTree),
          features: ALL_CHERRY_FEATURES,
        },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    const dockTree = app.querySelector('slicc-dock-tree') as HTMLElement & {
      getSurfaceIds(): string[];
      removeSurface(id: string): void;
      tilesMovable: boolean;
    };
    expect(dockTree.tilesMovable).toBe(false);
    expect(dockTree.getSurfaceIds()).toEqual(expect.arrayContaining(['chat', 'files']));
    dockTree.removeSurface('files');
    expect(dockTree.getSurfaceIds()).toContain('files');
    expect(dockTree.querySelectorAll('.dock-tree__tile-move')).toHaveLength(0);
  });

  it('cherry: accepts a host-pushed panel LayoutDocument, locked so the user cannot rearrange it', async () => {
    // Embedders vendor the SDK and upgrade on their own schedule, so the
    // follower sniffs the shape: `base` → panel document, `zones` → dock-tree.
    // Both keep working.
    const pushedDoc = {
      version: 1,
      id: 'embed',
      locked: true,
      base: {
        docks: [{ edge: 'top', size: '36px', panels: ['floatbar'] }],
        center: { panel: 'chat' },
      },
    };
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: {
          emitSliccEventToHost: vi.fn(),
          onHostEvent: null,
          layout: JSON.stringify(pushedDoc),
          features: ALL_CHERRY_FEATURES,
        },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    // Enable the gate on the POST-reset module instance — `resetModules` discards
    // the flag state, so initializing before it would silently have no effect.
    // A pushed layout only applies when `panel-layouts` is on; the gate is uniform
    // across floats, so an embed is not an exception.
    const { initFeatureFlags } = await import('../../../src/core/feature-flags.js');
    initFeatureFlags('cherry', { 'panel-layouts': 'on' });
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    // Panelized: a `<slicc-layout>` replaced the dock-tree shell.
    const layout = app.querySelector('slicc-layout') as HTMLElement & {
      getLayout(): { id: string; locked?: boolean };
      isLocked(id: string): boolean;
    };
    expect(layout).not.toBeNull();
    expect(layout.getLayout().id).toBe('embed');
    // Tree-wide lock reaches every placed panel, so the end user can't rearrange
    // what the embedder pushed.
    expect(layout.isLocked('chat')).toBe(true);
    expect(app.querySelector('slicc-panel[panel-id="chat"]')?.hasAttribute('locked')).toBe(true);
  });

  it('cherry: IGNORES a pushed layout while the panel-layouts flag is off', async () => {
    // The gate is uniform across floats — an embed is not an exception. A host that
    // pushes a document with the flag off gets the default shell and a warning,
    // never a half-applied arrangement.
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: {
          emitSliccEventToHost: vi.fn(),
          onHostEvent: null,
          layout: JSON.stringify({
            version: 1,
            id: 'embed',
            base: { center: { panel: 'chat' } },
          }),
          features: ALL_CHERRY_FEATURES,
        },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    // No `initFeatureFlags` call: the flag falls back to its bundled `off`.
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    expect(app.querySelector('slicc-layout')).toBeNull();
    expect(app.querySelector('slicc-dock-tree')).not.toBeNull();
  });

  it('cherry: a host-pushed flags override turns panel-layouts on for its own pushed layout — no worker-level FEATURE_FLAGS needed', async () => {
    const pushedDoc = {
      version: 1,
      id: 'embed',
      locked: true,
      base: { center: { panel: 'chat' } },
    };
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: {
          emitSliccEventToHost: vi.fn(),
          onHostEvent: null,
          flags: JSON.stringify({ 'panel-layouts': 'on' }),
          layout: JSON.stringify(pushedDoc),
          features: ALL_CHERRY_FEATURES,
        },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    // Deliberately NO initFeatureFlags('cherry', { 'panel-layouts': 'on' }) call —
    // the flag must come from the host-pushed `flags`, not the test harness.
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    const layout = app.querySelector('slicc-layout') as HTMLElement & {
      getLayout(): { id: string };
    };
    expect(layout).not.toBeNull();
    expect(layout.getLayout().id).toBe('embed');
  });

  it('cherry: ignores host-pushed flags that are not valid JSON, keeping the flag off (and the default layout)', async () => {
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: {
          emitSliccEventToHost: vi.fn(),
          onHostEvent: null,
          flags: '{not json',
          layout: JSON.stringify({
            version: 1,
            id: 'embed',
            base: { center: { panel: 'chat' } },
          }),
          features: ALL_CHERRY_FEATURES,
        },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    expect(app.querySelector('slicc-layout')).toBeNull();
    expect(app.querySelector('slicc-dock-tree')).not.toBeNull();
  });

  it('cherry: ignores a pushed document that fails schema validation, keeping the default', async () => {
    // `base` present (so it takes the document path) but no id/version — must
    // degrade rather than render a half-broken arrangement.
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: {
          emitSliccEventToHost: vi.fn(),
          onHostEvent: null,
          layout: JSON.stringify({ base: { center: { panel: 'chat' } } }),
          features: ALL_CHERRY_FEATURES,
        },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    // Enable the gate on the POST-reset module instance — `resetModules` discards
    // the flag state, so initializing before it would silently have no effect.
    // A pushed layout only applies when `panel-layouts` is on; the gate is uniform
    // across floats, so an embed is not an exception.
    const { initFeatureFlags } = await import('../../../src/core/feature-flags.js');
    initFeatureFlags('cherry', { 'panel-layouts': 'on' });
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

    // Not panelized — the classic shell stands.
    expect(app.querySelector('slicc-layout')).toBeNull();
    expect(app.querySelector('slicc-dock-tree')).not.toBeNull();
  });

  it('cherry: falls back to the default layout when the pushed layout is invalid JSON', async () => {
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: {
          emitSliccEventToHost: vi.fn(),
          onHostEvent: null,
          layout: '{not json',
          features: ALL_CHERRY_FEATURES,
        },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await expect(
      mountWcUiFollower(app, { stage: () => {} } as never, 'cherry')
    ).resolves.not.toThrow();
    const dockTree = app.querySelector('slicc-dock-tree') as HTMLElement & {
      getSurfaceIds(): string[];
    };
    // Boot never threw and the default chat placement still applied.
    expect(dockTree.getSurfaceIds()).toContain('chat');
  });

  // Regression (#1706): a hosted-tab follower has no local CDP bridge, so it
  // must not advertise — regardless of `ui-only`, which is a cherry-only
  // parameter. The pre-fix gate (`isCherry && ui-only=1`) evaluated false here
  // and left the follower dialing `wss://www.sliccy.ai/cdp` on a 5s loop.
  it('suppresses CDP advertisement for a hosted-tab follower (no bridge params, NOT cherry)', async () => {
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
        // A hosted `/join/…` tab reaches no Chrome — what the prelude reports
        // for this URL (asserted directly in setup-standalone-prelude.test.ts).
        hasLocalCdpSurface: false,
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
    // No `?bridge=`/`?bridgeToken=` on this URL — no local Chrome to enumerate.
    expect(opts.advertisesCdpTargets).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// followerAdvertisesCdpTargets — the predicate in isolation (#1706)
// ---------------------------------------------------------------------------

describe('followerAdvertisesCdpTargets', () => {
  // Capability AND policy. The capability half is decided by the prelude (see
  // setup-standalone-prelude.test.ts) precisely so this predicate never has to
  // guess a transport from URL shape — the extension-bridge branch reaches real
  // Chrome with no bridge params, and a URL check drops it (#1706 review).
  it('advertises when a local CDP surface exists and policy allows it', async () => {
    const { followerAdvertisesCdpTargets } = await import('../../../src/ui/wc/wc-follower.js');
    expect(followerAdvertisesCdpTargets(true, false)).toBe(true);
  });

  it('does not advertise without a local CDP surface (hosted-tab follower)', async () => {
    const { followerAdvertisesCdpTargets } = await import('../../../src/ui/wc/wc-follower.js');
    expect(followerAdvertisesCdpTargets(false, false)).toBe(false);
  });

  it('ui-only withholds an EXISTING surface (extension drives chrome.debugger)', async () => {
    const { followerAdvertisesCdpTargets } = await import('../../../src/ui/wc/wc-follower.js');
    expect(followerAdvertisesCdpTargets(true, true)).toBe(false);
  });

  it('ui-only cannot conjure a surface that does not exist', async () => {
    const { followerAdvertisesCdpTargets } = await import('../../../src/ui/wc/wc-follower.js');
    expect(followerAdvertisesCdpTargets(false, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cherry follower export selector tests (Fix 1 — wave 2 retry)
// ---------------------------------------------------------------------------

type ExportRequestFn = (
  requestId: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  onProgress: () => void
) => Promise<Blob>;

/** Mount a cherry follower with a controllable currentSync and capture the
 *  wired onExportRequest callback so selector tests can call it directly. */
async function mountCherryWithExportCapture(): Promise<{
  onExportRequest: ExportRequestFn;
  requestTranscriptExport: ReturnType<typeof vi.fn>;
}> {
  const requestTranscriptExport = vi.fn(
    async (_selector: unknown) => new Blob(['zip'], { type: 'application/zip' })
  );
  const currentSync = { requestTranscriptExport };

  // Capture the callback wired onto cherryTransport.onExportRequest via a
  // plain mutable container — avoids the getter/setter + property name clash
  // that TypeScript rejects when mixing them in an object literal.
  const exportCapture: { fn: ExportRequestFn | null } = { fn: null };

  // Build a proxy-like object so wc-follower can assign onExportRequest and we
  // intercept the assignment without a getter+setter name collision.
  const cherryTransport = new Proxy(
    {
      emitSliccEventToHost: vi.fn(),
      onHostEvent: null as ((name: string, detail?: unknown) => void) | null,
      onExportRequest: null as ExportRequestFn | null,
      features: {
        terminal: true,
        files: true,
        memory: true,
        browser: true,
        modelPicker: true,
        history: true,
        nav: true,
        monitor: true,
      },
    },
    {
      set(target, prop, value) {
        if (prop === 'onExportRequest') exportCapture.fn = value as ExportRequestFn | null;
        (target as Record<string | symbol, unknown>)[prop] = value;
        return true;
      },
    }
  );

  vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
    setupStandalonePrelude: vi.fn(async () => ({
      browser: { getTransport: () => ({}), listPages: async () => [] },
      realCdpTransport: {},
      cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
      cherryTransport,
      instanceId: 'i',
    })),
  }));

  // Override startFollowerSpy to return a follower whose currentSync is non-null.
  // Cast to `never` to satisfy the strict return type check on the spy.
  startFollowerSpy.mockImplementationOnce(
    (_opts: StartPageFollowerTrayOptions) => ({ stop: vi.fn(), currentSync }) as never
  );

  vi.resetModules();
  const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
  const app = document.getElementById('app')!;
  await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');

  if (!exportCapture.fn) throw new Error('onExportRequest was not wired');
  return { onExportRequest: exportCapture.fn, requestTranscriptExport };
}

describe('cherry onExportRequest selector routing', () => {
  beforeEach(() => {
    startFollowerSpy.mockClear();
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('maps undefined sessionId to the active selector', async () => {
    const { onExportRequest, requestTranscriptExport } = await mountCherryWithExportCapture();
    await onExportRequest('req-1', undefined, new AbortController().signal, () => {});
    expect(requestTranscriptExport).toHaveBeenCalledWith(
      { kind: 'active' },
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it('maps literal "active" sessionId to the active selector', async () => {
    const { onExportRequest, requestTranscriptExport } = await mountCherryWithExportCapture();
    await onExportRequest('req-2', 'active', new AbortController().signal, () => {});
    expect(requestTranscriptExport).toHaveBeenCalledWith(
      { kind: 'active' },
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it('maps a valid non-"active" sessionId to a frozen selector', async () => {
    const { onExportRequest, requestTranscriptExport } = await mountCherryWithExportCapture();
    await onExportRequest('req-3', 'sess-abc123', new AbortController().signal, () => {});
    expect(requestTranscriptExport).toHaveBeenCalledWith(
      { kind: 'frozen', sessionId: 'sess-abc123' },
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it('rejects with session-not-found for an empty sessionId — does not start a tray export', async () => {
    const { onExportRequest, requestTranscriptExport } = await mountCherryWithExportCapture();
    await expect(
      onExportRequest('req-4', '', new AbortController().signal, () => {})
    ).rejects.toMatchObject({ code: 'session-not-found' });
    expect(requestTranscriptExport).not.toHaveBeenCalled();
  });

  it('rejects with session-not-found for a whitespace-only sessionId — does not start a tray export', async () => {
    const { onExportRequest, requestTranscriptExport } = await mountCherryWithExportCapture();
    await expect(
      onExportRequest('req-5', '   ', new AbortController().signal, () => {})
    ).rejects.toMatchObject({ code: 'session-not-found' });
    expect(requestTranscriptExport).not.toHaveBeenCalled();
  });
});
