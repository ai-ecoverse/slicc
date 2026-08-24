/**
 * Which model a unit runs on, and with whose credential.
 *
 * Owns: resolving the record's pinned model (or falling back to the global
 * selection), enforcing the pinned-provider contract (#2195), picking the API
 * key for the provider the model actually runs on, and the context-fill
 * estimate the UI shows.
 *
 * Changes when provider/catalogue plumbing changes — a new pin dimension, a
 * new credential lookup. All of it is a question about the RECORD, answerable
 * without a running agent, which is why it is a set of plain functions.
 */

import type { Api } from '@earendil-works/pi-ai';
import type { AgentMessage, Model } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import {
  getApiKey,
  getApiKeyForProvider,
  getSelectedProvider,
  modelRunsOnProvider,
  resolveCurrentModel,
  resolveModelById,
} from '../../providers/account-store.js';
import { modelIdFor, modelProviderFor } from '../../work-unit/record.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import type { RegisteredScoop } from '../types.js';

const log = createLogger('scoop-context');

/** Fallback context window when the catalogue does not report one. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * API key for the provider this scoop's model actually runs on.
 *
 * `getApiKey()` returns the SELECTED provider's credential, which for a
 * pinned cross-provider scoop is the wrong one — it would send (and expose)
 * e.g. the Adobe token on the OpenRouter route and fail auth (#2195).
 */
export function getModelApiKey(scoop: RegisteredScoop): string | null {
  const pinned = modelProviderFor(scoop);
  return pinned ? getApiKeyForProvider(pinned) : getApiKey();
}

/** The model this unit runs on: its own pin, else the global selection. */
export function resolveScoopModel(scoop: RegisteredScoop): Model<Api> {
  const pinnedId = modelIdFor(scoop);
  return pinnedId ? resolveModelById(pinnedId, modelProviderFor(scoop)) : resolveCurrentModel();
}

/**
 * Resolve the model an init should build the agent with, enforcing the pinned
 * provider contract (#2195): the scoop was spawned with a model the caller
 * chose from a SPECIFIC provider's catalogue, and running it anywhere else is
 * a cost overrun (a cheap cross-provider model silently billing as the
 * selected provider's Opus). `resolveModelById` throws for an id the pinned
 * provider can't serve; a surviving id/provider mismatch throws here the same
 * way.
 */
export function resolveModelForInit(scoop: RegisteredScoop, unit: WorkUnitDescriptor): Model<Api> {
  const configuredModelId = modelIdFor(scoop);
  const configuredProviderId = modelProviderFor(scoop);
  const model = resolveScoopModel(scoop);

  const label = unit.display.role === 'primary' ? 'Cone' : `Scoop "${scoop.name}"`;
  console.log(`[model] ${label} using model: ${model.id} (provider: ${model.provider})`);

  if (
    configuredProviderId &&
    (model.id !== configuredModelId || !modelRunsOnProvider(model, configuredProviderId))
  ) {
    throw new Error(
      `Configured model ${configuredProviderId}:${configuredModelId} resolved to ` +
        `${model.provider}:${model.id}; refusing to run on a different model`
    );
  }
  // Without a pinned provider (a scoop persisted before #2195, or a
  // config written by hand) `resolveModelById` still degrades to the
  // *selected* model for an id the selected provider doesn't offer. Leave
  // a breadcrumb rather than only the info line above.
  if (!configuredProviderId && configuredModelId && model.id !== configuredModelId) {
    log.warn('Configured scoop model did not resolve; using resolved model instead', {
      folder: scoop.folder,
      configuredModelId,
      resolvedModelId: model.id,
    });
  }
  return model;
}

/**
 * 0..1 estimate of how full the model's context window is, from the LAST
 * assistant turn's reported usage — `input + cacheRead` is the prompt the
 * model actually saw (output is what it added). 0 before the first turn.
 */
export function estimateContextFill(
  messages: readonly AgentMessage[],
  scoop: RegisteredScoop
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as {
      role?: string;
      usage?: { input: number; output: number; cacheRead: number };
    };
    if (msg.role !== 'assistant' || !msg.usage) continue;
    const used = msg.usage.input + msg.usage.cacheRead + msg.usage.output;
    let window = DEFAULT_CONTEXT_WINDOW;
    try {
      const model = resolveScoopModel(scoop);
      if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
        window = model.contextWindow;
      }
    } catch {
      // Model resolution is best-effort here; the default window stands.
    }
    return Math.min(1, used / window);
  }
  return 0;
}

/**
 * The message a unit shows when init produced no agent: name the provider the
 * credential is missing for when we can work it out, otherwise stay generic.
 */
export function missingApiKeyMessage(scoop: RegisteredScoop): string {
  let provider = modelProviderFor(scoop) ?? '';
  try {
    if (!provider) provider = getSelectedProvider();
  } catch {
    /* test env may have no localStorage — fall back to a generic message */
  }
  return provider
    ? `No API key configured for provider "${provider}". Open Settings to add one.`
    : 'No API key configured. Open Settings to add one.';
}
