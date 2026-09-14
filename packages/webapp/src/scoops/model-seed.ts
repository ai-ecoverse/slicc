import {
  getApiKeyForProvider,
  getSelectedProvider,
  resolveCurrentModel,
} from '../providers/account-store.js';
import type { WorkUnitModel } from './types.js';

export function globalSeedModel(): WorkUnitModel | undefined {
  try {
    const provider = getSelectedProvider();
    if (!provider || !getApiKeyForProvider(provider)) return undefined;
    const id = resolveCurrentModel().id;
    return id ? { provider, id } : undefined;
  } catch {
    return undefined;
  }
}
