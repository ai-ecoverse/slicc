/**
 * Panel ↔ offscreen bridge for extension-leader mode.
 *
 * Mirror of follower-sprinkle-bridge.ts but for the leader role:
 * panel pushes sprinkle snapshot / sprinkle updates / user-message
 * echo / active-scoop selection. Offscreen pushes leader-mode-changed
 * and leader-tray-reset-response (the latter wired by
 * `PanelLeaderSyncProxy.resetTray` below).
 */

import type { MessageAttachment } from '../../webapp/src/core/attachments.js';
import type { LeaderSyncManager } from '../../webapp/src/scoops/tray-leader-sync.js';
import {
  discriminateMsg,
  type OffscreenMessageHub,
  type PanelMessageSender,
  type PanelMessageSubscriber,
} from './bridge-transport.js';
import type {
  LeaderActiveScoopMsg,
  LeaderModeChangedMsg,
  LeaderRequestLeaderModeStateMsg,
  LeaderSprinklesSnapshotMsg,
  LeaderSprinkleUpdateMsg,
  LeaderTrayResetRequestMsg,
  LeaderTrayResetResponseMsg,
  LeaderTrayRuntimeStatusEnvelope,
  LeaderUserMessageEchoMsg,
  SprinkleSummaryEnvelope,
  TrayOpenPreviewRequestMsg,
  TrayOpenPreviewResponseMsg,
} from './messages.js';

// Re-export the shared transport interfaces so existing consumers
// (offscreen.ts, leader-sync-bridge.test.ts, etc.) keep importing
// them from this module's stable public surface.
export type { OffscreenMessageHub, PanelMessageSender, PanelMessageSubscriber };

/** Narrow surface the leader adapter needs on OffscreenBridge — kept slim
 *  so tests can pass a hand-built stub. */
export interface ActiveScoopSink {
  setActiveScoopJid(jid: string | null): void;
}

// -----------------------------------------------------------------------------
// Panel-side proxy
// -----------------------------------------------------------------------------

export interface TrayOpenPreviewResult {
  url: string;
  pushed: number;
}

export class PanelLeaderSyncProxy {
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly pendingResets = new Map<
    string,
    {
      resolve: (status: LeaderTrayRuntimeStatusEnvelope) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextResetId = 1;
  private readonly pendingPreviews = new Map<
    string,
    {
      resolve: (result: TrayOpenPreviewResult) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextPreviewId = 1;

  constructor(
    private readonly sender: PanelMessageSender,
    subscriber: PanelMessageSubscriber,
    private readonly listeners: {
      onLeaderModeChange?: (active: boolean) => void;
    }
  ) {
    this.unsubscribe = subscriber.onMessage((envelope) => {
      if (envelope.source !== 'offscreen') return;
      const mode = discriminateMsg<LeaderModeChangedMsg>(envelope.payload, 'leader-mode-changed');
      if (mode) {
        this.listeners.onLeaderModeChange?.(mode.active);
        return;
      }
      const resp = discriminateMsg<LeaderTrayResetResponseMsg>(
        envelope.payload,
        'leader-tray-reset-response'
      );
      if (resp) {
        const pending = this.pendingResets.get(resp.requestId);
        if (!pending) return;
        this.pendingResets.delete(resp.requestId);
        clearTimeout(pending.timer);
        if (resp.ok) pending.resolve(resp.status);
        // `discriminateMsg` is a type assertion, not a runtime guard — a
        // malformed wire payload with `ok: false` and a missing `error`
        // would bypass the discriminated-union requirement and produce
        // `Error: undefined`. Defence-in-depth fallback below.
        else pending.reject(new Error(resp.error ?? 'leader-tray-reset failed (no error message)'));
        return;
      }
      const previewResp = discriminateMsg<TrayOpenPreviewResponseMsg>(
        envelope.payload,
        'tray-open-preview-response'
      );
      if (previewResp) {
        const pending = this.pendingPreviews.get(previewResp.requestId);
        if (!pending) return;
        this.pendingPreviews.delete(previewResp.requestId);
        clearTimeout(pending.timer);
        if (previewResp.ok) {
          pending.resolve({ url: previewResp.url, pushed: previewResp.pushed });
        } else {
          pending.reject(
            new Error(previewResp.error ?? 'tray-open-preview failed (no error message)')
          );
        }
        return;
      }
    });
  }

  pushSprinklesSnapshot(sprinkles: SprinkleSummaryEnvelope[]): void {
    if (this.disposed) return;
    const payload: LeaderSprinklesSnapshotMsg = {
      type: 'leader-sprinkles-snapshot',
      sprinkles,
    };
    this.sender.send({ source: 'panel', payload });
  }

  pushSprinkleUpdate(sprinkleName: string, data: unknown): void {
    if (this.disposed) return;
    const payload: LeaderSprinkleUpdateMsg = {
      type: 'leader-sprinkle-update',
      sprinkleName,
      data,
    };
    this.sender.send({ source: 'panel', payload });
  }

  pushUserMessageEcho(text: string, messageId: string, attachments?: MessageAttachment[]): void {
    if (this.disposed) return;
    const payload: LeaderUserMessageEchoMsg = {
      type: 'leader-user-message-echo',
      text,
      messageId,
      attachments,
    };
    this.sender.send({ source: 'panel', payload });
  }

  pushActiveScoop(jid: string): void {
    if (this.disposed) return;
    const payload: LeaderActiveScoopMsg = { type: 'leader-active-scoop', scoopJid: jid };
    this.sender.send({ source: 'panel', payload });
  }

  requestModeState(): void {
    if (this.disposed) return;
    const payload: LeaderRequestLeaderModeStateMsg = { type: 'leader-request-mode-state' };
    this.sender.send({ source: 'panel', payload });
  }

  resetTray(timeoutMs = 30_000): Promise<LeaderTrayRuntimeStatusEnvelope> {
    if (this.disposed) return Promise.reject(new Error('PanelLeaderSyncProxy disposed'));
    const requestId = `tray-reset-${Date.now()}-${this.nextResetId++}`;
    return new Promise<LeaderTrayRuntimeStatusEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResets.delete(requestId);
        reject(new Error(`leader-tray-reset timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingResets.set(requestId, { resolve, reject, timer });
      const payload: LeaderTrayResetRequestMsg = { type: 'leader-tray-reset', requestId };
      this.sender.send({ source: 'panel', payload });
    });
  }

  /**
   * Round-trip a `tray-open-preview` to the offscreen leader. Used by the
   * extension side-panel `serve` command — the panel terminal has no
   * panel-RPC channel and no in-realm minter, so it bridges through the
   * leader-sync envelope. Standalone uses panel-RPC; offscreen agent
   * uses the in-realm `setPreviewMinter` hook.
   */
  openPreview(
    opts: { entryPath: string; servedRoot: string; bridge: boolean; noBridge: boolean },
    timeoutMs = 30_000
  ): Promise<TrayOpenPreviewResult> {
    if (this.disposed) return Promise.reject(new Error('PanelLeaderSyncProxy disposed'));
    const requestId = `tray-open-preview-${Date.now()}-${this.nextPreviewId++}`;
    return new Promise<TrayOpenPreviewResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPreviews.delete(requestId);
        reject(new Error(`tray-open-preview timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingPreviews.set(requestId, { resolve, reject, timer });
      const payload: TrayOpenPreviewRequestMsg = {
        type: 'tray-open-preview',
        requestId,
        entryPath: opts.entryPath,
        servedRoot: opts.servedRoot,
        bridge: opts.bridge,
        noBridge: opts.noBridge,
      };
      this.sender.send({ source: 'panel', payload });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const entry of this.pendingResets.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('PanelLeaderSyncProxy disposed'));
    }
    this.pendingResets.clear();
    for (const entry of this.pendingPreviews.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('PanelLeaderSyncProxy disposed'));
    }
    this.pendingPreviews.clear();
  }
}

// -----------------------------------------------------------------------------
// Offscreen-side adapter
// -----------------------------------------------------------------------------

export interface OffscreenLeaderSyncBridgeHandle {
  getSprinkles(): SprinkleSummaryEnvelope[];
  resolveSprinklePath(name: string): string | null;
  signalLeaderMode(active: boolean): void;
  detach(): void;
}

export function connectOffscreenLeaderSyncBridge(
  hub: OffscreenMessageHub,
  syncRef: () => LeaderSyncManager | null,
  bridge: ActiveScoopSink
): OffscreenLeaderSyncBridgeHandle {
  let detached = false;
  let leaderModeActive = false;
  let cachedSprinkles: SprinkleSummaryEnvelope[] = [];

  const off = hub.onPanelMessage((envelope) => {
    if (detached || envelope.source !== 'panel') return;

    const snapshot = discriminateMsg<LeaderSprinklesSnapshotMsg>(
      envelope.payload,
      'leader-sprinkles-snapshot'
    );
    if (snapshot) {
      cachedSprinkles = snapshot.sprinkles.slice();
      return;
    }

    const update = discriminateMsg<LeaderSprinkleUpdateMsg>(
      envelope.payload,
      'leader-sprinkle-update'
    );
    if (update) {
      syncRef()?.broadcastSprinkleUpdate(update.sprinkleName, update.data);
      return;
    }

    const echo = discriminateMsg<LeaderUserMessageEchoMsg>(
      envelope.payload,
      'leader-user-message-echo'
    );
    if (echo) {
      syncRef()?.broadcastUserMessage(echo.text, echo.messageId, echo.attachments);
      return;
    }

    const active = discriminateMsg<LeaderActiveScoopMsg>(envelope.payload, 'leader-active-scoop');
    if (active) {
      bridge.setActiveScoopJid(active.scoopJid);
      return;
    }

    const req = discriminateMsg<LeaderRequestLeaderModeStateMsg>(
      envelope.payload,
      'leader-request-mode-state'
    );
    if (req) {
      const payload: LeaderModeChangedMsg = {
        type: 'leader-mode-changed',
        active: leaderModeActive,
      };
      hub.sendToPanel({ source: 'offscreen', payload });
    }
  });

  return {
    getSprinkles() {
      return cachedSprinkles;
    },
    resolveSprinklePath(name) {
      const found = cachedSprinkles.find((s) => s.name === name);
      return found ? found.path : null;
    },
    signalLeaderMode(active) {
      if (detached) return;
      leaderModeActive = active;
      const payload: LeaderModeChangedMsg = { type: 'leader-mode-changed', active };
      hub.sendToPanel({ source: 'offscreen', payload });
    },
    detach() {
      if (detached) return;
      detached = true;
      off();
    },
  };
}
