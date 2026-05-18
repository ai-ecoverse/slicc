/**
 * Panel ↔ offscreen bridge for follower-mode sprinkle sync.
 *
 * The real `FollowerSyncManager` lives in the offscreen document (because the
 * agent / signaling / WebRTC live there, surviving side-panel close). But the
 * sprinkle renderer needs DOM, so the panel does the actual rendering via the
 * shared `SprinkleFollowerController`. This bridge connects the two halves
 * over `chrome.runtime` messages:
 *
 *   - **Offscreen → panel**: `follower-sprinkles-list`, `follower-sprinkle-update`,
 *     `follower-sprinkle-fetch-result` — the controller reconciles open state and
 *     resolves outstanding fetches.
 *   - **Panel → offscreen**: `follower-sprinkle-fetch`, `follower-sprinkle-lick`
 *     — the offscreen invokes its `FollowerSyncManager` and dispatches over the
 *     WebRTC data channel.
 *
 * The two helpers in this file form symmetrical halves of the wire:
 *
 *   - `PanelFollowerSprinkleProxy` (panel-side `SprinkleFollowerSync`)
 *   - `connectOffscreenFollowerSprinkleBridge` (offscreen-side adapter)
 *
 * Both are intentionally side-effect-free at the module level so they can be
 * exercised under jsdom without a real Chrome runtime.
 */

import type {
  FollowerSprinkleFetchRequestMsg,
  FollowerSprinkleFetchResultMsg,
  FollowerSprinkleLickMsg,
  FollowerSprinklesListMsg,
  FollowerSprinkleUpdateMsg,
} from './messages.js';
import type { SprinkleFollowerSync } from '../../../packages/webapp/src/ui/sprinkle-follower-controller.js';
import type { SprinkleSummary } from '../../../packages/webapp/src/scoops/tray-sync-protocol.js';

// Compile-time invariant: the `sprinkles` array shape inside
// `FollowerSprinklesListMsg` must remain assignable to the canonical
// `SprinkleSummary[]`. `messages.ts` mirrors the type inline (rather than
// importing it) to avoid dragging tray-sync-protocol's value imports into the
// webapp-worker tsconfig surface. This assertion fails the build if either
// shape drifts.
type _AssertSprinkleSummaryEnvelopeMatches =
  FollowerSprinklesListMsg['sprinkles'] extends SprinkleSummary[]
    ? SprinkleSummary[] extends FollowerSprinklesListMsg['sprinkles']
      ? true
      : never
    : never;
 
const _sprinkleSummaryEnvelopeMatches: _AssertSprinkleSummaryEnvelopeMatches = true;

/**
 * Generic chrome.runtime sender — kept narrow so tests can substitute a
 * synchronous in-memory pipe.
 */
export interface PanelMessageSender {
  send(envelope: { source: 'panel'; payload: unknown }): void;
}

/**
 * Subscription helper — returns an unsubscribe handle. The panel transport
 * already exposes `onMessage`; tests provide a fake.
 */
export interface PanelMessageSubscriber {
  onMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void;
}

/**
 * Default timeout for the panel-side `fetchSprinkleContent`. When the offscreen
 * document is not awake (typical when the user has never configured a join URL)
 * `chrome.runtime.sendMessage` silently succeeds but no follower exists to
 * answer — without a timeout, the promise hangs forever and the controller's
 * `opening` set keeps the sprinkle name pinned, blocking every future open of
 * the same name for the panel's lifetime.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Narrow an `unknown` runtime payload to a specific message variant by checking
 * its discriminator. Returns `null` for any payload that doesn't match — never
 * throws. Replaces the prior pattern of `payload as { type?: string }` followed
 * by an unchecked `payload as TSpecific`, which the compiler couldn't validate.
 */
function narrowMsg<T extends { type: string }>(payload: unknown, type: T['type']): T | null {
  if (!payload || typeof payload !== 'object') return null;
  if ((payload as { type?: unknown }).type !== type) return null;
  return payload as T;
}

/**
 * Panel-side proxy that implements `SprinkleFollowerSync` by routing every
 * request through the panel↔offscreen runtime channel.
 *
 * The controller calls `fetchSprinkleContent` and `sendSprinkleLick`; the
 * proxy serializes the request, waits for a matching `follower-sprinkle-fetch-result`
 * envelope, and resolves / rejects the pending promise. Lick messages are
 * fire-and-forget — the leader's lick router owns the result.
 *
 * Pending fetches are bounded by `fetchTimeoutMs` (default 15s). Without this
 * the proxy would hang forever when the offscreen document is not awake
 * (typical when the user never configured a follower) — and the controller
 * cannot proceed because its `opening` set is keyed by sprinkle name.
 */
export class PanelFollowerSprinkleProxy implements SprinkleFollowerSync {
  private readonly pending = new Map<
    string,
    {
      resolve: (content: string) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly unsubscribe: () => void;
  private readonly fetchTimeoutMs: number;
  private nextId = 1;
  private disposed = false;

  constructor(
    private readonly sender: PanelMessageSender,
    subscriber: PanelMessageSubscriber,
    private readonly listeners: {
      onSprinklesList?: (sprinkles: SprinkleSummary[]) => void;
      onSprinkleUpdate?: (sprinkleName: string, data: unknown) => void;
    } = {},
    options: { fetchTimeoutMs?: number } = {}
  ) {
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.unsubscribe = subscriber.onMessage((envelope) => {
      if (envelope.source !== 'offscreen') return;
      const list = narrowMsg<FollowerSprinklesListMsg>(envelope.payload, 'follower-sprinkles-list');
      if (list) {
        this.listeners.onSprinklesList?.(list.sprinkles);
        return;
      }
      const update = narrowMsg<FollowerSprinkleUpdateMsg>(
        envelope.payload,
        'follower-sprinkle-update'
      );
      if (update) {
        this.listeners.onSprinkleUpdate?.(update.sprinkleName, update.data);
        return;
      }
      const result = narrowMsg<FollowerSprinkleFetchResultMsg>(
        envelope.payload,
        'follower-sprinkle-fetch-result'
      );
      if (result) {
        const entry = this.pending.get(result.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(result.id);
        if (result.ok) entry.resolve(result.content);
        else entry.reject(new Error(result.error));
      }
    });
  }

  fetchSprinkleContent(sprinkleName: string): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new Error('PanelFollowerSprinkleProxy disposed'));
    }
    const id = `panel-${Date.now()}-${this.nextId++}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `follower-sprinkle-fetch for "${sprinkleName}" timed out after ${this.fetchTimeoutMs}ms — offscreen document may not be in follower mode`
          )
        );
      }, this.fetchTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload: FollowerSprinkleFetchRequestMsg = {
        type: 'follower-sprinkle-fetch',
        id,
        sprinkleName,
      };
      this.sender.send({ source: 'panel', payload });
    });
  }

  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void {
    if (this.disposed) return;
    const payload: FollowerSprinkleLickMsg = {
      type: 'follower-sprinkle-lick',
      sprinkleName,
      body,
      targetScoop,
    };
    this.sender.send({ source: 'panel', payload });
  }

  /** Reject every outstanding fetch and stop listening. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    const err = new Error('PanelFollowerSprinkleProxy disposed');
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Offscreen-side adapter: subscribes to `chrome.runtime.onMessage` for
 * panel→offscreen sprinkle follower ops and routes them through the supplied
 * `FollowerSyncManager`-like surface. Also pushes `sprinkles.list` /
 * `sprinkle.update` payloads from the leader back to the panel as runtime
 * messages.
 *
 * Returned `detach()` cancels both directions — call it when the active
 * follower sync changes (e.g. the data channel closed and a new one is
 * starting) so a stale leader's payloads don't leak into the panel.
 *
 * The sync interface is structurally identical to `SprinkleFollowerSync` from
 * the webapp — kept as the same type to avoid drift across modules.
 */
export interface OffscreenMessageHub {
  /** Send an envelope to the side panel (and any other panel-like consumers). */
  sendToPanel(envelope: { source: 'offscreen'; payload: unknown }): void;
  /** Subscribe to incoming panel envelopes. */
  onPanelMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void;
}

export interface OffscreenFollowerSprinkleBridgeHandle {
  /** Push a `sprinkles.list` from the active leader connection to the panel. */
  forwardSprinklesList(sprinkles: SprinkleSummary[]): void;
  /** Push a `sprinkle.update` from the active leader connection to the panel. */
  forwardSprinkleUpdate(sprinkleName: string, data: unknown): void;
  /** Tear down the listener registered against the message hub. */
  detach(): void;
}

export function connectOffscreenFollowerSprinkleBridge(
  hub: OffscreenMessageHub,
  sync: SprinkleFollowerSync
): OffscreenFollowerSprinkleBridgeHandle {
  let detached = false;
  const off = hub.onPanelMessage((envelope) => {
    if (detached || envelope.source !== 'panel') return;

    const fetchReq = narrowMsg<FollowerSprinkleFetchRequestMsg>(
      envelope.payload,
      'follower-sprinkle-fetch'
    );
    if (fetchReq) {
      sync
        .fetchSprinkleContent(fetchReq.sprinkleName)
        .then((content) => {
          // Skip the reply if the bridge was detached while the fetch was in
          // flight — a reconnect builds a new bridge against a new sync, and
          // a late response from the old sync would otherwise leak to the
          // panel and could collide with a request id from the new bridge.
          if (detached) return;
          const reply: FollowerSprinkleFetchResultMsg = {
            type: 'follower-sprinkle-fetch-result',
            id: fetchReq.id,
            ok: true,
            content,
          };
          hub.sendToPanel({ source: 'offscreen', payload: reply });
        })
        .catch((err: unknown) => {
          if (detached) return;
          const reply: FollowerSprinkleFetchResultMsg = {
            type: 'follower-sprinkle-fetch-result',
            id: fetchReq.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
          hub.sendToPanel({ source: 'offscreen', payload: reply });
        });
      return;
    }

    const lick = narrowMsg<FollowerSprinkleLickMsg>(envelope.payload, 'follower-sprinkle-lick');
    if (lick) {
      sync.sendSprinkleLick(lick.sprinkleName, lick.body, lick.targetScoop);
    }
  });

  return {
    forwardSprinklesList(sprinkles) {
      if (detached) return;
      const payload: FollowerSprinklesListMsg = {
        type: 'follower-sprinkles-list',
        sprinkles,
      };
      hub.sendToPanel({ source: 'offscreen', payload });
    },
    forwardSprinkleUpdate(sprinkleName, data) {
      if (detached) return;
      const payload: FollowerSprinkleUpdateMsg = {
        type: 'follower-sprinkle-update',
        sprinkleName,
        data,
      };
      hub.sendToPanel({ source: 'offscreen', payload });
    },
    detach() {
      detached = true;
      off();
    },
  };
}
