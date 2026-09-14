import { readFileSync } from 'node:fs';

import { type Account, DEFAULT_CONE_MODEL, imsTokenExpiry } from '@slicc/cloud-core';
import type { Express } from 'express';
import { requireLoopback } from './cloud-status.js';
import type { SecretStore } from './secrets/types.js';

export { imsTokenExpiry };

const CONE_CONFIG_PATH = '/slicc/cone-config.json';

export interface HostedBootstrapPayload {
  model?: string;
  effortLevel?: string;
  accounts?: Account[];

  adobeImsToken?: string;
}

export interface BootstrapSources {
  readConeConfig: () => string | null;
  getLegacyAdobeToken: () => string | undefined;
}

export function buildHostedBootstrapPayload(sources: BootstrapSources): HostedBootstrapPayload {
  const raw = sources.readConeConfig();
  if (raw) {
    const parsed = JSON.parse(raw) as {
      model?: string;
      effortLevel?: string;
      accounts?: Account[];
    };
    return {
      model: parsed.model,
      ...(parsed.effortLevel ? { effortLevel: parsed.effortLevel } : {}),
      accounts: parsed.accounts ?? [],
    };
  }
  const legacy = sources.getLegacyAdobeToken();
  if (legacy) {
    const expiresAt = imsTokenExpiry(legacy);
    return {
      model: DEFAULT_CONE_MODEL,
      accounts: [
        {
          providerId: 'adobe',
          kind: 'oauth',
          accessToken: legacy,
          ...(expiresAt !== undefined ? { tokenExpiresAt: expiresAt } : {}),
        },
      ],
      adobeImsToken: legacy,
    };
  }
  return {};
}

export function registerHostedBootstrapEndpoint(
  app: Express,
  options: { secretStore: SecretStore }
): void {
  app.get('/api/hosted-bootstrap', requireLoopback, (_req, res) => {
    const payload = buildHostedBootstrapPayload({
      readConeConfig: () => {
        try {
          return readFileSync(CONE_CONFIG_PATH, 'utf-8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('[hosted-bootstrap] failed to read cone-config.json:', err);
          }
          return null;
        }
      },
      getLegacyAdobeToken: () => options.secretStore.get('ADOBE_IMS_TOKEN')?.value,
    });
    res.json(payload);
  });
}
