import type { LeaderSyncContext } from './context.js';

const OAUTH_DELEGATION_TIMEOUT_MS = 125_000;

export interface DelegatedOAuthResult {
  redirectUrl: string | null;
  error?: string;
}

type Waiter = (result: DelegatedOAuthResult) => void;

export class OAuthPopupDelegation {
  private readonly waiters = new Map<string, Waiter>();
  private counter = 0;

  constructor(private readonly context: LeaderSyncContext) {
    context.followers.onFollowerRemoved({
      afterRegistryCleanup: (bootstrapId) =>
        this.settleAllForFollower(bootstrapId, {
          redirectUrl: null,
          error: 'the follower handling this login disconnected',
        }),
    });
  }

  private static key(bootstrapId: string, requestId: string): string {
    return `${bootstrapId}:${requestId}`;
  }

  requestPopup(bootstrapId: string, url: string): Promise<DelegatedOAuthResult> {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) {
      return Promise.resolve({ redirectUrl: null, error: 'follower is no longer connected' });
    }
    const requestId = `oauth-popup-${Date.now()}-${++this.counter}`;
    const key = OAuthPopupDelegation.key(bootstrapId, requestId);

    return new Promise<DelegatedOAuthResult>((resolve) => {
      const timer = setTimeout(() => {
        this.context.log.warn('Delegated OAuth popup timed out', { bootstrapId, requestId });
        this.settle(key, { redirectUrl: null, error: 'the delegated login timed out' });
      }, OAUTH_DELEGATION_TIMEOUT_MS);

      this.waiters.set(key, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      const sent = follower.sync.send({ type: 'oauth.popup.request', requestId, url });
      if (sent === false) {
        this.context.log.warn('Could not deliver delegated OAuth popup request', {
          bootstrapId,
          requestId,
        });
        this.settle(key, { redirectUrl: null, error: 'could not reach the follower' });
      }
    });
  }

  handlePopupResponse(
    bootstrapId: string,
    requestId: string,
    redirectUrl: string | undefined,
    error: string | undefined
  ): void {
    this.settle(OAuthPopupDelegation.key(bootstrapId, requestId), {
      redirectUrl: redirectUrl ?? null,
      error,
    });
  }

  private settle(key: string, result: DelegatedOAuthResult): void {
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    waiter(result);
  }

  private settleAllForFollower(bootstrapId: string, result: DelegatedOAuthResult): void {
    for (const key of [...this.waiters.keys()]) {
      if (key.startsWith(`${bootstrapId}:`)) this.settle(key, result);
    }
  }
}
