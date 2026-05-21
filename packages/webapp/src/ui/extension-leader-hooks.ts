/**
 * Extension-leader panel hooks — install/remove wiring driven by
 * `leader-mode-changed` signals from the offscreen factory.
 *
 * Extracted from `mainExtension` so the install/remove sequence can be
 * unit-tested with stubs. The production wiring in `main.ts` calls
 * `createExtensionLeaderHooks(...)` once at boot and lets the proxy's
 * `onLeaderModeChange` callback drive install/remove transitions.
 *
 * Why this exists separately: the four panel-originated channels
 * (pushActiveScoop, pushSprinklesSnapshot, pushSprinkleUpdate,
 * pushUserMessageEcho) fail silently. A bug here breaks the leader →
 * follower sync without any user-visible diagnostic — exactly the
 * failure shape #682 was filed for, but on the panel side.
 */

import { PanelLeaderSyncProxy } from '../../../chrome-extension/src/leader-sync-bridge.js';
import type {
  PanelMessageSender,
  PanelMessageSubscriber,
} from '../../../chrome-extension/src/bridge-transport.js';
import type { MessageAttachment } from '../core/attachments.js';

/** Minimal `SprinkleManager` surface this module needs. Keeps the test
 *  stub small — we don't need to fake the full sprinkle subsystem. */
export interface ExtensionLeaderSprinkleManagerLike {
  available(): Array<{ name: string; title: string; path: string; autoOpen: boolean }>;
  opened(): string[];
  onChange(handler: () => void): () => void;
  refresh(): Promise<void>;
  setSendToSprinkleHook(hook: ((name: string, data: unknown) => void) | undefined): void;
}

/** Minimal `OffscreenClient` surface this module needs. */
export interface ExtensionLeaderClientLike {
  readonly selectedScoopJid: string | null;
  onScoopSelected(handler: (jid: string) => void): () => void;
}

/** Minimal `Layout`/`ChatPanel` surface this module needs. */
export interface ExtensionLeaderChatLike {
  setOnLocalUserMessage(
    handler:
      | ((text: string, messageId: string, attachments?: MessageAttachment[]) => void)
      | undefined
  ): void;
}

/** Logger surface — same shape the offscreen factory uses. */
export interface ExtensionLeaderLogger {
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export interface ExtensionLeaderHooksOptions {
  sender: PanelMessageSender;
  subscriber: PanelMessageSubscriber;
  sprinkleManager: ExtensionLeaderSprinkleManagerLike;
  client: ExtensionLeaderClientLike;
  chat: ExtensionLeaderChatLike;
  log: ExtensionLeaderLogger;
  /** Optional override for the proxy constructor — tests inject a fake. */
  _proxyFactory?: (
    sender: PanelMessageSender,
    subscriber: PanelMessageSubscriber,
    listeners: { onLeaderModeChange?: (active: boolean) => void }
  ) => PanelLeaderSyncProxy;
}

export interface ExtensionLeaderHooksHandle {
  /** @internal Exposed for inspection and tests only. Do NOT call
   *  `.dispose()` on this — use {@link ExtensionLeaderHooksHandle.dispose}
   *  so the hooks are removed in the right order before the proxy goes
   *  away. Matches the `@internal` convention `ExtensionLeaderTrayHandle`
   *  uses for its `sync` / `peers` / `leader` fields. */
  readonly proxy: PanelLeaderSyncProxy;
  /** Hooks state — true while installed, false otherwise. */
  isInstalled(): boolean;
  /** Permanently tear down. Idempotent. Disposes the proxy. */
  dispose(): void;
}

export function createExtensionLeaderHooks(
  options: ExtensionLeaderHooksOptions
): ExtensionLeaderHooksHandle {
  const { sender, subscriber, sprinkleManager, client, chat, log } = options;

  const proxyFactory =
    options._proxyFactory ?? ((s, sub, listeners) => new PanelLeaderSyncProxy(s, sub, listeners));

  // Forward-declare so named handlers (defined before proxy is
  // constructed) capture it via closure. Mirrors the standalone-leader's
  // `let sync!` pattern.
  let proxy!: PanelLeaderSyncProxy;

  // Named handlers so removeLeaderHooks can actually unsubscribe.
  const handleScoopSelected = (jid: string) => proxy.pushActiveScoop(jid);
  const handleSprinklesChanged = () => {
    const opened = new Set(sprinkleManager.opened());
    proxy.pushSprinklesSnapshot(
      sprinkleManager.available().map((p) => ({
        name: p.name,
        title: p.title,
        path: p.path,
        open: opened.has(p.name),
        autoOpen: p.autoOpen,
      }))
    );
  };
  const handleSprinkleUpdate = (name: string, data: unknown) =>
    proxy.pushSprinkleUpdate(name, data);
  const handleLocalUserMessage = (
    text: string,
    messageId: string,
    attachments?: MessageAttachment[]
  ) => proxy.pushUserMessageEcho(text, messageId, attachments);

  let installed = false;
  let offScoopSelected: (() => void) | null = null;
  let offSprinklesChanged: (() => void) | null = null;
  let disposed = false;

  function installLeaderHooks() {
    if (installed || disposed) return;
    installed = true;

    offScoopSelected = client.onScoopSelected(handleScoopSelected);
    if (client.selectedScoopJid) handleScoopSelected(client.selectedScoopJid);

    offSprinklesChanged = sprinkleManager.onChange(handleSprinklesChanged);
    void sprinkleManager
      .refresh()
      .then(handleSprinklesChanged)
      .catch((err: unknown) => {
        log.error('Initial sprinkle refresh after leader-mode activation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

    sprinkleManager.setSendToSprinkleHook(handleSprinkleUpdate);
    chat.setOnLocalUserMessage(handleLocalUserMessage);

    // NOTE: setTrayResetter is not wired here. The extension panel terminal
    // executes in offscreen via RemoteTerminalView, so `host reset` consults
    // the offscreen-side host-command singletons. Wiring it panel-side
    // would bind a different module instance the terminal shell never sees.
  }

  function removeLeaderHooks() {
    if (!installed) return;
    installed = false;
    offScoopSelected?.();
    offScoopSelected = null;
    offSprinklesChanged?.();
    offSprinklesChanged = null;
    sprinkleManager.setSendToSprinkleHook(undefined);
    chat.setOnLocalUserMessage(undefined);
  }

  proxy = proxyFactory(sender, subscriber, {
    onLeaderModeChange: (active) => {
      if (active) installLeaderHooks();
      else removeLeaderHooks();
    },
  });

  // Ask offscreen to re-emit its current state so popouts opening
  // AFTER offscreen activated still install hooks.
  proxy.requestModeState();

  return {
    proxy,
    isInstalled: () => installed,
    dispose() {
      if (disposed) return;
      disposed = true;
      removeLeaderHooks();
      proxy.dispose();
    },
  };
}
