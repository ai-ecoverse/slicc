/**
 * Panel ↔ offscreen bridge for extension-leader mode.
 *
 * Mirror of follower-sprinkle-bridge.ts but for the leader role:
 * panel pushes sprinkle snapshot / sprinkle updates / user-message
 * echo / active-scoop selection. Offscreen pushes leader-mode-changed
 * and leader-tray-reset-response (the latter wired in Task 10).
 */

import type {
  LeaderSprinklesSnapshotMsg,
  LeaderSprinkleUpdateMsg,
  LeaderUserMessageEchoMsg,
  LeaderActiveScoopMsg,
  LeaderRequestLeaderModeStateMsg,
  LeaderModeChangedMsg,
  LeaderTrayResetRequestMsg,
  LeaderTrayResetResponseMsg,
  LeaderTrayRuntimeStatusEnvelope,
  SprinkleSummaryEnvelope,
} from './messages.js';
import type { LeaderSyncManager } from '../../webapp/src/scoops/tray-leader-sync.js';
import type { MessageAttachment } from '../../webapp/src/core/attachments.js';

export interface PanelMessageSender {
  send(envelope: { source: 'panel'; payload: unknown }): void;
}

export interface PanelMessageSubscriber {
  onMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void;
}

export interface OffscreenMessageHub {
  sendToPanel(envelope: { source: 'offscreen'; payload: unknown }): void;
  onPanelMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void;
}

/** Narrow surface the leader adapter needs on OffscreenBridge — kept slim
 *  so tests can pass a hand-built stub. */
export interface ActiveScoopSink {
  setActiveScoopJid(jid: string | null): void;
}

function discriminateMsg<T extends { type: string }>(payload: unknown, type: T['type']): T | null {
  if (!payload || typeof payload !== 'object') return null;
  if ((payload as { type?: unknown }).type !== type) return null;
  return payload as T;
}

// -----------------------------------------------------------------------------
// Panel-side proxy
// -----------------------------------------------------------------------------

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
        else pending.reject(new Error(resp.error));
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const entry of this.pendingResets.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('PanelLeaderSyncProxy disposed'));
    }
    this.pendingResets.clear();
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
