/**
 * Loopback-only endpoint that hands the hosted-leader page any pre-acquired
 * provider credentials that were uploaded with secrets.env or cone-config.json.
 *
 * The webapp's hosted-leader boot reads {model, accounts} to configure
 * providers and model selection before any LLM call goes out.
 *
 * Back-compat: synthesizes an Adobe oauth account from ADOBE_IMS_TOKEN when
 * cone-config.json is absent. Returns adobeImsToken field for older webapp
 * builds that still expect it.
 *
 * Same loopback discipline as /api/cloud-status and /api/leader-restart:
 * chromium-on-localhost is the only thing that can hit it; the laptop-side
 * orchestrator talks to the leader through the tray-worker tunnel, not http.
 */
import { readFileSync } from 'node:fs';
// Import from the package root (not the './cone-config' subpath): node-server's
// inline-workspaces packaging only rewrites the bare '@slicc/cloud-core'
// specifier, so a subpath import leaks an un-inlined workspace reference.
import { type Account, imsTokenExpiry } from '@slicc/cloud-core';
import type { Express } from 'express';
import { requireLoopback } from './cloud-status.js';
import type { SecretStore } from './secrets/types.js';

// Re-export so existing callers/tests can keep importing it from here. The
// implementation now lives in @slicc/cloud-core/cone-config (side-effect-free,
// Buffer-free) so the worker's back-compat + resume paths reuse the same logic.
export { imsTokenExpiry };

const CONE_CONFIG_PATH = '/slicc/cone-config.json';
const DEFAULT_MODEL = 'adobe:claude-opus-4-6';

export interface HostedBootstrapPayload {
  model?: string;
  effortLevel?: string;
  accounts?: Account[];
  /** Back-compat: retained so older webapp builds still read the IMS token. */
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
      model: DEFAULT_MODEL,
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
          // A missing file is the normal pre-feature/back-compat case. Any other
          // error (EACCES, EIO, …) means the config exists but is unreadable —
          // log it so a silent fallback to legacy/empty doesn't hide the cause.
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
