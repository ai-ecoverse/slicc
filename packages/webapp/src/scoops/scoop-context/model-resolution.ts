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

const DEFAULT_CONTEXT_WINDOW = 200_000;

export function getModelApiKey(scoop: RegisteredScoop): string | null {
  const pinned = modelProviderFor(scoop);
  return pinned ? getApiKeyForProvider(pinned) : getApiKey();
}

export function resolveScoopModel(scoop: RegisteredScoop): Model<Api> {
  const pinnedId = modelIdFor(scoop);
  return pinnedId ? resolveModelById(pinnedId, modelProviderFor(scoop)) : resolveCurrentModel();
}

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

  if (!configuredProviderId && configuredModelId && model.id !== configuredModelId) {
    log.warn('Configured scoop model did not resolve; using resolved model instead', {
      folder: scoop.folder,
      configuredModelId,
      resolvedModelId: model.id,
    });
  }
  return model;
}

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
    } catch {}
    return Math.min(1, used / window);
  }
  return 0;
}

export function missingApiKeyMessage(scoop: RegisteredScoop): string {
  let provider = modelProviderFor(scoop) ?? '';
  try {
    if (!provider) provider = getSelectedProvider();
  } catch {}
  return provider
    ? `No API key configured for provider "${provider}". Open Settings to add one.`
    : 'No API key configured. Open Settings to add one.';
}
