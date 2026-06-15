import { previewSecret } from '@slicc/shared-ts';
import express, { type Express, type Response } from 'express';
import type { EnvSecretStore } from '../secrets/env-secret-store.js';
import type { OauthSecretStore } from '../secrets/oauth-secret-store.js';
import type { SecretProxyManager } from '../secrets/proxy-manager.js';
import { handleDaSignAndForward, handleS3SignAndForward } from '../secrets/sign-and-forward.js';

export interface SecretRoutesDeps {
  secretStore: EnvSecretStore;
  secretProxy: SecretProxyManager;
  oauthStore: OauthSecretStore;
  /** When true, the full sign-and-forward error is logged for the local operator. */
  devMode: boolean;
}

/**
 * Sign-and-forward failure responder. Logs only a generic line + trace id —
 * the err.message can carry profile names, bucket names, or partial URLs we
 * don't want in shared log aggregators. The trace id lets the user correlate
 * the 500 they got with the server log; the detail goes to the file logger
 * (above DEBUG) only when devMode is on.
 */
function respondSignAndForwardError(
  res: Response,
  err: unknown,
  devMode: boolean,
  label: string
): void {
  const traceId = (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)
  ).slice(0, 8);
  console.error(`${label} sign-and-forward error [trace=${traceId}]`);
  if (devMode) {
    console.error(err);
  }
  if (!res.headersSent) {
    res.status(500).json({
      ok: false,
      error: `internal sign-and-forward error [trace=${traceId}]`,
      errorCode: 'internal',
    });
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((d) => typeof d === 'string');
}

/**
 * Persisted/session delete handler — checks the session store first so a
 * session shadow does not leak through after deletion, then falls back to the
 * persisted store. Reloads the masking pipeline either way.
 */
async function handleDeleteSecret(
  name: string | undefined,
  res: Response,
  secretStore: EnvSecretStore,
  secretProxy: SecretProxyManager
): Promise<Response> {
  if (typeof name !== 'string' || name.length === 0) {
    return res.status(400).json({ error: 'bad-request' });
  }
  try {
    if (secretProxy.sessionStore.has(name)) {
      secretProxy.sessionStore.delete(name);
      await secretProxy.reload();
      return res.json({ ok: true, name, fromSession: true });
    }
    if (secretStore.get(name)) {
      secretStore.delete(name);
      await secretProxy.reload();
      return res.json({ ok: true, name, fromSession: false });
    }
    return res.status(404).json({ error: `no secret named "${name}"` });
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'Failed to delete secret' });
  }
}

/**
 * Secret management API — direct .env file access (no browser needed). The
 * `secretStore` is wired into `secretProxy` so the fetch-proxy and the
 * management API share one source of truth.
 */
export function registerSecretRoutes(app: Express, deps: SecretRoutesDeps): void {
  const { secretStore, secretProxy, oauthStore, devMode } = deps;

  app.get('/api/secrets', (_req, res) => {
    try {
      res.json(secretStore.list());
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Failed to list secrets' });
    }
  });

  // Persisted-set — write a secret to ~/.slicc/secrets.env. Gated by the agent's
  // intrinsic sudo prompt before the request is ever sent.
  app.post('/api/secrets', express.json(), async (req, res) => {
    const { name, value, domains } = req.body ?? {};
    if (typeof name !== 'string' || typeof value !== 'string' || !isStringArray(domains)) {
      return res.status(400).json({ error: 'bad-request' });
    }
    try {
      secretStore.set(name, value, domains);
      await secretProxy.reload();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to set secret' });
    }
  });

  // Persisted/session delete — remove a named secret (and its _DOMAINS
  // companion) from whichever store currently holds it. Session secrets are
  // checked first so a session shadow does not leak through after deletion.
  // Reloads the masking pipeline so the change takes effect without restart.
  app.delete('/api/secrets/:name', (req, res) =>
    handleDeleteSecret(req.params.name, res, secretStore, secretProxy)
  );

  // Scope edit — update the allowed domains of an existing secret (persisted or
  // session), preserving the value. Gated by the agent before sending.
  app.post('/api/secrets/scope', express.json(), async (req, res) => {
    const { name, domains } = req.body ?? {};
    if (typeof name !== 'string' || !isStringArray(domains)) {
      return res.status(400).json({ error: 'bad-request' });
    }
    try {
      if (secretProxy.sessionStore.has(name)) {
        secretProxy.sessionStore.setDomains(name, domains);
      } else {
        const existing = secretStore.get(name);
        if (!existing) return res.status(404).json({ error: `no secret named "${name}"` });
        secretStore.set(name, existing.value, domains);
      }
      await secretProxy.reload();
      res.json({ ok: true });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Failed to update scope' });
    }
  });

  // Session secrets — in-memory only, never written to disk. Free for the agent
  // to create; the masking pipeline picks them up on the reload below.
  app.get('/api/secrets/session', (_req, res) => {
    res.json(secretProxy.sessionStore.list());
  });

  app.post('/api/secrets/session', express.json(), async (req, res) => {
    const { name, value, domains } = req.body ?? {};
    if (
      typeof name !== 'string' ||
      typeof value !== 'string' ||
      (domains !== undefined && !isStringArray(domains))
    ) {
      return res.status(400).json({ error: 'bad-request' });
    }
    secretProxy.sessionStore.set(name, value, Array.isArray(domains) ? domains : []);
    await secretProxy.reload();
    res.json({ ok: true });
  });

  // Peek — elided preview of the unmasked value (session or persisted). The
  // full value never leaves the server.
  app.get('/api/secrets/peek', (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!name) return res.status(400).json({ error: 'bad-request' });
    const session = secretProxy.sessionStore.getRecord(name);
    if (session) {
      return res.json({ name, preview: previewSecret(session.value), domains: session.domains });
    }
    const persisted = secretStore.get(name);
    if (persisted) {
      return res.json({
        name,
        preview: previewSecret(persisted.value),
        domains: persisted.domains,
      });
    }
    return res.status(404).json({ error: `no secret named "${name}"` });
  });

  // S3 sign-and-forward — browser-side mount backend posts envelopes here;
  // server resolves the s3.<profile>.* secrets, signs SigV4 v4, forwards to
  // the upstream, returns the response as a JSON envelope. The browser
  // never sees access_key_id / secret_access_key.
  app.post('/api/s3-sign-and-forward', async (req, res) => {
    try {
      await handleS3SignAndForward(req, res, secretStore);
    } catch (err) {
      respondSignAndForwardError(res, err, devMode, 'S3');
    }
  });

  // DA sign-and-forward — same pattern as S3, but for Adobe da.live. The
  // IMS bearer token is passed transiently in the envelope (browser holds
  // it via the existing Adobe LLM provider). v2 will move OAuth server-side
  // to remove the browser exposure entirely.
  app.post('/api/da-sign-and-forward', async (req, res) => {
    try {
      await handleDaSignAndForward(req, res);
    } catch (err) {
      respondSignAndForwardError(res, err, devMode, 'DA');
    }
  });

  // Tool-output real→masked scrub. The browser-side agent realm never holds
  // real secret values, so the defense-in-depth scrub of bash / read_file /
  // other tool results runs here against the node-server-owned
  // SecretProxyManager. Direction is real→masked ONLY (`scrubResponse`), so it
  // is always safe and idempotent for already-masked tokens and secret-free
  // output. The caller treats any non-2xx / malformed response as "return
  // input unchanged" — the scrub is defense-in-depth, not the primary defense.
  app.post('/api/secrets/scrub', express.json({ limit: '32mb' }), (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'bad-request' });
    }
    try {
      res.json({ text: secretProxy.scrubResponse(text) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'scrub failed', text });
    }
  });

  // Masked secrets endpoint — returns name + maskedValue pairs for shell env
  // population. Real values are never exposed; only deterministic
  // session-scoped masks.
  app.get('/api/secrets/masked', (_req, res) => {
    try {
      res.json(secretProxy.getMaskedEntries());
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Failed to get masked secrets' });
    }
  });

  // OAuth secret update — stores access token from OAuth login flow
  app.post('/api/secrets/oauth-update', express.json(), async (req, res) => {
    const { providerId, accessToken, domains } = req.body ?? {};
    if (
      typeof providerId !== 'string' ||
      typeof accessToken !== 'string' ||
      !isStringArray(domains) ||
      domains.length === 0
    ) {
      return res.status(400).json({ error: 'bad-request' });
    }
    const name = `oauth.${providerId}.token`;
    oauthStore.set(name, accessToken, domains);
    await secretProxy.reload();
    const masked = secretProxy.getMaskedEntries().find((e) => e.name === name)?.maskedValue;
    res.json({ providerId, name, maskedValue: masked, domains });
  });

  // OAuth secret deletion — removes access token on logout
  app.delete('/api/secrets/oauth/:providerId', async (req, res) => {
    const name = `oauth.${req.params.providerId}.token`;
    if (!oauthStore.list().some((e) => e.name === name)) {
      return res.status(404).json({ error: 'not-found' });
    }
    oauthStore.delete(name);
    await secretProxy.reload();
    res.status(204).end();
  });
}
