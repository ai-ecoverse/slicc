import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewSecret } from '@slicc/shared-ts';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleDeleteSecret,
  registerSecretRoutes,
  type SecretRoutesDeps,
} from '../../src/routes/secrets.js';
import { EnvSecretStore } from '../../src/secrets/env-secret-store.js';
import { OauthSecretStore } from '../../src/secrets/oauth-secret-store.js';
import { SecretProxyManager } from '../../src/secrets/proxy-manager.js';

let tmpDir: string;

function createTempSecretsFile(content: string): string {
  tmpDir = join(tmpdir(), `slicc-secrets-route-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  const file = join(tmpDir, 'secrets.env');
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

interface Harness {
  base: string;
  secretProxy: SecretProxyManager;
  secretStore: EnvSecretStore;
  oauthStore: OauthSecretStore;
  close(): Promise<void>;
}

async function start(overrides: Partial<SecretRoutesDeps> = {}): Promise<Harness> {
  const file = createTempSecretsFile(
    ['GITHUB_TOKEN=ghp_realtoken123456789abcdef', 'GITHUB_TOKEN_DOMAINS=api.github.com'].join('\n')
  );
  const secretStore = new EnvSecretStore(file);
  const oauthStore = new OauthSecretStore();
  const secretProxy = new SecretProxyManager(secretStore, 'test-session', oauthStore);
  await secretProxy.reload();

  const app = express();
  registerSecretRoutes(app, {
    secretStore,
    secretProxy,
    oauthStore,
    devMode: false,
    ...overrides,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        base: `http://localhost:${port}`,
        secretProxy,
        secretStore,
        oauthStore,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('registerSecretRoutes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await start();
  });
  afterEach(async () => {
    await h.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists persisted secret names (without values)', async () => {
    const res = await fetch(`${h.base}/api/secrets`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ name: string }>;
    expect(list.some((e) => e.name === 'GITHUB_TOKEN')).toBe(true);
  });

  it('rejects a malformed persisted-set, accepts a well-formed one', async () => {
    const bad = await fetch(`${h.base}/api/secrets`, json({ name: 'X', value: 1, domains: [] }));
    expect(bad.status).toBe(400);
    const ok = await fetch(
      `${h.base}/api/secrets`,
      json({ name: 'STRIPE', value: 'sk_live_x', domains: ['api.stripe.com'] })
    );
    expect(ok.status).toBe(200);
    expect(h.secretProxy.getMaskedEntries().some((e) => e.name === 'STRIPE')).toBe(true);
  });

  it('rejects a multiline persisted-set without touching the existing value', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----';
    const res = await fetch(
      `${h.base}/api/secrets`,
      json({ name: 'GITHUB_TOKEN', value: pem, domains: ['api.github.com'] })
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'Secret "GITHUB_TOKEN" value cannot contain newlines; the secret store is line-oriented and would truncate it to the first line'
    );

    const peek = await fetch(`${h.base}/api/secrets/peek?name=GITHUB_TOKEN`);
    expect(peek.status).toBe(200);
    expect(((await peek.json()) as { preview: string }).preview).toBe(
      previewSecret('ghp_realtoken123456789abcdef')
    );
  });

  it('updates the scope of a persisted secret and 404s an unknown one', async () => {
    const ok = await fetch(
      `${h.base}/api/secrets/scope`,
      json({ name: 'GITHUB_TOKEN', domains: ['api.github.com', 'codeload.github.com'] })
    );
    expect(ok.status).toBe(200);
    const missing = await fetch(
      `${h.base}/api/secrets/scope`,
      json({ name: 'NOPE', domains: ['x.com'] })
    );
    expect(missing.status).toBe(404);
  });

  it('validates scope edits and updates a session secret scope', async () => {
    expect(
      (await fetch(`${h.base}/api/secrets/scope`, json({ name: 42, domains: [] }))).status
    ).toBe(400);
    await fetch(
      `${h.base}/api/secrets/session`,
      json({ name: 'SESSION_SCOPE', value: 'temporary-value', domains: ['old.example'] })
    );
    const updated = await fetch(
      `${h.base}/api/secrets/scope`,
      json({ name: 'SESSION_SCOPE', domains: ['new.example'] })
    );
    expect(updated.status).toBe(200);
    expect(h.secretProxy.sessionStore.getRecord('SESSION_SCOPE')?.domains).toEqual(['new.example']);
  });

  it('creates and lists session secrets', async () => {
    const set = await fetch(
      `${h.base}/api/secrets/session`,
      json({ name: 'SESSION_KEY', value: 'tmp-value', domains: ['example.com'] })
    );
    expect(set.status).toBe(200);
    const list = await fetch(`${h.base}/api/secrets/session`);
    const entries = (await list.json()) as Array<{ name: string }>;
    expect(entries.some((e) => e.name === 'SESSION_KEY')).toBe(true);
  });

  it('peeks and deletes session secrets before persisted secrets', async () => {
    await fetch(
      `${h.base}/api/secrets/session`,
      json({ name: 'TEMP', value: 'temporary-value', domains: ['example.com'] })
    );
    const peek = await fetch(`${h.base}/api/secrets/peek?name=TEMP`);
    expect(peek.status).toBe(200);
    expect(await peek.json()).toMatchObject({ name: 'TEMP', domains: ['example.com'] });

    const sessionDelete = await fetch(`${h.base}/api/secrets/TEMP`, { method: 'DELETE' });
    expect(await sessionDelete.json()).toEqual({ ok: true, name: 'TEMP', fromSession: true });
    const persistedDelete = await fetch(`${h.base}/api/secrets/GITHUB_TOKEN`, {
      method: 'DELETE',
    });
    expect(await persistedDelete.json()).toEqual({
      ok: true,
      name: 'GITHUB_TOKEN',
      fromSession: false,
    });
    expect((await fetch(`${h.base}/api/secrets/GITHUB_TOKEN`, { method: 'DELETE' })).status).toBe(
      404
    );
  });

  it('rejects an empty delete name at the handler boundary', async () => {
    let status = 200;
    let body: unknown;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    };
    await handleDeleteSecret(undefined, res as never, h.secretStore, h.secretProxy);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'bad-request' });
  });

  it('peeks a persisted secret, 400s a missing name, 404s an unknown one', async () => {
    const peek = await fetch(`${h.base}/api/secrets/peek?name=GITHUB_TOKEN`);
    expect(peek.status).toBe(200);
    const body = (await peek.json()) as { name: string; preview: string };
    expect(body.name).toBe('GITHUB_TOKEN');
    expect(body.preview).not.toContain('realtoken');

    expect((await fetch(`${h.base}/api/secrets/peek`)).status).toBe(400);
    expect((await fetch(`${h.base}/api/secrets/peek?name=NOPE`)).status).toBe(404);
  });

  it('scrubs real values from text and rejects non-string input', async () => {
    const res = await fetch(
      `${h.base}/api/secrets/scrub`,
      json({ text: 'token=ghp_realtoken123456789abcdef end' })
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { text: string };
    expect(out.text).not.toContain('ghp_realtoken123456789abcdef');

    const bad = await fetch(`${h.base}/api/secrets/scrub`, json({ text: 42 }));
    expect(bad.status).toBe(400);
  });

  it('returns masked entries for shell env population', async () => {
    const res = await fetch(`${h.base}/api/secrets/masked`);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as Array<{ name: string; maskedValue: string }>;
    const gh = entries.find((e) => e.name === 'GITHUB_TOKEN');
    expect(gh?.maskedValue).toBeDefined();
    expect(gh?.maskedValue).not.toBe('ghp_realtoken123456789abcdef');
  });

  it('maps store and pipeline failures to stable 500 responses', async () => {
    h.secretStore.list = (() => {
      throw new Error('list failed');
    }) as EnvSecretStore['list'];
    expect((await fetch(`${h.base}/api/secrets`)).status).toBe(500);

    h.secretStore.set = (() => {
      throw new Error('set failed');
    }) as EnvSecretStore['set'];
    expect(
      (await fetch(`${h.base}/api/secrets`, json({ name: 'FAIL', value: 'value', domains: [] })))
        .status
    ).toBe(500);

    h.secretProxy.scrubResponse = (() => {
      throw new Error('scrub failed');
    }) as SecretProxyManager['scrubResponse'];
    expect((await fetch(`${h.base}/api/secrets/scrub`, json({ text: 'x' }))).status).toBe(500);

    h.secretProxy.getMaskedEntries = (() => {
      throw new Error('masked failed');
    }) as SecretProxyManager['getMaskedEntries'];
    expect((await fetch(`${h.base}/api/secrets/masked`)).status).toBe(500);
  });

  it('maps scope and delete mutation failures to 500', async () => {
    await fetch(
      `${h.base}/api/secrets/session`,
      json({ name: 'FAIL_SCOPE', value: 'temporary-value', domains: [] })
    );
    h.secretProxy.sessionStore.setDomains = (() => {
      throw new Error('scope failed');
    }) as typeof h.secretProxy.sessionStore.setDomains;
    expect(
      (
        await fetch(
          `${h.base}/api/secrets/scope`,
          json({ name: 'FAIL_SCOPE', domains: ['x.example'] })
        )
      ).status
    ).toBe(500);

    await fetch(
      `${h.base}/api/secrets/session`,
      json({ name: 'FAIL_DELETE', value: 'temporary-value', domains: [] })
    );
    h.secretProxy.reload = vi.fn(async () => {
      throw new Error('reload failed');
    });
    expect((await fetch(`${h.base}/api/secrets/FAIL_DELETE`, { method: 'DELETE' })).status).toBe(
      500
    );
  });

  it('stores and deletes an OAuth token, 404ing an unknown delete', async () => {
    const update = await fetch(
      `${h.base}/api/secrets/oauth-update`,
      json({ providerId: 'github', accessToken: 'gho_token', domains: ['api.github.com'] })
    );
    expect(update.status).toBe(200);
    const updated = (await update.json()) as { name: string; maskedValue?: string };
    expect(updated.name).toBe('oauth.github.token');

    const del = await fetch(`${h.base}/api/secrets/oauth/github`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    const missing = await fetch(`${h.base}/api/secrets/oauth/github`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });

  it('rejects a malformed oauth-update', async () => {
    const res = await fetch(
      `${h.base}/api/secrets/oauth-update`,
      json({ providerId: 'github', accessToken: 'gho', domains: [] })
    );
    expect(res.status).toBe(400);
  });

  describe('POST /api/secrets/redact-export', () => {
    it('returns redacted texts and count for a known secret', async () => {
      const res = await fetch(
        `${h.base}/api/secrets/redact-export`,
        json({ texts: ['token=ghp_realtoken123456789abcdef end', 'ghp_realtoken123456789abcdef'] })
      );
      expect(res.status).toBe(200);
      const out = (await res.json()) as { texts: string[]; redactionCount: number };
      expect(out.texts).toHaveLength(2);
      expect(out.texts[0]).not.toContain('ghp_realtoken123456789abcdef');
      expect(out.texts[1]).not.toContain('ghp_realtoken123456789abcdef');
      expect(out.texts[0]).toContain('⟦REDACTED:known-secret:');
      expect(out.redactionCount).toBeGreaterThanOrEqual(2);
    });

    it('returns 400 for missing texts field', async () => {
      const res = await fetch(`${h.base}/api/secrets/redact-export`, json({}));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('bad-request');
    });

    it('returns 400 when texts is not an array', async () => {
      const res = await fetch(
        `${h.base}/api/secrets/redact-export`,
        json({ texts: 'not-an-array' })
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when texts contains non-string elements', async () => {
      const res = await fetch(`${h.base}/api/secrets/redact-export`, json({ texts: ['ok', 42] }));
      expect(res.status).toBe(400);
    });

    it('redacts known secret without echoing real value in response (success path)', async () => {
      const sensitiveText = 'ghp_realtoken123456789abcdef';
      const res = await fetch(
        `${h.base}/api/secrets/redact-export`,
        json({ texts: [sensitiveText] })
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(sensitiveText);
    });

    it('returns 503 with exact error and no input echo when pipeline throws (fail-closed)', async () => {
      const sensitiveText = 'ghp_realtoken123456789abcdef_forced_failure_unique';
      const pipeline = h.secretProxy.rawPipeline;
      const origRedact = pipeline.redactForExport.bind(pipeline);

      (pipeline as unknown as Record<string, unknown>)['redactForExport'] = () => {
        throw new Error('simulated pipeline failure');
      };
      try {
        const res = await fetch(
          `${h.base}/api/secrets/redact-export`,
          json({ texts: [sensitiveText] })
        );
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: string; texts?: string[] };
        expect(body.error).toBe('redaction-unavailable');

        expect(body.texts).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain(sensitiveText);
      } finally {
        (pipeline as unknown as Record<string, unknown>)['redactForExport'] = origRedact;
      }
    });

    it('returns empty texts with count 0 for an empty array', async () => {
      const res = await fetch(`${h.base}/api/secrets/redact-export`, json({ texts: [] }));
      expect(res.status).toBe(200);
      const out = (await res.json()) as { texts: string[]; redactionCount: number };
      expect(out).toEqual({ texts: [], redactionCount: 0 });
    });

    it('redacts a short session secret (below MIN_MASKABLE_SECRET_LENGTH) by real value only', async () => {
      const shortVal = 'abc';
      const set = await fetch(
        `${h.base}/api/secrets/session`,
        json({ name: 'SHORT_SES', value: shortVal, domains: [] })
      );
      expect(set.status).toBe(200);

      const res = await fetch(
        `${h.base}/api/secrets/redact-export`,
        json({ texts: [`prefix ${shortVal} suffix`] })
      );
      expect(res.status).toBe(200);
      const out = (await res.json()) as { texts: string[]; redactionCount: number };

      expect(out.texts[0]).not.toContain(shortVal);
      expect(out.texts[0]).toContain('⟦REDACTED:known-secret:');
      expect(out.redactionCount).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('sign-and-forward route failures', () => {
  it('returns traceable generic 500s without leaking handler errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = await start({
      devMode: true,
      handleS3: async () => {
        throw new Error('sensitive S3 details');
      },
      handleDa: async () => {
        throw new Error('sensitive DA details');
      },
    });
    try {
      for (const route of ['s3-sign-and-forward', 'da-sign-and-forward']) {
        const response = await fetch(`${h.base}/api/${route}`, json({}));
        expect(response.status).toBe(500);
        const text = await response.text();
        expect(text).toContain('internal sign-and-forward error');
        expect(text).not.toContain('sensitive');
      }
      expect(error).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      await h.close();
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      error.mockRestore();
    }
  });
});

describe('POST /api/secrets/scope with a multiline persisted value', () => {
  let scopeDir: string;

  afterEach(() => {
    if (scopeDir) rmSync(scopeDir, { recursive: true, force: true });
  });

  it('refuses to re-save it and leaves the record alone', async () => {
    scopeDir = join(tmpdir(), `slicc-secrets-scope-${randomUUID()}`);
    mkdirSync(scopeDir, { recursive: true });
    const file = join(scopeDir, 'secrets.env');
    writeFileSync(file, '', { mode: 0o600 });

    const secretStore = new EnvSecretStore(file);
    const multiline = '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----';
    let saved = false;
    secretStore.get = ((name: string) =>
      name === 'PEM'
        ? { name, value: multiline, domains: ['old.example'] }
        : null) as EnvSecretStore['get'];
    secretStore.set = (() => {
      saved = true;
    }) as EnvSecretStore['set'];

    const oauthStore = new OauthSecretStore();
    const secretProxy = new SecretProxyManager(secretStore, 'scope-multiline', oauthStore);
    await secretProxy.reload();
    const app = express();
    registerSecretRoutes(app, { secretStore, secretProxy, oauthStore, devMode: false });

    const server = app.listen(0);
    await new Promise<void>((r) => server.on('listening', () => r()));
    const addr = server.address();
    const base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
    try {
      const res = await fetch(
        `${base}/api/secrets/scope`,
        json({ name: 'PEM', domains: ['new.example'] })
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        'Secret "PEM" value cannot contain newlines; the secret store is line-oriented and would truncate it to the first line'
      );
      expect(saved).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
