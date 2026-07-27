import type { AgentEvent } from '../../core/agent-types.js';
import type { MessageAttachment } from '../../core/attachments.js';
import { stripLocalPathsForRemote } from '../../core/attachments.js';
import type { ChatMessage } from '../chat-types.js';
import type {
  LeaderToFollowerMessage,
  ScoopSummary,
  SprinkleSummary,
} from '../tray-sync-protocol.js';
import { sendSnapshot } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

export const SPRINKLE_CHUNK_SIZE = 32 * 1024;
export const SPRINKLE_CHUNK_THRESHOLD = 64 * 1024;

export class BroadcastManager {
  constructor(private readonly context: LeaderSyncContext) {}

  broadcastEvent(event: AgentEvent): void {
    if (this.context.followers.followers.size === 0) return;
    const scoopJid = this.context.options.getScoopJid();
    this.broadcast({ type: 'agent_event', event, scoopJid });
  }

  broadcastUserMessage(text: string, messageId: string, attachments?: MessageAttachment[]): void {
    if (this.context.followers.followers.size === 0) return;
    const safeAttachments = attachments?.length
      ? stripLocalPathsForRemote(attachments)
      : attachments;
    this.broadcast({
      type: 'user_message_echo',
      text,
      messageId,
      scoopJid: this.context.options.getScoopJid(),
      attachments: safeAttachments,
    });
  }

  broadcastStatus(status: string): void {
    if (this.context.followers.followers.size === 0) return;
    this.broadcast({ type: 'status', scoopStatus: status });
  }

  async sendSnapshotToFollower(bootstrapId: string, scoopJid?: string): Promise<void> {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;

    const { options } = this.context;
    const targetJid = scoopJid ?? follower.selectedScoopJid ?? options.getScoopJid();
    let messages: ChatMessage[];
    if (options.getMessagesForScoop && targetJid !== options.getScoopJid()) {
      try {
        messages = await Promise.resolve(options.getMessagesForScoop(targetJid));
      } catch (err) {
        this.context.log.warn('getMessagesForScoop failed, falling back to active scoop', {
          targetJid,
          error: err instanceof Error ? err.message : String(err),
        });
        messages = options.getMessages();
      }
    } else {
      messages = options.getMessages();
    }

    follower.selectedScoopJid = targetJid;
    sendSnapshot(follower.sync, messages, targetJid);
    this.context.log.debug('Snapshot sent to follower', {
      bootstrapId,
      messageCount: messages.length,
      scoopJid: targetJid,
    });
  }

  broadcastSnapshot(): void {
    if (this.context.followers.followers.size === 0) return;
    for (const bootstrapId of this.context.followers.followers.keys()) {
      void this.sendSnapshotToFollower(bootstrapId);
    }
  }

  sendScoopsListToFollower(bootstrapId: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;
    const getScoops = this.context.options.getScoops;
    if (!getScoops) return;
    try {
      follower.sync.send({
        type: 'scoops.list',
        scoops: getScoops(),
        activeScoopJid: this.context.options.getScoopJid(),
      });
    } catch (err) {
      this.context.log.warn('Failed to send scoops.list', {
        bootstrapId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  sendSprinklesListToFollower(bootstrapId: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;
    const getSprinkles = this.context.options.getSprinkles;
    if (!getSprinkles) return;
    try {
      follower.sync.send({ type: 'sprinkles.list', sprinkles: getSprinkles() });
    } catch (err) {
      this.context.log.warn('Failed to send sprinkles.list', {
        bootstrapId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  broadcastScoopsList(): void {
    if (this.context.followers.followers.size === 0) return;
    const getScoops = this.context.options.getScoops;
    if (!getScoops) return;
    let scoops: ScoopSummary[];
    try {
      scoops = getScoops();
    } catch (err) {
      this.context.log.warn('Failed to compute scoops list', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.broadcast({
      type: 'scoops.list',
      scoops,
      activeScoopJid: this.context.options.getScoopJid(),
    });
  }

  broadcastSprinklesList(): void {
    if (this.context.followers.followers.size === 0) return;
    const getSprinkles = this.context.options.getSprinkles;
    if (!getSprinkles) return;
    let sprinkles: SprinkleSummary[];
    try {
      sprinkles = getSprinkles();
    } catch (err) {
      this.context.log.warn('Failed to compute sprinkles list', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.broadcast({ type: 'sprinkles.list', sprinkles });
  }

  broadcastSprinkleUpdate(sprinkleName: string, data: unknown): void {
    if (this.context.followers.followers.size === 0) return;
    this.broadcast({ type: 'sprinkle.update', sprinkleName, data });
  }

  broadcastTheme(themeJson: string | null): void {
    if (this.context.followers.followers.size === 0) return;
    this.broadcast({ type: 'theme.apply', themeJson });
  }

  broadcastSprinkleReloaded(sprinkleName: string): void {
    if (this.context.followers.followers.size === 0) return;
    this.broadcast({ type: 'sprinkle.reloaded', sprinkleName });
  }

  broadcastPreviewOpen(url: string): void {
    if (this.context.followers.followers.size === 0) return;
    this.broadcast({ type: 'preview.open', requestId: `prv-${crypto.randomUUID()}`, url });
  }

  async handleSprinkleFetch(
    bootstrapId: string,
    requestId: string,
    sprinkleName: string
  ): Promise<void> {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;

    const reader = this.context.options.readSprinkleContent;
    if (!reader) {
      follower.sync.send({
        type: 'sprinkle.content',
        requestId,
        sprinkleName,
        content: '',
        error: 'Leader has no sprinkle content reader',
      });
      return;
    }

    let content: string | null = null;
    try {
      content = await Promise.resolve(reader(sprinkleName));
    } catch (err) {
      follower.sync.send({
        type: 'sprinkle.content',
        requestId,
        sprinkleName,
        content: '',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (content === null || content === undefined) {
      follower.sync.send({
        type: 'sprinkle.content',
        requestId,
        sprinkleName,
        content: '',
        error: `Sprinkle not found: ${sprinkleName}`,
      });
      return;
    }

    if (content.length <= SPRINKLE_CHUNK_THRESHOLD) {
      follower.sync.send({ type: 'sprinkle.content', requestId, sprinkleName, content });
      return;
    }

    const totalChunks = Math.ceil(content.length / SPRINKLE_CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      follower.sync.send({
        type: 'sprinkle.content',
        requestId,
        sprinkleName,
        content: content.slice(i * SPRINKLE_CHUNK_SIZE, (i + 1) * SPRINKLE_CHUNK_SIZE),
        chunkIndex: i,
        totalChunks,
      });
    }
  }

  private broadcast(message: LeaderToFollowerMessage): void {
    this.context.followers.broadcastToAllFollowers(message);
  }
}
