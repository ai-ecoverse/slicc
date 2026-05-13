/**
 * "New session" orchestration — UI-side glue that resolves model/api-key
 * and invokes the freezer over the cone's current chat session.
 *
 * Both the extension and standalone (kernel-worker) paths wire their
 * `onClearChat` to call `runNewSessionFreeze`, so the freezer behavior
 * stays in one place.
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import type { VirtualFS } from '../fs/index.js';
import { createLogger } from '../core/logger.js';
import { getDailyAdobeUuid } from '../scoops/llm-session-id.js';
import { getApiKey, resolveCurrentModel } from './provider-settings.js';
import { SessionStore } from './session-store.js';
import { freezeConeSession, type FrozenSession } from './session-freezer.js';

const log = createLogger('new-session');

/**
 * Freezer-specific Adobe `X-Session-Id` anchor. Grouping freezer traffic
 * under its own anchor keeps it visible-but-distinct from ad-hoc UI label
 * calls in proxy monitoring, while still rotating daily and never leaking
 * scoop/folder identifiers.
 */
const FREEZER_SESSION_ANCHOR = 'ui-new-session';

export interface RunNewSessionFreezeOptions {
  vfs: VirtualFS;
}

/**
 * Resolve credentials + model + headers, then run the freezer. Returns the
 * frozen entry on success, `null` when nothing was archived (short session,
 * missing creds, or write failure). Never throws.
 */
export async function runNewSessionFreeze(
  opts: RunNewSessionFreezeOptions
): Promise<FrozenSession | null> {
  const apiKey = getApiKey() ?? undefined;
  let model: Model<Api> | undefined;
  try {
    model = resolveCurrentModel();
  } catch (err) {
    log.info('No active model — freezing without LLM enrichment', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const headers: Record<string, string> | undefined =
    model?.provider === 'adobe'
      ? { 'X-Session-Id': getDailyAdobeUuid(FREEZER_SESSION_ANCHOR) }
      : undefined;

  const sessionStore = new SessionStore();
  try {
    await sessionStore.init();
  } catch (err) {
    log.warn('SessionStore init failed — cannot freeze', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  return freezeConeSession({
    sessionStore,
    vfs: opts.vfs,
    model,
    apiKey,
    headers,
  });
}
