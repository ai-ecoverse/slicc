import {
  isSingleLineSecretValue,
  multilineSecretValueError,
  previewSecret,
} from '@slicc/shared-ts';
import express, { type Express, type Response } from 'express';
import type { EnvSecretStore } from '../secrets/env-secret-store.js';
import type { OauthSecretStore } from '../secrets/oauth-secret-store.js';
import type { SecretProxyManager } from '../secrets/proxy-manager.js';
import { handleDaSignAndForward, handleS3SignAndForward } from '../secrets/sign-and-forward.js';

export interface SecretRoutesDeps {
  secretStore: EnvSecretStore;
  secretProxy: SecretProxyManager;
  oauthStore: OauthSecretStore;

  devMode: boolean;
}

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

async function handleScopeEdit(
  res: Response,
  name: unknown,
  domains: unknown,
  secretStore: EnvSecretStore,
  secretProxy: SecretProxyManager
): Promise<Response> {
  if (typeof name !== 'string' || !isStringArray(domains)) {
    return res.status(400).json({ error: 'bad-request' });
  }
  try {
    if (secretProxy.sessionStore.has(name)) {
      secretProxy.sessionStore.setDomains(name, domains);
    } else {
      const existing = secretStore.get(name);
      if (!existing) return res.status(404).json({ error: `no secret named "${name}"` });

      if (!isSingleLineSecretValue(existing.value)) {
        return res.status(400).json({ error: multilineSecretValueError(name) });
      }
      secretStore.set(name, existing.value, domains);
    }
    await secretProxy.reload();
    return res.json({ ok: true });
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'Failed to update scope' });
  }
}

function handleRedactExport(
  res: Response,
  texts: unknown,
  secretProxy: SecretProxyManager
): Response {
  if (!isStringArray(texts)) {
    return res.status(400).json({ error: 'bad-request' });
  }
  try {
    const result = secretProxy.rawPipeline.redactForExport(texts);
    return res.json(result);
  } catch (err) {
    console.error('[secrets] redact-export failed', err instanceof Error ? err.message : err);
    return res.status(503).json({ error: 'redaction-unavailable' });
  }
}

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

  app.post('/api/secrets', express.json(), async (req, res) => {
    const { name, value, domains } = req.body ?? {};
    if (typeof name !== 'string' || typeof value !== 'string' || !isStringArray(domains)) {
      return res.status(400).json({ error: 'bad-request' });
    }

    if (!isSingleLineSecretValue(value)) {
      return res.status(400).json({ error: multilineSecretValueError(name) });
    }
    try {
      secretStore.set(name, value, domains);
      await secretProxy.reload();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to set secret' });
    }
  });

  app.delete('/api/secrets/:name', (req, res) =>
    handleDeleteSecret(req.params.name, res, secretStore, secretProxy)
  );

  app.post('/api/secrets/scope', express.json(), (req, res) => {
    const { name, domains } = req.body ?? {};
    return handleScopeEdit(res, name, domains, secretStore, secretProxy);
  });

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

  app.post('/api/s3-sign-and-forward', async (req, res) => {
    try {
      await handleS3SignAndForward(req, res, secretStore);
    } catch (err) {
      respondSignAndForwardError(res, err, devMode, 'S3');
    }
  });

  app.post('/api/da-sign-and-forward', async (req, res) => {
    try {
      await handleDaSignAndForward(req, res);
    } catch (err) {
      respondSignAndForwardError(res, err, devMode, 'DA');
    }
  });

  app.post('/api/secrets/redact-export', express.json({ limit: '32mb' }), (req, res) =>
    handleRedactExport(res, req.body?.texts, secretProxy)
  );

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

  app.get('/api/secrets/masked', (_req, res) => {
    try {
      res.json(secretProxy.getMaskedEntries());
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Failed to get masked secrets' });
    }
  });

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
