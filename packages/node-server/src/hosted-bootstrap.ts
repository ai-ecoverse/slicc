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
import type { Account } from '@slicc/cloud-core';
import type { Express } from 'express';
import { requireLoopback } from './cloud-status.js';
import type { SecretStore } from './secrets/types.js';

const CONE_CONFIG_PATH = '/slicc/cone-config.json';
const DEFAULT_MODEL = 'adobe:claude-opus-4-6';

export interface HostedBootstrapPayload {
  model?: string;
  accounts?: Account[];
  /** Back-compat: retained so older webapp builds still read the IMS token. */
  adobeImsToken?: string;
}

export interface BootstrapSources {
  readConeConfig: () => string | null;
  getLegacyAdobeToken: () => string | undefined;
}

/**
 * Best-effort expiry (epoch ms) of an Adobe IMS access token.
 *
 * Stamped onto the synthesized legacy-token account so the window-less kernel
 * worker doesn't treat a still-valid token as expired: `getValidAccessToken`
 * (providers/adobe.ts) returns the token only when `tokenExpiresAt` is in the
 * future, otherwise it attempts a silent renewal that ALWAYS returns null in a
 * worker (no `window`) and then throws "Adobe session expired". Without an
 * expiry the account defaults to `tokenExpiresAt ?? 0`, so the very first turn
 * of a CLI-launched cone (no cone-config.json ⇒ this legacy branch) fails.
 *
 * IMS access tokens are JWTs whose payload carries `created_at` + `expires_in`
 * (both epoch ms). Returns undefined for opaque/unparseable tokens — callers
 * then leave `tokenExpiresAt` unset (matching prior behavior).
 */
export function imsTokenExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as {
      created_at?: unknown;
      expires_in?: unknown;
    };
    const created = Number(payload.created_at);
    const ttl = Number(payload.expires_in);
    if (Number.isFinite(created) && created > 0 && Number.isFinite(ttl) && ttl > 0) {
      return created + ttl;
    }
  } catch {
    // opaque / malformed token — leave expiry unset
  }
  return undefined;
}

export function buildHostedBootstrapPayload(sources: BootstrapSources): HostedBootstrapPayload {
  const raw = sources.readConeConfig();
  if (raw) {
    const parsed = JSON.parse(raw) as { model?: string; accounts?: Account[] };
    return { model: parsed.model, accounts: parsed.accounts ?? [] };
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
