import type { AgentEvent } from '../../core/agent-types.js';
import type { MessageAttachment } from '../../core/attachments.js';
import { stripLocalPathsForRemote } from '../../core/attachments.js';
import type {
  SprinkleBroadcastResult,
  SprinkleSendTarget,
} from '../../shell/sprinkle-manager-handle.js';
import type { ChatMessage } from '../chat-types.js';
import type {
  LeaderToFollowerMessage,
  ScoopSummary,
  SprinkleSummary,
  TrayModelCatalogEntry,
} from '../tray-sync-protocol.js';
import { sendSnapshot } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';
import type { ConnectedFollower } from './follower-registry.js';

export const SPRINKLE_CHUNK_SIZE = 32 * 1024;
export const SPRINKLE_CHUNK_THRESHOLD = 64 * 1024;

/** Stand-in text for a payload the tray could not carry to a follower. */
const OVERSIZE_MARKER = '[content too large to sync — view on leader]';

/**
 * Rebuild an agent event with its unbounded field replaced by a marker, for
 * followers whose channel refused the real thing.
 *
 * Only the variants that can realistically exceed the transport limit are
 * degraded. The rest (`message_start`, `content_done`, `tool_ui_done`,
 * `turn_end`, `error`) carry no unbounded field, so a refusal there is a
 * genuine channel fault rather than a size problem and there is nothing useful
 * to substitute — hence `null`, meaning "don't retry".
 *
 * `screenshot` degrades to an `error` event rather than a stubbed `base64`:
 * a marker string in an image field renders as a broken image, which reads as
 * a bug rather than as a deliberate omission.
 */
export function degradeOversizeAgentEvent(event: AgentEvent): AgentEvent | null {
  switch (event.type) {
    case 'tool_result':
      return { ...event, result: OVERSIZE_MARKER };
    case 'tool_use_start':
      return { ...event, toolInput: { note: OVERSIZE_MARKER } };
    case 'tool_ui':
      return { ...event, html: `<p>${OVERSIZE_MARKER}</p>` };
    case 'content_delta':
      return { ...event, text: OVERSIZE_MARKER };
    case 'terminal_output':
      return { ...event, text: OVERSIZE_MARKER };
    case 'screenshot':
      return { type: 'error', error: `Screenshot ${OVERSIZE_MARKER}` };
    default:
      return null;
  }
}

export class BroadcastManager {
  constructor(private readonly context: LeaderSyncContext) {}

  /**
   * Broadcast an agent event to all connected followers.
   *
   * Without `backgroundScoopJid` the event belongs to the unit this leader is
   * displaying. With it, to a unit a follower may be reading while the leader
   * looks elsewhere — which used to receive nothing at all, so that follower's
   * transcript froze and a prompt it sent never showed a reply.
   *
   * Events are chunked transparently by `TraySyncChannel`, so the ordinary
   * oversize case — an `open --view --size high` screenshot inlined into shell
   * stdout, or a large untruncated `tool_result` — now arrives intact. A send
   * can still be refused past the hard cap or under channel congestion; those
   * followers get a marker event instead, so the transcript shows a gap rather
   * than hiding one (#1700).
   */
  broadcastEvent(event: AgentEvent, backgroundScoopJid?: string): void {
    if (this.context.followers.followers.size === 0) return;
    // `backgroundScoopJid` names a unit this leader is NOT displaying. Either
    // way the event goes to the followers READING its unit, not to everyone —
    // see `broadcastUnitTraffic` for who reads what.
    const displayed = this.context.options.getScoopJid();
    const scoopJid = backgroundScoopJid ?? displayed;
    const failed = this.context.followers.broadcastUnitTraffic(scoopJid, displayed, {
      type: 'agent_event',
      event,
      scoopJid,
    });
    if (failed.length === 0) return;
    const degraded = degradeOversizeAgentEvent(event);
    if (!degraded) return;
    for (const bootstrapId of failed) {
      this.context.followers.followers
        .get(bootstrapId)
        ?.sync.send({ type: 'agent_event', event: degraded, scoopJid });
    }
  }

  /**
   * Echo one user message to every follower. `scoopJid` names the unit the
   * message was DELIVERED to; omitted, the leader's currently displayed unit —
   * right for a prompt typed on the leader, wrong for a follower's prompt,
   * which goes to the unit that follower selected. Tagged with the displayed
   * unit, a prompt for cone B showed up in every other follower's cone A.
   */
  broadcastUserMessage(
    text: string,
    messageId: string,
    attachments?: MessageAttachment[],
    scoopJid?: string
  ): void {
    if (this.context.followers.followers.size === 0) return;
    const safeAttachments = attachments?.length
      ? stripLocalPathsForRemote(attachments)
      : attachments;
    this.broadcast({
      type: 'user_message_echo',
      text,
      messageId,
      scoopJid: scoopJid ?? this.context.options.getScoopJid(),
      attachments: safeAttachments,
    });
  }

  /**
   * Mirror one unit's turn lifecycle. `scoopJid` names the unit that changed;
   * omitted, the leader's currently displayed unit — the historical default,
   * which hid a follower-selected cone's turn when the leader was elsewhere.
   */
  broadcastStatus(status: string, scoopJid?: string): void {
    if (this.context.followers.followers.size === 0) return;
    this.broadcast({
      type: 'status',
      scoopStatus: status,
      scoopJid: scoopJid ?? this.context.options.getScoopJid(),
    });
  }

  /**
   * @param peek answer with `scoopJid`'s transcript WITHOUT recording it as
   *   this peer's selection — a follower warming its cache of other units must
   *   not have its prompts and `abort` re-routed to the unit it merely read.
   */
  async sendSnapshotToFollower(
    bootstrapId: string,
    scoopJid?: string,
    peek = false
  ): Promise<void> {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;

    if (follower.trust === 'biscotto') {
      await this.sendSeatSnapshot(bootstrapId, follower);
      return;
    }
    const { options } = this.context;
    const activeJid = options.getScoopJid();
    let targetJid = scoopJid ?? follower.selectedScoopJid ?? activeJid;
    try {
      const scoops = options.getScoops?.();
      if (scoops && !scoops.some((scoop) => scoop.jid === targetJid)) targetJid = activeJid;
    } catch (err) {
      this.context.log.warn('getScoops failed while validating snapshot target', {
        targetJid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    let messages: ChatMessage[];
    if (options.getMessagesForScoop && targetJid !== activeJid) {
      try {
        messages = await Promise.resolve(options.getMessagesForScoop(targetJid));
      } catch (err) {
        this.context.log.warn('getMessagesForScoop failed, falling back to active scoop', {
          targetJid,
          error: err instanceof Error ? err.message : String(err),
        });
        targetJid = activeJid;
        messages = options.getMessages();
      }
    } else {
      messages = options.getMessages();
    }

    if (!peek) follower.selectedScoopJid = targetJid;
    sendSnapshot(follower.sync, messages, targetJid);
    this.context.log.debug('Snapshot sent to follower', {
      bootstrapId,
      messageCount: messages.length,
      scoopJid: targetJid,
    });
  }

  /**
   * A guest's snapshot: the unit its seat was minted for, and nothing else.
   *
   * Both the JID a guest requests and the unit the owner is displaying are
   * ignored. `request_snapshot` carries its own `scoopJid` (honouring it would
   * let a guest read any transcript), and pinning to the DISPLAYED unit handed
   * a seat minted on one cone whatever cone the owner switched to — on every
   * reconnect and every new-session broadcast. Every failure sends an empty
   * transcript tagged with the seat's unit rather than falling back to the
   * displayed one; a seat with no recorded unit is sent nothing.
   */
  private async sendSeatSnapshot(bootstrapId: string, follower: ConnectedFollower): Promise<void> {
    const seatJid = follower.biscotto?.unitJid;
    if (!seatJid) {
      this.context.log.warn('Biscotto seat has no bound unit — sending no snapshot', {
        bootstrapId,
        biscottoId: follower.biscotto?.id,
      });
      return;
    }
    const { options } = this.context;
    let messages: ChatMessage[] = [];
    try {
      const scoops = options.getScoops?.();
      const exists = !scoops || scoops.some((scoop) => scoop.jid === seatJid);
      if (!exists) {
        this.context.log.warn('Biscotto seat unit no longer exists — sending an empty snapshot', {
          bootstrapId,
        });
      } else if (seatJid === options.getScoopJid()) {
        messages = options.getMessages();
      } else if (options.getMessagesForScoop) {
        messages = await Promise.resolve(options.getMessagesForScoop(seatJid));
      }
    } catch (err) {
      this.context.log.warn('Could not read the seat unit transcript — sending an empty snapshot', {
        bootstrapId,
        error: err instanceof Error ? err.message : String(err),
      });
      messages = [];
    }
    // The follower may have left while the transcript was read.
    const current = this.context.followers.followers.get(bootstrapId);
    if (current !== follower) return;
    follower.selectedScoopJid = seatJid;
    sendSnapshot(follower.sync, messages, seatJid);
  }

  broadcastSnapshot(): void {
    if (this.context.followers.followers.size === 0) return;
    for (const bootstrapId of this.context.followers.followers.keys()) {
      void this.sendSnapshotToFollower(bootstrapId);
    }
  }

  sendModelCatalogToFollower(bootstrapId: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;
    const models = this.buildModelCatalog();
    if (!models) return;
    this.publishModelCatalog(follower, models);
    this.sendModelStateToFollower(bootstrapId);
  }

  broadcastModelCatalog(): void {
    if (this.context.followers.followers.size === 0) return;
    const models = this.buildModelCatalog();
    if (!models) return;
    for (const follower of this.context.followers.followers.values()) {
      this.publishModelCatalog(follower, models);
    }
    this.broadcastModelState();
  }

  /**
   * Advertise a catalog to one follower. An EMPTY catalog sent BEFORE any real
   * one is "not ready yet", not "this leader has no models" (#2329): a follower
   * that attaches during provider warm-up stores `[]`, finds no entry matching
   * its active model id and hides the picker for the rest of the session, since
   * nothing re-sent the catalog when it became available. Skip that frame and
   * let the empty → non-empty re-broadcast deliver the real one. Once a follower
   * HAS seen a real catalog, an empty one is news worth sending (the last
   * account was removed).
   */
  private publishModelCatalog(follower: ConnectedFollower, models: TrayModelCatalogEntry[]): void {
    if (models.length === 0 && !follower.modelCatalogSent) {
      this.context.log.debug('Model catalog empty; deferring models.list', {
        bootstrapId: follower.bootstrapId,
      });
      return;
    }
    if (models.length > 0) follower.modelCatalogSent = true;
    follower.sync.send({ type: 'models.list', models });
  }

  broadcastModelState(): void {
    if (this.context.followers.followers.size === 0) return;
    for (const bootstrapId of this.context.followers.followers.keys()) {
      this.sendModelStateToFollower(bootstrapId);
    }
  }

  private sendModelStateToFollower(bootstrapId: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    const getState = this.context.options.getModelSelectionState;
    if (!follower) return;
    // Catch-up: any model-state change is also a chance to deliver a catalog
    // that was still empty when this follower attached (#2329).
    if (!follower.modelCatalogSent) {
      const models = this.buildModelCatalog();
      if (models && models.length > 0) this.publishModelCatalog(follower, models);
    }
    if (!getState) return;
    const scoopJid = follower.selectedScoopJid ?? this.context.options.getScoopJid();
    try {
      follower.sync.send({ type: 'model.state', state: getState(scoopJid) });
    } catch (err) {
      this.context.log.warn('Failed to compute model selection state', {
        bootstrapId,
        scoopJid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private buildModelCatalog(): TrayModelCatalogEntry[] | null {
    const getCatalog = this.context.options.getModelCatalog;
    if (!getCatalog) return null;
    try {
      return getCatalog().map((model) => ({
        providerName: model.providerName,
        modelId: model.modelId,
        modelName: model.modelName,
        reasoning: model.reasoning === true,
      }));
    } catch (err) {
      this.context.log.warn('Failed to compute model catalog', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  sendScoopsListToFollower(bootstrapId: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;
    // The inventory is the map a guest would enumerate from. It is also of no
    // use to a seat pinned to one thread, and its labels leak what else the
    // owner is working on.
    if (follower.trust === 'biscotto') return;
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
    // One payload for every peer: the ownership edge is the sole role source
    // (#2358 stage 3). Biscotto seats need no check here — `scoops.list` is
    // withheld at their channel, which is where the one guest boundary lives.
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

  /**
   * Deliver a sprinkle push to followers and report which runtimes got it.
   *
   * Without a target this fans out to every connected follower — the
   * historical behavior, now with a return value so `sprinkle send` can say
   * what it reached instead of always claiming success. With
   * `target.runtime` it delivers to that one follower, and an unresolvable
   * runtime id comes back as `unknownRuntime` rather than being silently
   * treated as a broadcast (issue #2166).
   *
   * "Reached" means the data channel accepted the message. A follower whose
   * channel refuses it (oversize payload, dead channel) is left out.
   */
  broadcastSprinkleUpdate(
    sprinkleName: string,
    data: unknown,
    target?: SprinkleSendTarget
  ): SprinkleBroadcastResult {
    const registry = this.context.followers;
    const message: LeaderToFollowerMessage = { type: 'sprinkle.update', sprinkleName, data };

    if (target?.runtime) {
      const resolved = registry.resolveFollowerByRuntimeId(target.runtime);
      if (!resolved) return { followers: [], unknownRuntime: target.runtime };
      const sent = resolved.follower.sync.send(message);
      return { followers: sent ? [target.runtime] : [] };
    }

    if (registry.followers.size === 0) return { followers: [] };
    const failed = new Set(registry.broadcastToAllFollowers(message));
    const reached: string[] = [];
    for (const bootstrapId of registry.followers.keys()) {
      if (failed.has(bootstrapId)) continue;
      reached.push(registry.runtimeIdForBootstrap(bootstrapId) ?? bootstrapId);
    }
    return { followers: reached };
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
