/**
 * ScoopIdleTimers - per-scoop "no work received yet" notifier.
 *
 * When a non-cone scoop becomes `ready` and stays that way for
 * {@link SCOOP_IDLE_TIMEOUT_MS}, the cone receives an actionable notice so a
 * forgotten delegation surfaces in chat instead of hanging silent. Webhook /
 * cron-driven scoops legitimately stay ready for long stretches — the notice
 * spells that out so the cone can ignore it. Re-arms / clears are driven from
 * the orchestrator's lifecycle hooks (`registerScoop` arms, every status
 * change clears + re-arms, `destroyScoopTab` / `unregisterScoop` / `shutdown`
 * clear).
 *
 * Extracted from `Orchestrator` so the `Map<jid, Timeout>` and the
 * fire-once notification logic live next to the data they own. Cone-state
 * lookups (scoops + tabs maps, message handling, lick callbacks) are
 * injected via {@link ScoopIdleTimersDeps} so this module stays free of
 * orchestrator coupling.
 */

import { createLogger } from '../core/logger.js';
import type { ChannelMessage, RegisteredScoop, ScoopTabState } from './types.js';

const log = createLogger('scoop-idle-timers');

/** Time in ms to wait before notifying cone that a scoop hasn't started work. */
export const SCOOP_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

export interface ScoopIdleTimersDeps {
  /** Live snapshot of registered scoops; the timer reads `isCone`, `assistantLabel`, `folder`, `name`. */
  getScoops(): Map<string, RegisteredScoop>;
  /** Live snapshot of per-scoop tabs; the timer guards on `status === 'ready'` before firing. */
  getTabs(): Map<string, ScoopTabState>;
  /** Route the cone-facing idle notice through the orchestrator's normal queue. */
  handleMessage(msg: ChannelMessage): Promise<void>;
  /** Fire `onIncomingMessage` so the UI renders the notice as a lick in the cone's chat. */
  notifyIncomingMessage(scoopJid: string, msg: ChannelMessage): void;
}

export class ScoopIdleTimers {
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(private deps: ScoopIdleTimersDeps) {}

  /**
   * Start (or restart) the idle timer for a scoop. If the scoop doesn't
   * transition out of `ready` within {@link SCOOP_IDLE_TIMEOUT_MS}, fire a
   * single cone-facing notice. No-op when the scoop is already processing
   * (guards against the auto-feed race in `registerScoop`).
   */
  start(jid: string): void {
    this.clear(jid);
    const currentTab = this.deps.getTabs().get(jid);
    if (currentTab?.status === 'processing') return;
    const timer = setTimeout(() => {
      this.timers.delete(jid);
      this.fire(jid);
    }, SCOOP_IDLE_TIMEOUT_MS);
    this.timers.set(jid, timer);
  }

  /** Clear the idle timer for a scoop. Safe to call when no timer is active. */
  clear(jid: string): void {
    const timer = this.timers.get(jid);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jid);
    }
  }

  /** Clear every pending idle timer. Used by `Orchestrator.shutdown`. */
  clearAll(): void {
    for (const jid of this.timers.keys()) {
      this.clear(jid);
    }
  }

  private fire(jid: string): void {
    const scoops = this.deps.getScoops();
    const scoop = scoops.get(jid);
    if (!scoop || scoop.isCone) return;

    // Only notify if still in ready state (never processed).
    const tab = this.deps.getTabs().get(jid);
    if (tab?.status !== 'ready') return;

    const cone = Array.from(scoops.values()).find((s) => s.isCone);
    if (!cone) return;

    const notifyMsg: ChannelMessage = {
      id: `scoop-idle-${jid}-${Date.now()}`,
      chatJid: cone.jid,
      senderId: scoop.folder,
      senderName: scoop.assistantLabel,
      content: `[@${scoop.assistantLabel} idle]: Scoop "${scoop.name}" has been ready for 2 minutes without receiving any work. This is expected if the scoop is waiting for webhooks or cron tasks. If you intended to delegate work, use feed_scoop to send a prompt.`,
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'scoop-idle',
    };
    log.info('Scoop idle timeout', { jid, scoop: scoop.folder });
    // Fire onIncomingMessage so the UI renders the idle notice as a
    // lick in the cone's chat. handleMessage below still enqueues it
    // for the cone's agent to react to.
    try {
      this.deps.notifyIncomingMessage(cone.jid, notifyMsg);
    } catch (err) {
      log.warn('onIncomingMessage for scoop-idle threw', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.deps.handleMessage(notifyMsg).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to send idle notification', { jid, error: msg });
    });
  }
}
