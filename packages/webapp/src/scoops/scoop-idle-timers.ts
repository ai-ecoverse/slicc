import { createLogger } from '../base/logger.js';
import type { ChannelMessage, RegisteredScoop, ScoopTabState } from './types.js';

const log = createLogger('scoop-idle-timers');

export const SCOOP_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

export interface ScoopIdleTimersDeps {
  getScoops(): Map<string, RegisteredScoop>;

  findParent(jid: string): RegisteredScoop | undefined;

  getTabs(): Map<string, ScoopTabState>;

  handleMessage(msg: ChannelMessage): Promise<void>;

  notifyIncomingMessage(scoopJid: string, msg: ChannelMessage): void;
}

export class ScoopIdleTimers {
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(private deps: ScoopIdleTimersDeps) {}

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

  clear(jid: string): void {
    const timer = this.timers.get(jid);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jid);
    }
  }

  clearAll(): void {
    for (const jid of this.timers.keys()) {
      this.clear(jid);
    }
  }

  private fire(jid: string): void {
    const scoops = this.deps.getScoops();
    const scoop = scoops.get(jid);
    if (!scoop || scoop.parentJid === null) return;

    const tab = this.deps.getTabs().get(jid);
    if (tab?.status !== 'ready') return;

    const cone = this.deps.findParent(jid);
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
