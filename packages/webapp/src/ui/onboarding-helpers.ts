import type { LocalStorageSetMsg } from '../../../chrome-extension/src/messages.js';
import type { ProviderConfig } from '../providers/index.js';

/**
 * Flush the two localStorage keys the kernel worker reads at lick time
 * (`slicc_accounts` and `selected-model`) directly over the transport.
 *
 * These are the only keys getSelectedProvider() / prompt() reads on the
 * worker side when the onboarding-complete-with-provider lick arrives,
 * so flushing just these two is sufficient.
 *
 * Why this is needed: the OAuth flow opens a popup window. That popup has
 * its own window.localStorage that installPageStorageSync never patched
 * (the patch only covers the opener's window). The saveAccounts() write
 * therefore never reaches the worker's shim via the normal sync path.
 * Explicitly flushing here, on the same OffscreenClient channel as the
 * lick, guarantees ordering — the postMessage queue preserves FIFO.
 */
export function flushCredentialsToWorker(client: {
  sendRaw: (m: LocalStorageSetMsg) => void;
}): void {
  for (const key of ['slicc_accounts', 'selected-model'] as const) {
    const value = localStorage.getItem(key);
    if (value != null) client.sendRaw({ type: 'local-storage-set', key, value });
  }
}

/**
 * Pick the best model id to activate after OAuth completes.
 *
 * Resolution order:
 *   1. Exact match on cfg.defaultModelId
 *   2. Substring match on cfg.defaultModelId (handles partial prefixes like "sonnet")
 *   3. First visible model in the catalogue
 *
 * Returns `undefined` when the catalogue has no visible models for the provider.
 */
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
