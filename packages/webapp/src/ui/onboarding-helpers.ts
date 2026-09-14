import type { LocalStorageSetMsg } from '../kernel/messages.js';
import type { ProviderConfig } from '../providers/index.js';

export function flushCredentialsToWorker(client: {
  sendRaw: (m: LocalStorageSetMsg) => void;
}): void {
  for (const key of ['slicc_accounts', 'selected-model'] as const) {
    const value = localStorage.getItem(key);
    if (value != null) client.sendRaw({ type: 'local-storage-set', key, value });
  }
}

export function resolveDefaultModel(
  providerId: string,
  cfg: ProviderConfig,
  getModels: (id: string) => Array<{ id: string }>,
  isHidden: (modelId: string) => boolean
): string | undefined {
  const visible = getModels(providerId).filter((m) => !isHidden(m.id));
  const exact = cfg.defaultModelId ? visible.find((m) => m.id === cfg.defaultModelId) : undefined;
  const fuzzy = cfg.defaultModelId
    ? visible.find((m) => m.id.toLowerCase().includes(cfg.defaultModelId!.toLowerCase()))
    : undefined;
  const model = exact ?? fuzzy ?? visible[0];
  return model ? `${providerId}:${model.id}` : undefined;
}
