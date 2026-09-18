import type { LeaderToFollowerMessage } from '../tray-sync-protocol.js';
import type { FollowerSyncContext } from './context.js';
import type { SudoApprovalVerdict } from './types.js';

export class FollowerSudoClient {
  private readonly openSudoPrompts = new Map<string, AbortController>();

  constructor(private readonly context: FollowerSyncContext) {}

  handleLeaderMessage(
    message: Extract<
      LeaderToFollowerMessage,
      { type: 'sudo.approve.request' | 'sudo.approve.cancel' }
    >
  ): void {
    if (message.type === 'sudo.approve.cancel') {
      this.openSudoPrompts.get(message.requestId)?.abort();
      return;
    }
    void this.handleApprovalRequest(message);
  }

  private async handleApprovalRequest(
    message: Extract<LeaderToFollowerMessage, { type: 'sudo.approve.request' }>
  ): Promise<void> {
    const { requestId } = message;
    const reply = (verdict: SudoApprovalVerdict): void => {
      this.context.send({
        type: 'sudo.approve.response',
        requestId,
        decision: verdict.decision,
        ...(verdict.decision === 'always' && verdict.pattern ? { pattern: verdict.pattern } : {}),
        ...(verdict.attestation ? { attestation: verdict.attestation } : {}),
      });
    };
    const handler = this.context.options.onSudoApprovalRequest;
    if (!handler) {
      this.context.log.warn('No sudo approval handler wired — denying delegated prompt', {
        requestId,
      });
      reply({ decision: 'deny' });
      return;
    }
    if (this.openSudoPrompts.has(requestId)) return;
    const abort = new AbortController();
    this.openSudoPrompts.set(requestId, abort);
    let verdict: SudoApprovalVerdict = { decision: 'deny' };
    try {
      verdict = await handler({
        requestId,
        kind: message.kind,
        detail: message.detail,
        ...(message.suggestedPattern ? { suggestedPattern: message.suggestedPattern } : {}),
        ...(message.reason ? { reason: message.reason } : {}),
        ...(message.scoopName ? { scoopName: message.scoopName } : {}),
        ...(message.requester ? { requester: message.requester } : {}),
        expiresAt: message.expiresAt,
        signal: abort.signal,
      });
    } catch (err) {
      this.context.log.warn('Sudo approval dialog failed — denying', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      verdict = { decision: 'deny' };
    } finally {
      this.openSudoPrompts.delete(requestId);
    }
    if (abort.signal.aborted) {
      reply({ decision: 'deny' });
      return;
    }
    reply(verdict);
  }

  abortAll(): void {
    for (const controller of this.openSudoPrompts.values()) controller.abort();
    this.openSudoPrompts.clear();
  }
}
