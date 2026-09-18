import { createLogger } from '../base/logger.js';
import {
  isUnhonoredSudoersPath,
  matchCommand,
  matchPath,
  type SudoersPolicy,
} from '../base/sudoers.js';
import {
  type ConeApprovalRouter,
  ConeRequestRegistry,
  createConeApprovalBroker,
  type PendingSudoRequest,
  type SudoBroker,
  type SudoDecision,
  type SudoRequest,
  type SudoSettleReason,
} from '../sudo/index.js';
import type { SudoManager } from '../sudo/sudo-manager.js';
import type { LickManager } from './lick-manager.js';
import type { ChannelMessage, RegisteredScoop } from './types.js';

const log = createLogger('scoop-approval-router');

export interface ScoopApprovalRouterDeps {
  getScoops(): Map<string, RegisteredScoop>;

  findApprover(scoopJid: string | undefined): RegisteredScoop | undefined;

  getSudoManager(): SudoManager | null;

  getLickManager(): LickManager | null;

  handleMessage(msg: ChannelMessage): Promise<void>;

  onMessageUpdate(
    scoopJid: string,
    update: {
      messageId: string;
      lickId?: string;
      lickState?: 'pending' | 'confirmed' | 'dismissed';
    }
  ): void;

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
  private registry: ConeRequestRegistry;
  constructor(private deps: ScoopApprovalRouterDeps) {
    this.registry = new ConeRequestRegistry({
      onAutoSettle: (id, reason, scoopJid) => this.handleAutoSettle(id, reason, scoopJid),
    });
  }

  private handleAutoSettle(id: string, reason: SudoSettleReason, scoopJid?: string): void {
    log.info('Sudo request auto-settled fail-closed; retiring lick card', { id, reason });
    void this.persistLickDecision(id, 'deny', scoopJid).catch((err) => {
      log.warn('Failed to persist auto-settled lick decision', {
        id,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  getConeSudoBroker(scoopJid: string): SudoBroker {
    return createConeApprovalBroker(scoopJid, this);
  }

  listPendingSudoRequests(approverJid?: string): PendingSudoRequest[] {
    const all = this.registry.list();
    if (approverJid === undefined) return all;
    return all.filter((entry) => entry.approverJid === approverJid);
  }

  private maySettle(id: string, approverJid: string | undefined): boolean {
    if (approverJid === undefined) return true;
    return this.registry.get(id)?.approverJid === approverJid;
  }

  failScoop(scoopJid: string): number {
    return this.registry.failScoop(scoopJid);
  }

  failAll(): number {
    return this.registry.failAll();
  }

  settleGrantedRequests(folder?: string): number {
    const sudoManager = this.deps.getSudoManager();
    if (!sudoManager) return 0;
    const scoops = this.deps.getScoops();
    let settled = 0;
    for (const pending of this.registry.list()) {
      const scoop = scoops.get(pending.scoopJid);
      if (!scoop) continue;
      if (folder !== undefined && scoop.folder !== folder) continue;
      const policy = sudoManager.getPolicyForScoop(scoop.folder);
      if (!isNopasswdGranted(policy, pending.request)) continue;
      const { kind, detail } = pending.request;

      if (this.registry.resolve(pending.id, { decision: 'allow' })) {
        settled++;
        log.info('Sudo request auto-settled: policy now grants it', {
          id: pending.id,
          folder: scoop.folder,
          kind,
          detail: detail.slice(0, 80),
        });
        void this.persistLickDecision(pending.id, 'allow', pending.scoopJid).catch((err) => {
          log.warn('Failed to persist auto-granted lick decision', {
            id: pending.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
    return settled;
  }

  private admitIfAlreadyGranted(scoopJid: string, request: SudoRequest): SudoDecision | null {
    const scoop = this.deps.getScoops().get(scoopJid);
    const sudoManager = this.deps.getSudoManager();
    if (!scoop || !sudoManager) return null;
    const policy = sudoManager.getPolicyForScoop(scoop.folder);
    if (!isNopasswdGranted(policy, request)) return null;
    log.info('Sudo request already granted by policy — skipping cone', {
      scoopJid,
      folder: scoop.folder,
      kind: request.kind,
      detailPreview: request.detail.slice(0, 80),
    });
    return { decision: 'allow' };
  }

  async enqueueSudoRequest(
    scoopJid: string,
    request: SudoRequest,
    opts: { approver?: RegisteredScoop } = {}
  ): Promise<SudoDecision> {
    const scoops = this.deps.getScoops();

    const cone = opts.approver ?? this.deps.findApprover(scoopJid);
    if (!cone) {
      log.warn('Sudo request received but no approver is registered — failing closed', {
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

    if (request.kind === 'write' && isUnhonoredSudoersPath(request.detail)) {
      log.warn('Refusing sudo request for an unhonoured sudoers path', {
        scoopJid,
        detail: request.detail,
      });
      return { decision: 'deny' };
    }

    const alreadyGranted = this.admitIfAlreadyGranted(scoopJid, request);
    if (alreadyGranted) return alreadyGranted;

    const { id, pending } = this.registry.register(scoopJid, request, cone.jid);
    log.info('Sudo request enqueued for cone', {
      id,
      scoopJid,
      kind: request.kind,
      detailPreview: request.detail.slice(0, 80),
    });

    const scoopForLick = scoops.get(scoopJid);
    this.deps.getLickManager()?.emitEvent({
      type: 'sudo-request',
      lickId: id,
      sudoKind: request.kind,
      sudoDetail: request.detail,

      sudoScoopName:
        request.requester ?? scoopForLick?.assistantLabel ?? scoopForLick?.name ?? scoopJid,
      sudoSuggestedPattern: request.suggestedPattern,
      sudoReason: request.reason,
      targetScoop: cone.name,
      timestamp: new Date().toISOString(),
      body: {
        requestId: id,
        kind: request.kind,
        detail: request.detail,
        suggestedPattern: request.suggestedPattern,
        reason: request.reason,
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

  resolveSudoRequest(id: string, decision: SudoDecision, approverJid?: string): boolean {
    if (!this.maySettle(id, approverJid)) {
      log.warn('Refusing a settle from a unit the request was not routed to', {
        id,
        approverJid,
      });
      return false;
    }
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

  async resolveSudoRequestAndPersist(
    id: string,
    decision: SudoDecision,
    approverJid?: string
  ): Promise<ResolveSudoRequestAndPersistResult> {
    const pending = this.registry.get(id);
    if (!pending) {
      return { settled: false, persisted: false };
    }

    if (!this.maySettle(id, approverJid)) {
      log.warn('Refusing a settle+persist from a unit the request was not routed to', {
        id,
        approverJid,
      });
      return { settled: false, persisted: false };
    }

    const requesterJid = pending.scoopJid;

    const cardOwnerJid = pending.approverJid;

    const settled = this.resolveSudoRequest(id, decision, approverJid);
    if (!settled) {
      return { settled: false, persisted: false };
    }

    const scoop = this.deps.getScoops().get(pending.scoopJid);
    const kind = pending.request.kind;
    const scoopFolder = scoop?.folder;
    const sudoManager = this.deps.getSudoManager();

    let persisted = false;
    let persistedPattern: string | undefined;
    let persistError: string | undefined;

    if (decision.decision === 'always' && sudoManager && scoop && scoop.parentJid !== null) {
      if (kind === 'command' || kind === 'read' || kind === 'write') {
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

    await this.persistLickDecision(id, decision.decision, requesterJid, cardOwnerJid);
    return { settled, persisted, persistedPattern, persistError, scoopFolder, kind };
  }

  async persistLickDecision(
    lickId: string,
    decision: SudoDecision['decision'],
    scoopJid?: string,
    approverJid?: string
  ): Promise<void> {
    const lickState = decision === 'deny' ? 'dismissed' : 'confirmed';

    const explicit = approverJid ?? this.registry.get(lickId)?.approverJid;
    const cone = explicit
      ? this.deps.getScoops().get(explicit)
      : this.deps.findApprover(scoopJid ?? this.registry.get(lickId)?.scoopJid);
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

  private async deliverSudoRequestToCone(
    cone: RegisteredScoop,
    scoopJid: string,
    id: string,
    request: SudoRequest
  ): Promise<void> {
    const scoop = this.deps.getScoops().get(scoopJid);

    const senderName = request.requester ?? scoop?.assistantLabel ?? scoopJid;
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

      lickId: id,
      lickState: 'pending',
    };

    await this.deps.handleMessage(msg);
  }
}

function isNopasswdGranted(policy: SudoersPolicy, request: SudoRequest): boolean {
  const { kind, detail } = request;
  if (kind === 'command') return matchCommand(policy, detail) === 'nopasswd-allow';
  if (kind === 'read' || kind === 'write') {
    return matchPath(policy, kind, detail) === 'nopasswd-allow';
  }
  return false;
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
  if (request.reason) lines.push(`Reason given: ${request.reason}`);
  if (request.suggestedPattern) {
    lines.push(`Suggested pattern: ${request.suggestedPattern}`);
  }
  lines.push(
    '',
    `Use the lick_confirm tool with lick_id="${id}" to approve (or always-approve with a pattern), or lick_dismiss with lick_id="${id}" and a reason to deny. A denial without a reason tells the scoop nothing it can act on.`
  );
  return lines.join('\n');
}
