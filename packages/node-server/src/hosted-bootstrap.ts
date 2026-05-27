/**
 * Loopback-only endpoint that hands the hosted-leader page any pre-acquired
 * provider credentials that were uploaded with secrets.env.
 *
 * Currently exposes ADOBE_IMS_TOKEN so the laptop can paste in an IMS bearer
 * once (avoiding OAuth, which can't complete in headless chromium). The
 * webapp's hosted-leader boot calls saveOAuthAccount with the returned token
 * before any LLM call goes out.
 *
 * Same loopback discipline as /api/cloud-status and /api/leader-restart:
 * chromium-on-localhost is the only thing that can hit it; the laptop-side
 * orchestrator talks to the leader through the tray-worker tunnel, not http.
 */
import type { Express } from 'express';
import { requireLoopback } from './cloud-status.js';
import type { SecretStore } from './secrets/types.js';

export interface HostedBootstrapPayload {
  adobeImsToken?: string;
}

export function registerHostedBootstrapEndpoint(
  app: Express,
  options: { secretStore: SecretStore }
): void {
  app.get('/api/hosted-bootstrap', requireLoopback, (_req, res) => {
    const payload: HostedBootstrapPayload = {};

    // EnvSecretStore.get(name) requires both the value AND a <name>_DOMAINS
    // entry. The user's secrets.env must contain BOTH:
    //   ADOBE_IMS_TOKEN=<bearer>
    //   ADOBE_IMS_TOKEN_DOMAINS=adobe-llm-proxy.paolo-moz.workers.dev
    const token = options.secretStore.get('ADOBE_IMS_TOKEN');
    if (token?.value) payload.adobeImsToken = token.value;

    res.json(payload);
  });
}
