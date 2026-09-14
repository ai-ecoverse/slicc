import express, { type Express, type Request, type Response } from 'express';

export interface OAuthResultPostBody {
  redirectUrl?: unknown;
  error?: unknown;
}

export interface PendingOAuthResult {
  redirectUrl: string;
  error?: string;
}

export function registerOAuthCallbackRoutes(app: Express): void {
  let pendingOAuthResult: PendingOAuthResult | null = null;

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
      var closed = false;
      function closeWindow() {
        if (closed) return;
        closed = true;
        window.close();
      }
      setTimeout(closeWindow, 2000);
      fetch('/api/oauth-result', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function(err) { console.error('[oauth-callback] Failed to relay result to server:', err); }).finally(closeWindow);
    </script><p>Completing login... you can close this window.</p></body></html>`);
  });

  app.post('/api/oauth-result', express.json(), (req: Request, res: Response) => {
    const body = req.body as OAuthResultPostBody;
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
