import express, { type Express, type Request, type Response } from 'express';

/**
 * Generic OAuth redirect target for OAuth providers (implicit + PKCE).
 *
 * The callback page always POSTs the result to `/api/oauth-result`, which
 * the UI polls via the GET counterpart — the server holds the single
 * pending result in memory between the two calls. It ALSO best-effort
 * `window.opener.postMessage`s when an opener is present, as a faster
 * same-origin shortcut. The POST must not be conditional on a missing
 * opener: in the standalone thin-bridge float the UI is always loaded
 * cross-origin from the local server (`node-server serves no UI in any
 * mode`), so the popup's opener origin never matches `window.location.origin`
 * on the receiving end and the message is silently dropped even when
 * `window.opener` is non-null (e.g. GitHub, which does not sever it via
 * COOP) — leaving the poll as the only path that can actually deliver the
 * result.
 */
export function registerOAuthCallbackRoutes(app: Express): void {
  // Pending OAuth result for server-side relay (Electron overlay can't use window.opener)
  let pendingOAuthResult: { redirectUrl: string; error?: string } | null = null;

  app.get('/auth/callback', (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html><html><body><script>
      var q = new URLSearchParams(location.search);
      var h = new URLSearchParams(location.hash.replace(/^#/, ''));
      var payload = {
        type: 'oauth-callback',
        redirectUrl: location.href,
        code: q.get('code'),
        state: q.get('state') || h.get('state'),
        error: q.get('error') || h.get('error'),
        access_token: h.get('access_token'),
        expires_in: h.get('expires_in'),
        token_type: h.get('token_type')
      };
      if (window.opener) {
        try {
          window.opener.postMessage(payload, '*');
        } catch (e) {
          console.warn('[oauth-callback] postMessage to opener failed:', e);
        }
      }
      fetch('/api/oauth-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function(err) { console.error('[oauth-callback] Failed to relay result to server:', err); });
      window.close();
    </script><p>Completing login... you can close this window.</p></body></html>`);
  });

  app.post('/api/oauth-result', express.json(), (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const redirectUrl = typeof body.redirectUrl === 'string' ? body.redirectUrl : '';
    if (!redirectUrl) {
      console.warn('[oauth-result] Received callback with empty redirectUrl');
    }
    pendingOAuthResult = {
      redirectUrl,
      error: typeof body.error === 'string' ? body.error : undefined,
    };
    res.json({ ok: true });
  });

  app.get('/api/oauth-result', (_req: Request, res: Response) => {
    if (pendingOAuthResult) {
      const result = pendingOAuthResult;
      pendingOAuthResult = null;
      res.json(result);
    } else {
      res.status(204).end();
    }
  });
}
