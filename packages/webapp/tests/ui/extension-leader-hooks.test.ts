import { describe, it, expect, vi } from 'vitest';
import {
  createExtensionLeaderHooks,
  type ExtensionLeaderHooksOptions,
} from '../../src/ui/extension-leader-hooks.js';

function createBus() {
  type Envelope = { source: string; payload: unknown };
  const panelListeners = new Set<(e: Envelope) => void>();
  const offscreenListeners = new Set<(e: Envelope) => void>();
  return {
    panelSender: {
      send(envelope: { source: 'panel'; payload: unknown }): void {
        for (const l of offscreenListeners) l(envelope);
      },
    },
    panelSubscriber: {
      onMessage(handler: (e: Envelope) => void): () => void {
        panelListeners.add(handler);
        return () => panelListeners.delete(handler);
      },
    },
    /** Inject an envelope as if from offscreen → panel. */
    offscreenToPanel(envelope: Envelope) {
      for (const l of panelListeners) l(envelope);
    },
    /** Capture envelopes sent panel → offscreen. */
    capture(): Envelope[] {
      const captured: Envelope[] = [];
      offscreenListeners.add((env) => captured.push(env));
      return captured;
    },
  };
}

function makeStubs() {
  return {
    sprinkleManager: {
      available: vi.fn(
        () => [] as Array<{ name: string; title: string; path: string; autoOpen: boolean }>
      ),
      opened: vi.fn(() => [] as string[]),
      onChange: vi.fn((_handler: () => void) => () => {}),
      refresh: vi.fn(async () => {}),
      setSendToSprinkleHook: vi.fn(),
    },
    client: {
      selectedScoopJid: null as string | null,
      onScoopSelected: vi.fn((_handler: (jid: string) => void) => () => {}),
    },
    chat: {
      setOnLocalUserMessage: vi.fn(),
    },
    log: { error: vi.fn() },
  };
}

describe('createExtensionLeaderHooks', () => {
  it('does not install hooks on construction (waits for leader-mode-changed)', () => {
    const bus = createBus();
    const s = makeStubs();
    const handle = createExtensionLeaderHooks({
      sender: bus.panelSender,
      subscriber: bus.panelSubscriber,
      ...s,
    });
    expect(handle.isInstalled()).toBe(false);
    expect(s.client.onScoopSelected).not.toHaveBeenCalled();
    expect(s.sprinkleManager.onChange).not.toHaveBeenCalled();
    expect(s.sprinkleManager.setSendToSprinkleHook).not.toHaveBeenCalled();
    expect(s.chat.setOnLocalUserMessage).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('installs hooks when offscreen signals leader-mode-changed: true', () => {
    const bus = createBus();
    const s = makeStubs();
    const handle = createExtensionLeaderHooks({
      sender: bus.panelSender,
      subscriber: bus.panelSubscriber,
      ...s,
    });
    bus.offscreenToPanel({
      source: 'offscreen',
      payload: { type: 'leader-mode-changed', active: true },
    });
    expect(handle.isInstalled()).toBe(true);
    expect(s.client.onScoopSelected).toHaveBeenCalledTimes(1);
    expect(s.sprinkleManager.onChange).toHaveBeenCalledTimes(1);
    expect(s.sprinkleManager.setSendToSprinkleHook).toHaveBeenCalledTimes(1);
    expect(s.chat.setOnLocalUserMessage).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('install immediately fires pushActiveScoop if selectedScoopJid is already set', async () => {
    const bus = createBus();
    const s = makeStubs();
    s.client.selectedScoopJid = 'scoop-7';
    const captured = bus.capture();
    const handle = createExtensionLeaderHooks({
      sender: bus.panelSender,
      subscriber: bus.panelSubscriber,
      ...s,
    });
    bus.offscreenToPanel({
      source: 'offscreen',
      payload: { type: 'leader-mode-changed', active: true },
    });
    // Drain any pending microtasks (refresh().then(...) runs async).
    await Promise.resolve();
    const activeScoopMsg = captured.find(
      (e) =>
        e.source === 'panel' && (e.payload as { type?: string })?.type === 'leader-active-scoop'
    );
    expect(activeScoopMsg).toBeDefined();
    expect((activeScoopMsg!.payload as { scoopJid?: string }).scoopJid).toBe('scoop-7');
    handle.dispose();
  });

  it('install calls sprinkleManager.refresh() then pushes a snapshot', async () => {
    const bus = createBus();
    const s = makeStubs();
    s.sprinkleManager.available = vi.fn(() => [
      { name: 'welcome', title: 'W', path: '/w.shtml', autoOpen: false },
    ]);
    s.sprinkleManager.opened = vi.fn(() => ['welcome']);
    const captured = bus.capture();
    const handle = createExtensionLeaderHooks({
      sender: bus.panelSender,
      subscriber: bus.panelSubscriber,
      ...s,
    });
    bus.offscreenToPanel({
      source: 'offscreen',
      payload: { type: 'leader-mode-changed', active: true },
    });
    await Promise.resolve();
    await Promise.resolve(); // refresh().then(...) — one extra tick for the chained then
    expect(s.sprinkleManager.refresh).toHaveBeenCalled();
    const snapshotMsg = captured.find(
      (e) =>
        e.source === 'panel' &&
        (e.payload as { type?: string })?.type === 'leader-sprinkles-snapshot'
    );
    expect(snapshotMsg).toBeDefined();
    expect(
      (snapshotMsg!.payload as { sprinkles?: Array<{ name: string; open: boolean }> }).sprinkles
    ).toEqual([{ name: 'welcome', title: 'W', path: '/w.shtml', open: true, autoOpen: false }]);
    handle.dispose();
  });

  it('removes hooks when offscreen signals leader-mode-changed: false', () => {
    const bus = createBus();
    const s = makeStubs();
    const unsubScoop = vi.fn();
    const unsubSprinkles = vi.fn();
    s.client.onScoopSelected = vi.fn(() => unsubScoop);
    s.sprinkleManager.onChange = vi.fn(() => unsubSprinkles);
    const handle = createExtensionLeaderHooks({
      sender: bus.panelSender,
      subscriber: bus.panelSubscriber,
      ...s,
    });
    bus.offscreenToPanel({
      source: 'offscreen',
      payload: { type: 'leader-mode-changed', active: true },
    });
    expect(handle.isInstalled()).toBe(true);
    bus.offscreenToPanel({
      source: 'offscreen',
      payload: { type: 'leader-mode-changed', active: false },
    });
    expect(handle.isInstalled()).toBe(false);
    expect(unsubScoop).toHaveBeenCalled();
    expect(unsubSprinkles).toHaveBeenCalled();
    expect(s.sprinkleManager.setSendToSprinkleHook).toHaveBeenLastCalledWith(undefined);
    expect(s.chat.setOnLocalUserMessage).toHaveBeenLastCalledWith(undefined);
    handle.dispose();
  });

  it('double-install is a no-op', () => {
    const bus = createBus();
    const s = makeStubs();
    const handle = createExtensionLeaderHooks({
      sender: bus.panelSender,
      subscriber: bus.panelSubscriber,
      ...s,
    });
    bus.offscreenToPanel({
      source: 'offscreen',
      payload: { type: 'leader-mode-changed', active: true },
    });
    bus.offscreenToPanel({
      source: 'offscreen',
      payload: { type: 'leader-mode-changed', active: true },
    });
    expect(s.client.onScoopSelected).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('remove-without-install is a no-op', () => {
    const bus = createBus();
    const s = makeStubs();
    const handle = createExtensionLeaderHooks({
      sender: bus.panelSender,
      subscriber: bus.panelSubscriber,
      ...s,
    });
    expect(() =>
      bus.offscreenToPanel({
        source: 'offscreen',
        payload: { type: 'leader-mode-changed', active: false },
      })
    ).not.toThrow();
    handle.dispose();
  });

  it('dispose() removes hooks AND disposes the proxy', () => {
    const bus = createBus();
    const s = makeStubs();
    const proxyDispose = vi.fn();
    const proxyFactory: NonNullable<ExtensionLeaderHooksOptions['_proxyFactory']> = (
      _sender,
      _subscriber,
      _listeners
    ) =>
      ({
        pushSprinklesSnapshot: vi.fn(),
        pushSprinkleUpdate: vi.fn(),
        pushUserMessageEcho: vi.fn(),
        pushActiveScoop: vi.fn(),
        requestModeState: vi.fn(),
        resetTray: vi.fn(),
        dispose: proxyDispose,
      }) as any;
    const handle = createExtensionLeaderHooks({
      sender: bus.panelSender,
      subscriber: bus.panelSubscriber,
      ...s,
      _proxyFactory: proxyFactory,
    });
    handle.dispose();
    expect(proxyDispose).toHaveBeenCalled();
    expect(handle.isInstalled()).toBe(false);
  });

  it('disposed → leader-mode-changed: true is a no-op (does not re-install)', () => {
    // Pins the `installed || disposed` gate inside installLeaderHooks() —
    // late activation after teardown must NOT re-install hooks.
    // Without that gate, an offscreen-side late `leader-mode-changed: true`
    // (e.g., a delayed reply from a previous session) would reach a
    // disposed handle and re-attach listeners against now-dead bus
    // subscribers — silent leak.
    const bus = createBus();
    const s = makeStubs();
    const handle = createExtensionLeaderHooks({
      sender: bus.panelSender,
      subscriber: bus.panelSubscriber,
      ...s,
    });
    handle.dispose();
    // After dispose, a late offscreen activation must NOT re-install hooks.
    bus.offscreenToPanel({
      source: 'offscreen',
      payload: { type: 'leader-mode-changed', active: true },
    });
    expect(handle.isInstalled()).toBe(false);
    expect(s.client.onScoopSelected).not.toHaveBeenCalled();
    expect(s.sprinkleManager.onChange).not.toHaveBeenCalled();
    expect(s.sprinkleManager.setSendToSprinkleHook).not.toHaveBeenCalled();
    expect(s.chat.setOnLocalUserMessage).not.toHaveBeenCalled();
  });

  it('sends requestModeState() at construction', () => {
    const bus = createBus();
    const s = makeStubs();
    const captured = bus.capture();
    const handle = createExtensionLeaderHooks({
      sender: bus.panelSender,
      subscriber: bus.panelSubscriber,
      ...s,
    });
    const requestMsg = captured.find(
      (e) =>
        e.source === 'panel' &&
        (e.payload as { type?: string })?.type === 'leader-request-mode-state'
    );
    expect(requestMsg).toBeDefined();
    handle.dispose();
  });
});
