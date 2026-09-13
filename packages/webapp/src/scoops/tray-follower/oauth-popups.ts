import type { FollowerSyncContext } from './context.js';

/**
 * Leader-delegated OAuth popup lifecycle (#1915). Fail-closed: a float with
 * no handler, a throwing handler, and an aborted attempt all send a single
 * `oauth.popup.response` so the leader never waits out its full timeout.
 */
export class FollowerOAuthPopups {
  private readonly oauthPopupAborts = new Map<string, AbortController>();

  constructor(private readonly context: FollowerSyncContext) {}

  async handleRequest(requestId: string, url: string): Promise<void> {
    const handler = this.context.options.onOAuthPopupRequest;
    if (!handler) {
      this.context.log.warn('Leader delegated an OAuth popup, but this float cannot show one', {
        requestId,
      });
      this.context.send({
        type: 'oauth.popup.response',
        requestId,
        error: 'this follower cannot show an interactive login',
      });
      return;
    }
    const controller = new AbortController();
    this.oauthPopupAborts.set(requestId, controller);
    try {
      const redirectUrl = await handler(url, controller.signal);
      // A disconnect mid-login aborts the controller above, so this resolves
      // with null and the send lands on a closed channel — a silent no-op.
      // That is fine and deliberate: the leader does not wait on it, because
      // `OAuthPopupDelegation` settles every waiter for a departed follower
      // from its own `onFollowerRemoved` hook.
      this.context.send({
        type: 'oauth.popup.response',
        requestId,
        ...(redirectUrl ? { redirectUrl } : {}),
      });
    } catch (err) {
      this.context.log.warn('Delegated OAuth popup failed', {
        requestId,
        error: String(err),
      });
      this.context.send({
        type: 'oauth.popup.response',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.oauthPopupAborts.delete(requestId);
    }
  }

  /** Abort every in-flight popup. The leader that asked is gone. */
  abortAll(): void {
    for (const controller of this.oauthPopupAborts.values()) controller.abort();
    this.oauthPopupAborts.clear();
  }
}
