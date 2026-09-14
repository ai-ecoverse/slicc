import { type CherryHostEventMessage, isCherryHostEventMessage } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

export class CherryRouter {
  constructor(private readonly context: LeaderSyncContext) {}

  routeCherryHostEvent(bootstrapId: string, message: CherryHostEventMessage): void {
    if (!isCherryHostEventMessage(message)) return;
    const onCherryHostEvent = this.context.options.onCherryHostEvent;
    if (!onCherryHostEvent) {
      this.context.log.debug('cherry.host_event received but no onCherryHostEvent wired', {
        bootstrapId,
        name: message.name,
      });
      return;
    }
    const cherryRuntimeId = this.context.followers.runtimeIdForBootstrap(bootstrapId);
    try {
      onCherryHostEvent(cherryRuntimeId, message.name, message.detail);
    } catch (err) {
      this.context.log.warn('Failed to route cherry.host_event to cone', {
        bootstrapId,
        name: message.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  emitCherrySliccEvent(targetId: string, name: string, detail?: unknown): boolean {
    const sep = targetId.indexOf(':');
    const targetRuntimeId = sep >= 0 ? targetId.slice(0, sep) : targetId;
    const targetBootstrapId = this.context.followers.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId
      ? this.context.followers.followers.get(targetBootstrapId)
      : undefined;
    if (!targetFollower) {
      this.context.log.warn('emitCherrySliccEvent: owning follower not connected', {
        targetId,
        name,
      });
      return false;
    }
    return targetFollower.sync.send({ type: 'cherry.slicc_event', targetId, name, detail });
  }
}
