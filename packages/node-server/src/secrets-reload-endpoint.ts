import type { Express } from 'express';
import { requireLoopback } from './cloud-status.js';

export interface SecretsReloadDeps {
  secretProxy: { reload(): Promise<void> };
}

export function registerSecretsReloadEndpoint(app: Express, deps: SecretsReloadDeps): void {
  app.post('/api/secrets/reload', requireLoopback, async (_req, res) => {
    await deps.secretProxy.reload();
    res.json({ ok: true });
  });
}
