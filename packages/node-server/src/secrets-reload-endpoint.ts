import type { Express } from 'express';
import { requireLoopback } from './cloud-status.js';
import type { EnvSecretStore } from './secrets/env-secret-store.js';
import type { OauthSecretStore } from './secrets/oauth-secret-store.js';

export interface SecretsReloadDeps {
  secretProxy: { reload(): Promise<void> };
  secretStore: EnvSecretStore;
  oauthStore: OauthSecretStore;
}

export function registerSecretsReloadEndpoint(app: Express, deps: SecretsReloadDeps): void {
  app.post('/api/secrets/reload', requireLoopback, async (_req, res) => {
    // Clear OAuth store entries whose names also exist in the freshly-read env
    // file. On resume, cloud-core writes the authoritative token into the env
    // file — a stale in-memory OAuth entry for the same name must not shadow it.
    const envNames = new Set(deps.secretStore.list().map((e) => e.name));
    for (const entry of deps.oauthStore.list()) {
      if (envNames.has(entry.name)) {
        deps.oauthStore.delete(entry.name);
      }
    }

    await deps.secretProxy.reload();
    res.json({ ok: true });
  });
}
