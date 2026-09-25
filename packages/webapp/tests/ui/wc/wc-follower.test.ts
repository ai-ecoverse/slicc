// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.sliccy.ai/join/tray-1.cap-token" }
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartPageFollowerTrayOptions } from '../../../src/ui/page-follower-tray.js';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

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

function bootLog(): never {
  return { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} } as never;
}

describe('bootFollowerFloat', () => {
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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    expect(startFollowerSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).not.toHaveBeenCalled();

    const opts = startFollowerSpy.mock.calls[0]![0];
    expect(opts.runtime).toBe('slicc-standalone');
    expect(opts.browserAPI).toBeTruthy();
  }, 10_000);

  it('drives the floatbar status beacon from the follower tray status (#1707)', async () => {
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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');

    const floatbar = app.querySelector('slicc-floatbar') as HTMLElement;
    expect(floatbar).toBeTruthy();
    expect(floatbar.getAttribute('connection')).toBe('offline');

    setFollowerTrayRuntimeStatus({ ...inactive, state: 'connected' });
    expect(floatbar.getAttribute('connection')).toBe('live');

    setFollowerTrayRuntimeStatus({ ...inactive, state: 'error', error: 'Data channel closed' });
    expect(floatbar.getAttribute('connection')).toBe('error');
  });

  it('wires the composer add-menu so a staged attachment forwards to the leader on submit', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');

    const opts = startFollowerSpy.mock.calls[0]![0];
    const sendMessage = vi.fn();
    const selectScoop = vi.fn();
    (startFollowerSpy.mock.results[0]!.value as { currentSync: unknown }).currentSync = {
      sendMessage,
      selectScoop,
      stop: vi.fn(),
    };

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

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'snap.png', { type: 'image/png' });
    inputCard.dispatchEvent(
      new CustomEvent('slicc-add', {
        bubbles: true,
        detail: { kind: 'upload', name: 'snap.png', size: 4, file },
      })
    );

    await vi.waitFor(() => {
      expect(inputCard.querySelector('.wcatt__chip')).toBeTruthy();
    });

    inputCard.dispatchEvent(new CustomEvent('submit', { detail: { value: 'look at this' } }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [text, messageId, attachments] = sendMessage.mock.calls[0]! as [
      string,
      string,
      Array<{ kind: string; data?: string; path?: string }>,
    ];
    expect(text).toBe('look at this');

    expect(messageId).toEqual(expect.any(String));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.kind).toBe('image');
    expect(attachments[0]!.data).toBeTruthy();
    expect(attachments[0]!.path).toBeUndefined();
  });

  it('arms push-to-talk on a real-tab follower (non-ui-only) so voice can activate', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;

    await bootFollowerFloat(app, bootLog(), 'follower');

    const composer = app.querySelector('slicc-composer') as HTMLElement | null;
    expect(composer).toBeTruthy();
    expect(composer!.hasAttribute('ptt')).toBe(true);
    const menu = app.querySelector('slicc-add-menu') as HTMLElement | null;
    expect(menu?.hasAttribute('no-camera')).toBe(false);
  });

  it('loads the dip + sprinkle chrome stylesheets (leader-only paths the follower skips)', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');

    await vi.waitFor(() => {
      expect(loadDipStyles).toHaveBeenCalled();
      expect(loadSprinkleStyles).toHaveBeenCalled();
    });
  });

  it('hydrates inline dips (shtml) in the follower so the welcome/onboarding nudge renders', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];

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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');

    const switcher = app.querySelector('slicc-agent-tabs') as HTMLElement & {
      glower(): void;
      scrutinize(): void;
      wake(): void;
    };
    const glower = vi.spyOn(switcher, 'glower');
    const scrutinize = vi.spyOn(switcher, 'scrutinize');

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

    emit({ type: 'tool_result', messageId: 'm1', toolName: 'bash', result: 'ok' });
    expect(glower).not.toHaveBeenCalled();

    emit({ type: 'tool_result', messageId: 'm2', toolName: 'bash', result: 'boom', isError: true });
    expect(glower).toHaveBeenCalledTimes(1);

    app.querySelector('slicc-input-card')?.dispatchEvent(new Event('input', { bubbles: true }));
    expect(scrutinize).toHaveBeenCalled();
  });

  it('renders a leader-broadcast tool_ui approval card as a static "waiting on the leader" placeholder, not live buttons', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');

    const opts = startFollowerSpy.mock.calls[0]![0];

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

    expect(iframe?.srcdoc).not.toContain('/workspace/mnt/docs');
    expect(iframe?.srcdoc).not.toContain('Mount local directoryTarget:');
  });

  it('replaces the inert Files/Terminal/Memory/Monitor panels with a placeholder (no local VFS/shell/kernel)', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');

    const fileTree = app.querySelector('slicc-file-tree') as HTMLElement | null;
    expect(fileTree).toBeTruthy();
    expect(fileTree!.style.display).toBe('none');

    const monitor = app.querySelector('slicc-monitor') as HTMLElement | null;
    expect(monitor).toBeTruthy();
    expect(monitor!.style.display).toBe('none');

    const texts = Array.from(app.querySelectorAll('.wcui-placeholder')).map(
      (e) => e.textContent ?? ''
    );
    expect(texts.some((t) => t.includes('Files live on the leader'))).toBe(true);
    expect(texts.some((t) => t.includes('The shell runs on the leader'))).toBe(true);
    expect(texts.some((t) => t.includes('Memory lives on the leader'))).toBe(true);
    expect(texts.some((t) => t.includes('Monitor reads the leader'))).toBe(true);
  });

  it('disables the composer with a connecting placeholder until the leader connects', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const switcher = app.querySelector('slicc-agent-tabs') as HTMLElement & {
      connection: string;
    };

    expect(inputCard.hasAttribute('disabled')).toBe(true);
    expect(inputCard.getAttribute('placeholder')).toBe('Connecting to leader…');
    expect(switcher.connection).toBe('disconnected');

    const opts = startFollowerSpy.mock.calls[0]![0];
    opts.onConnectionChange?.(true);
    expect(switcher.connection).toBe('connected');
    expect(inputCard.hasAttribute('disabled')).toBe(true);
    expect(inputCard.getAttribute('placeholder')).toBe('Connecting to leader…');

    opts.onSnapshot?.([], 'cone_1');
    expect(inputCard.hasAttribute('disabled')).toBe(false);
    expect(inputCard.getAttribute('placeholder')).toBe('Ask the leader, or describe a change…');

    opts.onConnectionChange?.(false);
    expect(inputCard.hasAttribute('disabled')).toBe(true);
    expect(inputCard.getAttribute('placeholder')).toBe('Connecting to leader…');
    expect(switcher.connection).toBe('disconnected');
  });

  it('aborts the leader’s turn from the follower’s own Stop button (#2382)', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
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

    inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true }));
    expect(stop).not.toHaveBeenCalled();

    opts.onStatus?.('processing', 'cone_1');
    inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true }));
    expect(stop).toHaveBeenCalledTimes(1);

    expect(selectScoop).not.toHaveBeenCalled();
  });

  it('says so when a sent prompt gets no reaction from the leader', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const { PROMPT_SILENCE_NOTE, FOLLOWER_PROMPT_SILENCE_MS } = await import(
      '../../../src/ui/wc/follower-prompt-watch.js'
    );
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const opts = startFollowerSpy.mock.calls[0]![0];
    (startFollowerSpy.mock.results[0]!.value as { currentSync: unknown }).currentSync = {
      sendMessage: vi.fn(() => true),
      selectScoop: vi.fn(),
      stop: vi.fn(() => true),
    };
    let emit: (event: unknown) => void = () => {};
    opts.onConnectionChange?.(true);
    opts.setChatAgent?.({
      sendMessage: vi.fn(),
      onEvent: (listener: (event: unknown) => void) => {
        emit = listener;
        return () => {};
      },
      stop: () => {},
    } as never);
    opts.onSnapshot?.([], 'cone_1');
    const textOf = (root: ParentNode): string =>
      [...root.querySelectorAll('*')]
        .map((el) => (el.shadowRoot ? textOf(el.shadowRoot) : '') + (el.textContent ?? ''))
        .join(' ');
    const note = PROMPT_SILENCE_NOTE.replace(/_/g, '').slice(0, 40);

    vi.useFakeTimers();
    try {
      inputCard.dispatchEvent(new CustomEvent('submit', { detail: { value: 'first' } }));
      emit({ type: 'message_start', messageId: 'a1' });
      vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
      opts.onStatus?.('ready', 'cone_1');
      expect(textOf(app)).not.toContain(note);

      inputCard.dispatchEvent(new CustomEvent('submit', { detail: { value: 'second' } }));
      vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(textOf(app)).toContain(note));
  });

  it('counts a biscotto review-state frame as the leader reacting to the prompt', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const { FOLLOWER_PROMPT_SILENCE_MS } = await import(
      '../../../src/ui/wc/follower-prompt-watch.js'
    );
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const opts = startFollowerSpy.mock.calls[0]![0];
    (startFollowerSpy.mock.results[0]!.value as { currentSync: unknown }).currentSync = {
      sendMessage: vi.fn(() => true),
      selectScoop: vi.fn(),
      stop: vi.fn(() => true),
    };
    opts.onConnectionChange?.(true);
    opts.setChatAgent?.({ sendMessage: vi.fn(), onEvent: () => () => {}, stop: () => {} } as never);
    opts.onSnapshot?.([], 'cone_1');
    const textOf = (root: ParentNode): string =>
      [...root.querySelectorAll('*')]
        .map((el) => (el.shadowRoot ? textOf(el.shadowRoot) : '') + (el.textContent ?? ''))
        .join(' ');

    vi.useFakeTimers();
    try {
      inputCard.dispatchEvent(new CustomEvent('submit', { detail: { value: 'guest ask' } }));
      opts.onBiscottoMessageState?.('m1', 'pending');
      vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(textOf(app)).toContain('Sent for review'));
    expect(textOf(app)).not.toContain('has not picked this up');
  });

  it('does not treat an empty activeScoopJid as an addressable unit', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const opts = startFollowerSpy.mock.calls[0]![0];

    opts.onConnectionChange?.(true);

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

  it('renders a re-selected unit ONCE, from the fresh snapshot (#2382 PR B)', async () => {
    const { WcChatController } = await import('../../../src/ui/wc/wc-chat-controller.js');
    const loadMessages = vi.spyOn(WcChatController.prototype, 'loadMessages');
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];
    (startFollowerSpy.mock.results[0]!.value as { currentSync: unknown }).currentSync = {
      selectScoop: vi.fn(),
      sendMessage: vi.fn(),
      stop: vi.fn(),
    };
    const switcher = app.querySelector('slicc-agent-tabs')!;
    const roster = [
      { assistantLabel: 'sliccy', folder: 'cone', jid: 'cone_a', name: 'a', parentId: null },
      { assistantLabel: 'sliccy', folder: 'cone-b', jid: 'cone_b', name: 'b', parentId: null },
    ];
    opts.onScoopsList?.(roster as never, 'cone_a');
    opts.onConnectionChange?.(true);

    opts.onSnapshot?.([{ id: 'a1', role: 'user', content: 'first' }] as never, 'cone_a');
    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'cone_b' } }));
    opts.onSnapshot?.([{ id: 'b1', role: 'user', content: 'bee' }] as never, 'cone_b');

    loadMessages.mockClear();
    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'cone_a' } }));
    expect(loadMessages).not.toHaveBeenCalled();

    opts.onSnapshot?.([{ id: 'a2', role: 'user', content: 'fresh a' }] as never, 'cone_a');
    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(loadMessages.mock.calls[0]?.[0]).toEqual([
      { id: 'a2', role: 'user', content: 'fresh a' },
    ]);
    loadMessages.mockRestore();
  });

  it('does not re-select the shown unit on every roster push (#2382 D2b)', async () => {
    const { WcChatController } = await import('../../../src/ui/wc/wc-chat-controller.js');
    const loadMessages = vi.spyOn(WcChatController.prototype, 'loadMessages');
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];

    const selectScoop = vi.fn();
    (startFollowerSpy.mock.results[0]!.value as { currentSync: unknown }).currentSync = {
      selectScoop,
      sendMessage: vi.fn(),
      stop: vi.fn(),
    };
    const roster = [
      { assistantLabel: 'sliccy', folder: 'cone', jid: 'cone_a', name: 'a', parentId: null },
    ];

    opts.onScoopsList?.(roster as never, 'cone_a');
    expect(selectScoop).toHaveBeenCalledTimes(1);
    expect(selectScoop).toHaveBeenCalledWith('cone_a');
    opts.onSnapshot?.([{ id: 'a1', role: 'user', content: 'first' }] as never, 'cone_a');
    loadMessages.mockClear();
    selectScoop.mockClear();

    opts.onScoopsList?.(roster as never, 'cone_a');
    opts.onScoopsList?.(roster as never, 'cone_a');
    expect(selectScoop).not.toHaveBeenCalled();
    expect(loadMessages).not.toHaveBeenCalled();
    loadMessages.mockRestore();
  });

  it("holds a sprinkle's slicc.selectScoop while the user is mid-draft", async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];
    const selectScoop = vi.fn();
    (startFollowerSpy.mock.results[0]!.value as { currentSync: unknown }).currentSync = {
      selectScoop,
      sendMessage: vi.fn(),
      stop: vi.fn(),
    };
    opts.onScoopsList?.(
      [
        { assistantLabel: 'sliccy', folder: 'cone', jid: 'cone_a', name: 'a', parentId: null },
        { assistantLabel: 'sliccy', folder: 'cone-b', jid: 'cone_b', name: 'b', parentId: null },
      ] as never,
      'cone_a'
    );
    opts.onConnectionChange?.(true);
    selectScoop.mockClear();

    const inputCard = app.querySelector('slicc-input-card') as HTMLElement & { value: string };
    const textarea = inputCard.querySelector('textarea')!;
    inputCard.value = 'half a sent';
    textarea.focus();
    expect(await opts.onSelectScoop?.('cone:cone-b')).toBe(false);
    expect(selectScoop).not.toHaveBeenCalled();

    textarea.blur();
    expect(await opts.onSelectScoop?.('cone:cone-b')).toBe(true);
    expect(selectScoop).toHaveBeenCalledWith('cone_b');
  });

  it('keeps showing a guest thread the roster never describes (#2382 D2b)', async () => {
    const { WcChatController } = await import('../../../src/ui/wc/wc-chat-controller.js');
    const loadMessages = vi.spyOn(WcChatController.prototype, 'loadMessages');
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];
    const selectScoop = vi.fn();
    const stop = vi.fn();
    (startFollowerSpy.mock.results[0]!.value as { currentSync: unknown }).currentSync = {
      selectScoop,
      sendMessage: vi.fn(),
      stop,
    };
    const inputCard = app.querySelector('slicc-input-card')!;
    const switcher = app.querySelector('slicc-agent-tabs') as HTMLElement & { scoops: unknown[] };
    const meta = app.querySelector('slicc-composer-meta') as HTMLElement & { model?: string };

    inputCard.dispatchEvent(new CustomEvent('stop'));
    expect(stop).not.toHaveBeenCalled();

    opts.onConnectionChange?.(true);
    opts.onSnapshot?.([{ id: 'g1', role: 'assistant', content: 'hello guest' }] as never, 'seat_1');

    expect(loadMessages.mock.calls.at(-1)?.[0]).toEqual([
      { id: 'g1', role: 'assistant', content: 'hello guest' },
    ]);

    expect(inputCard.hasAttribute('disabled')).toBe(false);

    expect(switcher.scoops).toEqual([]);

    expect(selectScoop).not.toHaveBeenCalled();

    expect(meta.getAttribute('model')).toBe('Preview');

    const thread = app.querySelector('slicc-chat-thread')!;
    expect(thread.getAttribute('context')).toBe('cone');
    expect(thread.getAttribute('accent')).toBe('var(--waffle)');
    loadMessages.mockRestore();
  });

  it('repaints the model pill for the unit a tab click shows (#2382 PR C)', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const opts = startFollowerSpy.mock.calls[0]![0];
    (startFollowerSpy.mock.results[0]!.value as { currentSync: unknown }).currentSync = {
      selectScoop: vi.fn(),
      sendMessage: vi.fn(),
      stop: vi.fn(),
    };
    const meta = app.querySelector('slicc-composer-meta') as HTMLElement & { model?: string };
    const switcher = app.querySelector('slicc-agent-tabs')!;

    opts.onConnectionChange?.(true);
    opts.onScoopsList?.(
      [
        {
          assistantLabel: 'sliccy',
          folder: 'cone',
          jid: 'cone_a',
          model: { provider: 'anthropic', id: 'claude-opus-4-6' },
          name: 'a',
          parentId: null,
          state: 'idle',
        },
        {
          assistantLabel: 'sliccy',
          folder: 'cone-b',
          jid: 'cone_b',
          model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
          name: 'b',
          parentId: null,
          state: 'idle',
        },
      ] as never,
      'cone_a'
    );
    opts.onModelsList?.([
      {
        providerName: 'A',
        modelId: 'anthropic:claude-opus-4-6',
        modelName: 'Opus',
        reasoning: true,
      },
      {
        providerName: 'A',
        modelId: 'anthropic:claude-sonnet-4-6',
        modelName: 'Sonnet',
        reasoning: true,
      },
    ]);
    opts.onModelState?.({ activeModelId: 'anthropic:claude-opus-4-6', scoopJid: 'cone_a' });
    expect(meta.model).toBe('Opus');

    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'cone_b' } }));

    expect(meta.model).toBe('Sonnet');

    opts.onModelState?.({ activeModelId: 'anthropic:claude-opus-4-6', scoopJid: 'cone_b' });
    expect(meta.model).toBe('Opus');
  });

  it('keeps the composer shut after a reconnect until the NEW session names a unit', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const opts = startFollowerSpy.mock.calls[0]![0];

    opts.onConnectionChange?.(true);
    opts.onSnapshot?.([], 'cone_1');
    expect(inputCard.hasAttribute('disabled')).toBe(false);

    opts.onConnectionChange?.(false);
    opts.onConnectionChange?.(true);

    expect(inputCard.hasAttribute('disabled')).toBe(true);

    expect(opts.getSelectedScoopJid?.()).toBe('cone_1');

    opts.onSnapshot?.([], 'cone_2');
    expect(inputCard.hasAttribute('disabled')).toBe(false);
    expect(opts.getSelectedScoopJid?.()).toBe('cone_2');
  });

  it('opens the composer off the first scoops.list when no snapshot arrived yet', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const opts = startFollowerSpy.mock.calls[0]![0];

    opts.onConnectionChange?.(true);
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

  it('keeps model controls hidden before the catalog and for a legacy leader connection', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const meta = app.querySelector('slicc-composer-meta') as HTMLElement;
    const opts = startFollowerSpy.mock.calls[0]![0];

    expect(meta.style.display).toBe('none');

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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
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

    expect(orderFor()).toEqual(['cone-a', 'cone-b', 'scoop-a', 'scoop-b']);

    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-b' } }));

    expect(orderFor()).toEqual(['cone-a', 'cone-b', 'scoop-b', 'scoop-a']);
  });

  it('unmounts the composer when the follower views a scoop, and restores it on the cone (#2312)', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
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
    const { initFeatureFlags } = await import('../../../src/core/feature-flags.js');
    initFeatureFlags('follower', { 'multiple-cones': 'off' });
    try {
      const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
      const app = document.getElementById('app')!;
      await bootFollowerFloat(app, bootLog(), 'follower');
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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
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
      const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
      const app = document.getElementById('app')!;
      await bootFollowerFloat(app, bootLog(), 'follower');
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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');
    const inputCard = app.querySelector('slicc-input-card')!;
    const opts = startFollowerSpy.mock.calls[0]![0];
    opts.onGaveUp?.(new Error('bad join url'));
    expect(inputCard.hasAttribute('disabled')).toBe(true);
    expect(inputCard.getAttribute('placeholder')).toBe(
      "Couldn't reach the leader. Reload to retry."
    );
  });

  it('the avatar-menu "Disconnect from leader" action dispatches slicc:tray-leave', async () => {
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');

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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');
    expect(startFollowerSpy).toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();

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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');
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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');
    const opts = startFollowerSpy.mock.calls[0]![0];

    opts.onConnectionChange?.(true);
    expect(emit).toHaveBeenCalledWith('slicc.follower.ready');

    opts.onConnectionChange?.(false);
    expect(emit).toHaveBeenCalledWith('slicc.follower.disconnected');

    emit.mockClear();
    opts.onGaveUp?.(new Error('bad join url'));
    expect(emit).toHaveBeenCalledWith('slicc.follower.disconnected');
  });

  it('extension side panel: routes the cone-error "Open settings" CTA to the leader tab (settings/OAuth run there, not the panel)', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();

    setCherryLocation('chrome-extension://abcdef');
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

    const avatarMenu = app.querySelector('slicc-avatar-menu') as HTMLElement & {
      items?: Array<{ id?: string; label?: string }>;
    };
    expect(avatarMenu.items?.some((i) => i.id === 'focus-leader-tab')).toBe(true);

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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

    const avatarMenu = app.querySelector('slicc-avatar-menu') as HTMLElement & {
      items?: Array<{ id?: string }>;
    };

    expect(avatarMenu.items?.some((i) => i.id === 'focus-leader-tab')).toBe(false);
  });

  it('general cherry embed (NOT side panel): does NOT route the error-card CTA to a leader tab', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();

    setCherryLocation('https://third-party.example');
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

    const thread = app.querySelector('slicc-chat-thread')!;
    thread.dispatchEvent(
      new CustomEvent('slicc-error-open-settings', { bubbles: true, composed: true })
    );

    expect(emit).not.toHaveBeenCalledWith('slicc.open-leader-tab');
    expect(app.querySelector('.wc-signin-redirect')).toBeNull();
  });

  it('extension side panel: replaces the onboarding welcome dip with a leader hand-off card', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();
    setCherryLocation('chrome-extension://abcdef');
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');
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

    await vi.waitFor(() => {
      expect(app.querySelector('.wc-signin-redirect')).toBeTruthy();
    });
    expect(app.querySelector('.wc-signin-redirect')!.textContent).toContain(
      'Set up SLICC in the main tab'
    );

    expect(app.querySelector('.msg__dip')).toBeNull();

    expect(emit).not.toHaveBeenCalledWith('slicc.open-leader-tab');
    (app.querySelector('.wc-signin-redirect__open') as HTMLButtonElement).click();
    expect(emit).toHaveBeenCalledWith('slicc.open-leader-tab');
  });

  it('general cherry embed: keeps the real welcome dip (no leader hand-off replacement)', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();
    setCherryLocation('https://third-party.example');
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');
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

    await vi.waitFor(() => {
      expect(app.querySelector('.msg__dip')).toBeTruthy();
    });
    expect(app.querySelector('.wc-signin-redirect')).toBeNull();
  });

  it('every follower drops the gelatiere suggestions dip instead of hydrating it', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();

    setCherryLocation('https://third-party.example');
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');
    const opts = startFollowerSpy.mock.calls[0]![0];

    opts.onSnapshot?.(
      [
        {
          id: 'delivery-msg',
          role: 'assistant',
          content:
            'The gelatiere left 2 suggestions.\n\n![Suggestions](/shared/sprinkles/suggestions/suggestions.shtml)',
          timestamp: 1000,
        },
      ],
      'cone'
    );

    await vi.waitFor(() => {
      expect(app.textContent).toContain('The gelatiere left 2 suggestions.');
    });
    expect(app.querySelector('img[src^="/shared/sprinkles/suggestions/"]')).toBeNull();
    expect(app.querySelector('.msg__dip')).toBeNull();
    expect(app.querySelector('.wc-signin-redirect')).toBeNull();
  });

  it('extension side panel: a suggestions dip retracts the stale welcome hand-off card', async () => {
    const emit = vi.fn();
    mockCherryPrelude(emit);
    vi.resetModules();
    setCherryLocation('chrome-extension://abcdef');
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');
    const opts = startFollowerSpy.mock.calls[0]![0];

    opts.onSnapshot?.(
      [
        {
          id: 'welcome-msg',
          role: 'assistant',
          content: '![Welcome](/shared/sprinkles/welcome/welcome.shtml)',
          timestamp: 1000,
        },
        {
          id: 'delivery-msg',
          role: 'assistant',
          content: '![Suggestions](/shared/sprinkles/suggestions/suggestions.shtml)',
          timestamp: 2000,
        },
      ],
      'cone'
    );

    await vi.waitFor(() => {
      expect(app.querySelector('img[src^="/shared/sprinkles/"]')).toBeNull();
    });
    expect(app.querySelector('.wc-signin-redirect--welcome')).toBeNull();

    opts.onSnapshot?.(
      [
        {
          id: 'welcome-msg',
          role: 'assistant',
          content: '![Welcome](/shared/sprinkles/welcome/welcome.shtml)',
          timestamp: 1000,
        },
      ],
      'cone'
    );
    await vi.waitFor(() => {
      expect(app.querySelector('img[src^="/shared/sprinkles/welcome/"]')).toBeNull();
    });
    expect(app.querySelector('.wc-signin-redirect--welcome')).toBeNull();
  });

  it('reads ?ui-only=1 and suppresses CDP advertisement via startPageFollowerTray when cherry', async () => {
    Object.defineProperty(window, 'location', {
      value: {
        href: 'https://www.sliccy.ai/join/tray-1.cap-token?cherry=1&ui-only=1',
        search: '?cherry=1&ui-only=1',
      },
      writable: true,
    });

    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

    expect(startFollowerSpy).toHaveBeenCalledTimes(1);
    const opts = startFollowerSpy.mock.calls[0]![0];
    expect(opts.advertisesCdpTargets).toBe(false);

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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');
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

    const { initFeatureFlags } = await import('../../../src/core/feature-flags.js');
    initFeatureFlags('cherry', { 'panel-layouts': 'on' });
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

    const dockTree = app.querySelector('slicc-dock-tree') as HTMLElement & {
      getSurfaceIds(): string[];
      removeSurface(id: string): void;
      tilesMovable: boolean;
    };
    expect(dockTree.tilesMovable).toBe(true);
    expect(dockTree.getSurfaceIds()).toEqual(expect.arrayContaining(['chat', 'files']));

    dockTree.removeSurface('files');
    expect(dockTree.getSurfaceIds()).toContain('files');

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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

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

    const { initFeatureFlags } = await import('../../../src/core/feature-flags.js');
    initFeatureFlags('cherry', { 'panel-layouts': 'on' });
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

    const layout = app.querySelector('slicc-layout') as HTMLElement & {
      getLayout(): { id: string; locked?: boolean };
      isLocked(id: string): boolean;
    };
    expect(layout).not.toBeNull();
    expect(layout.getLayout().id).toBe('embed');

    expect(layout.isLocked('chat')).toBe(true);
    expect(app.querySelector('slicc-panel[panel-id="chat"]')?.hasAttribute('locked')).toBe(true);
  });

  it('cherry: IGNORES a pushed layout while the panel-layouts flag is off', async () => {
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

    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

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

    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

    expect(app.querySelector('slicc-layout')).toBeNull();
    expect(app.querySelector('slicc-dock-tree')).not.toBeNull();
  });

  it('cherry: ignores a pushed document that fails schema validation, keeping the default', async () => {
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

    const { initFeatureFlags } = await import('../../../src/core/feature-flags.js');
    initFeatureFlags('cherry', { 'panel-layouts': 'on' });
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'cherry');

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
    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await expect(bootFollowerFloat(app, bootLog(), 'cherry')).resolves.not.toThrow();
    const dockTree = app.querySelector('slicc-dock-tree') as HTMLElement & {
      getSurfaceIds(): string[];
    };

    expect(dockTree.getSurfaceIds()).toContain('chat');
  });

  it('suppresses CDP advertisement for a hosted-tab follower (no bridge params, NOT cherry)', async () => {
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: { on: vi.fn(), off: vi.fn(), send: vi.fn(async () => ({})) },
        cherryJoinUrl: undefined,
        cherryTransport: undefined,
        instanceId: 'i',

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

    const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await bootFollowerFloat(app, bootLog(), 'follower');

    const opts = startFollowerSpy.mock.calls[0]![0];

    expect(opts.advertisesCdpTargets).toBe(false);
  });
});

describe('followerAdvertisesCdpTargets', () => {
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

type ExportRequestFn = (
  requestId: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  onProgress: () => void
) => Promise<Blob>;

async function mountCherryWithExportCapture(): Promise<{
  onExportRequest: ExportRequestFn;
  requestTranscriptExport: ReturnType<typeof vi.fn>;
}> {
  const requestTranscriptExport = vi.fn(
    async (_selector: unknown) => new Blob(['zip'], { type: 'application/zip' })
  );
  const currentSync = { requestTranscriptExport };

  const exportCapture: { fn: ExportRequestFn | null } = { fn: null };

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

  startFollowerSpy.mockImplementationOnce(
    (_opts: StartPageFollowerTrayOptions) => ({ stop: vi.fn(), currentSync }) as never
  );

  vi.resetModules();
  const { bootFollowerFloat } = await import('../../../src/ui/wc/wc-follower.js');
  const app = document.getElementById('app')!;
  await bootFollowerFloat(app, bootLog(), 'cherry');

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
