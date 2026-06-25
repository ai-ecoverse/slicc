/**
 * ScoopApprovalRouter - owns the cone-mediated sudo-request lifecycle.
 *
 * Implements `ConeApprovalRouter`: a non-cone scoop's `SudoBroker.requestApproval`
 * call enters here via {@link enqueueSudoRequest}, the request is registered in
 * the {@link ConeRequestRegistry}, delivered to the cone (lick chip + queued
 * actionable message), and the pending promise is returned to the scoop. The
 * cone settles it via {@link resolveSudoRequest} / {@link resolveSudoRequestAndPersist};
 * unregister / shutdown drains pending requests fail-closed.
 *
 * Extracted from `Orchestrator` so the registry, delivery, persistence, and
 * sudoers-write paths live next to the data they own. Cone-state lookups
 * (scoops map, sudo manager, lick manager, callbacks, db handle) are injected
 * via {@link ScoopApprovalRouterDeps} so this module stays free of
 * orchestrator coupling.
 */

import { createLogger } from '../core/logger.js';
import {
  type ConeApprovalRouter,
  ConeRequestRegistry,
  createConeApprovalBroker,
  type PendingSudoRequest,
  type SudoBroker,
  type SudoDecision,
  type SudoRequest,
} from '../sudo/index.js';
import type { SudoManager } from '../sudo/sudo-manager.js';
import type { LickManager } from './lick-manager.js';
import type { ChannelMessage, RegisteredScoop } from './types.js';

const log = createLogger('scoop-approval-router');

export interface ScoopApprovalRouterDeps {
  /** Live snapshot of registered scoops; the router reads `isCone`, `assistantLabel`, `folder`, `name`. */
  getScoops(): Map<string, RegisteredScoop>;
  /** Live SudoManager (or null before init / after shutdown). The `'always'` path writes a NOPASSWD rule via this sink. */
  getSudoManager(): SudoManager | null;
  /** Live LickManager (or null before wiring). Used to emit the `'sudo-request'` UI chip. */
  getLickManager(): LickManager | null;
  /** Route the cone-facing actionable message through the orchestrator's normal queue. */
  handleMessage(msg: ChannelMessage): Promise<void>;
  /** Best-effort UI re-render of the persisted lick card once a decision settles. */
  onMessageUpdate(
    scoopJid: string,
    update: {
      messageId: string;
      lickId?: string;
      lickState?: 'pending' | 'confirmed' | 'dismissed';
    }
  ): void;
  /** DB seam — kept injectable so tests can stub without monkey-patching the module-scope import. */
  getMessagesForScoop(jid: string): Promise<ChannelMessage[]>;
  saveMessage(msg: ChannelMessage): Promise<void>;
}

export interface ResolveSudoRequestAndPersistResult {
  settled: boolean;
  persisted: boolean;
  persistedPattern?: string;
  persistError?: string;
  scoopFolder?: string;
  kind?: SudoRequest['kind'];
}

export class ScoopApprovalRouter implements ConeApprovalRouter {
  private registry: ConeRequestRegistry = new ConeRequestRegistry();

  constructor(private deps: ScoopApprovalRouterDeps) {}

  /** Build the per-scoop {@link SudoBroker}; scoop's gated FS / shell calls route here. */
  getConeSudoBroker(scoopJid: string): SudoBroker {
    return createConeApprovalBroker(scoopJid, this);
  }

  /** Snapshot all pending cone-mediated sudo requests (cone-side listing). */
  listPendingSudoRequests(): PendingSudoRequest[] {
    return this.registry.list();
  }

  /** Fail-closed every pending request for the given scoop. Used by `unregisterScoop`. */
  failScoop(scoopJid: string): number {
    return this.registry.failScoop(scoopJid);
  }

  /** Fail-closed every pending request. Used by `shutdown`. */
  failAll(): number {
    return this.registry.failAll();
  }

  async enqueueSudoRequest(scoopJid: string, request: SudoRequest): Promise<SudoDecision> {
    const scoops = this.deps.getScoops();
    const cone = Array.from(scoops.values()).find((s) => s.isCone);
    if (!cone) {
      log.warn('Sudo request received but no cone is registered — failing closed', {
        scoopJid,
        kind: request.kind,
      });
      return { decision: 'deny' };
    }
    if (!scoops.has(scoopJid)) {
      log.warn('Sudo request from unknown scoop — failing closed', {
        scoopJid,
        kind: request.kind,
      });
      return { decision: 'deny' };
    }

    const { id, pending } = this.registry.register(scoopJid, request);
    log.info('Sudo request enqueued for cone', {
      id,
      scoopJid,
      kind: request.kind,
      detailPreview: request.detail.slice(0, 80),
    });

    // Path (b): emit a `'sudo-request'` lick as the UI chip and keep the
    // queued actionable message for the agent. `defaultLickEventHandler`
    // skips its `formatLickEventForCone` → `handleMessage` routing for
    // this type so the cone agent isn't told twice — the actionable
    // message below is the single agent delivery. The lick is NOT in
    // `FORWARDABLE_TO_LEADER`: sudo decisions stay local to the float
    // that owns the requesting scoop.
    const scoopForLick = scoops.get(scoopJid);
    this.deps.getLickManager()?.emitEvent({
      type: 'sudo-request',
      lickId: id,
      sudoKind: request.kind,
      sudoDetail: request.detail,
      sudoScoopName: scoopForLick?.assistantLabel ?? scoopForLick?.name ?? scoopJid,
      sudoSuggestedPattern: request.suggestedPattern,
      targetScoop: cone.name,
      timestamp: new Date().toISOString(),
      body: {
        requestId: id,
        kind: request.kind,
        detail: request.detail,
        suggestedPattern: request.suggestedPattern,
        scoopJid,
      },
    });

    try {
      await this.deliverSudoRequestToCone(cone, scoopJid, id, request);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('Failed to deliver sudo request to cone — failing closed', {
        id,
        scoopJid,
        error: errMsg,
      });
      this.registry.resolve(id, { decision: 'deny' });
    }

    return pending;
  }

  /**
   * Settle a pending cone-mediated sudo request. Used by the cone's
   * `lick_confirm` / `lick_dismiss` tools (and tests). Returns `true` when an
   * entry was actually resolved, `false` for unknown / already-settled /
   * timed-out ids so the caller can surface that as "this request expired"
   * to the cone.
   */
  resolveSudoRequest(id: string, decision: SudoDecision): boolean {
    const settled = this.registry.resolve(id, decision);
    if (settled) {
      log.info('Sudo request resolved by cone', { id, decision: decision.decision });
    } else {
      log.warn('Sudo request resolve: unknown / already-settled id', {
        id,
        decision: decision.decision,
      });
    }
    return settled;
  }

  /**
   * Cone-tool surface: settle a pending sudo request and, when the
   * decision is `'always'`, durably widen the requesting scoop's sandbox
   * by appending a `NOPASSWD <directive> <pattern>` line to its
   * `/scoops/<folder>/etc/sudoers` via the trusted manager sink.
   */
  async resolveSudoRequestAndPersist(
    id: string,
    decision: SudoDecision
  ): Promise<ResolveSudoRequestAndPersistResult> {
    const pending = this.registry.get(id);
    if (!pending) {
      return { settled: false, persisted: false };
    }

    const scoop = this.deps.getScoops().get(pending.scoopJid);
    const kind = pending.request.kind;
    const scoopFolder = scoop?.folder;
    const sudoManager = this.deps.getSudoManager();

    let persisted = false;
    let persistedPattern: string | undefined;
    let persistError: string | undefined;

    if (decision.decision === 'always' && sudoManager && scoop && !scoop.isCone) {
      if (kind === 'read') {
        // A persisted `NOPASSWD Read <pattern>` would silently no-op: the
        // scoop's `RestrictedFS.visiblePaths` is fixed at construction, so
        // subsequent reads of paths outside the original sandbox keep
        // throwing ENOENT. Reporting `persisted: true` would be a lie.
        persistError = 'read grants need ACL widening, not yet supported';
      } else if (kind === 'command' || kind === 'write') {
        const raw =
          decision.pattern?.trim() ||
          pending.request.suggestedPattern?.trim() ||
          pending.request.detail.trim();
        try {
          const saved = await sudoManager.appendScoopRule(scoop.folder, kind, raw);
          if (saved) {
            persisted = true;
            persistedPattern = saved;
          } else {
            persistError = 'pattern collapsed to empty after sanitization';
          }
        } catch (err) {
          persistError = err instanceof Error ? err.message : String(err);
          log.warn('Failed to persist always grant', {
            id,
            folder: scoop.folder,
            kind,
            error: persistError,
          });
        }
      } else {
        persistError = `cannot persist always grant for kind "${kind}" (no matching sudoers directive)`;
      }
    }

    const settled = this.resolveSudoRequest(id, decision);
    if (settled) {
      await this.persistLickDecision(id, decision.decision);
    }
    return { settled, persisted, persistedPattern, persistError, scoopFolder, kind };
  }

  /**
   * Flip the rendered + persisted state of an actionable lick once its
   * decision settles. Best-effort — a missing message or store error is
   * logged, not thrown.
   */
  async persistLickDecision(lickId: string, decision: SudoDecision['decision']): Promise<void> {
    const lickState = decision === 'deny' ? 'dismissed' : 'confirmed';
    const cone = Array.from(this.deps.getScoops().values()).find((s) => s.isCone);
    if (!cone) return;
    try {
      const messages = await this.deps.getMessagesForScoop(cone.jid);
      const target = messages.find((m) => m.lickId === lickId || m.id === `sudo-request-${lickId}`);
      if (!target) {
        log.warn('Lick decision: no stored message found to flip', { lickId });
        return;
      }
      target.lickState = lickState;
      await this.deps.saveMessage(target);
      this.deps.onMessageUpdate(cone.jid, {
        messageId: target.id,
        lickId,
        lickState,
      });
    } catch (err) {
      log.warn('Failed to persist lick decision', {
        lickId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Build the cone-facing `sudo-request` `ChannelMessage` and hand it to
   * `handleMessage`. `sudo-request` is a member of `EXTERNAL_LICK_CHANNELS`,
   * so `handleMessage` fires the UI chip (`onIncomingMessage`) automatically.
   */
  private async deliverSudoRequestToCone(
    cone: RegisteredScoop,
    scoopJid: string,
    id: string,
    request: SudoRequest
  ): Promise<void> {
    const scoop = this.deps.getScoops().get(scoopJid);
    const senderName = scoop?.assistantLabel ?? scoopJid;
    const senderId = scoop?.folder ?? scoopJid;
    const content = formatSudoRequestNotification(senderName, id, request);

    const msg: ChannelMessage = {
      id: `sudo-request-${id}`,
      chatJid: cone.jid,
      senderId,
      senderName,
      content,
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'sudo-request',
      // Carry the actionable lick id so the resolve path can locate this
      // stored message (and its rendered card) when the cone settles it.
      lickId: id,
      lickState: 'pending',
    };

    await this.deps.handleMessage(msg);
  }
}

function formatSudoRequestNotification(
  senderName: string,
  id: string,
  request: SudoRequest
): string {
  const lines = [
    `[@${senderName} sudo-request]`,
    `Lick ID: ${id}`,
    `Kind: ${request.kind}`,
    `Detail: ${request.detail}`,
  ];
  if (request.suggestedPattern) {
    lines.push(`Suggested pattern: ${request.suggestedPattern}`);
  }
  lines.push(
    '',
    `Use the lick_confirm tool with lick_id="${id}" to approve (or always-approve with a pattern), or lick_dismiss with lick_id="${id}" to deny.`
  );
  return lines.join('\n');
}
