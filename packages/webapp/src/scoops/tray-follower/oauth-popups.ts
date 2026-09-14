import type { FollowerSyncContext } from './context.js';

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

  abortAll(): void {
    for (const controller of this.oauthPopupAborts.values()) controller.abort();
    this.oauthPopupAborts.clear();
  }
}
