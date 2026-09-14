import type { SecretDialogRequest, SliccSecretDialog } from '@slicc/webcomponents';

import { createLogger } from '../../base/logger.js';
import { providerLabel } from '../../base/provider-labels.js';
import type { SecretRequest, SecretRequestOutcome } from '../../base/secret-request-registry.js';
import { setSecretRequestSurface } from '../../base/secret-request-registry.js';
import { resolveSecretTopology } from '../../core/secret-topology.js';
import { getSelectedProvider } from '../../providers/account-store.js';
import type { SecretBackend } from '../../shell/supplemental-commands/secret-backends.js';
import { createDefaultSecretBackend } from '../../shell/supplemental-commands/secret-backends.js';
import { mountTrusted } from './trusted-layer.js';

const log = createLogger('wc-secret-request');

export interface SecretRequestSurfaceDeps {
  backend?: SecretBackend;

  mount?: (element: HTMLElement) => void;

  createDialog?: () => SliccSecretDialog;
}

function mountDialog(element: HTMLElement): boolean {
  try {
    mountTrusted(element, document);
    return true;
  } catch (err) {
    log.error(
      'no trusted layer in this float — refusing to collect a secret on spoofable chrome; ' +
        'use `secret set` or the settings UI instead (see trusted-layer.ts)',
      { error: err instanceof Error ? err.message : String(err) }
    );
    return false;
  }
}

function selectedProviderLabel(): string | undefined {
  try {
    return providerLabel(getSelectedProvider());
  } catch {
    return undefined;
  }
}

function toDialogRequest(request: SecretRequest): SecretDialogRequest {
  return {
    name: request.name,
    domains: request.domains,
    reason: request.reason,
    requester: request.requester,
    persist: request.persist,

    provider: request.provider ?? selectedProviderLabel(),
  };
}

export async function requestSecretFromUser(
  request: SecretRequest = {},
  deps: SecretRequestSurfaceDeps = {}
): Promise<SecretRequestOutcome> {
  const backend = deps.backend ?? createDefaultSecretBackend(resolveSecretTopology());
  const dialog =
    deps.createDialog?.() ?? (document.createElement('slicc-secret-dialog') as SliccSecretDialog);
  if (deps.mount) deps.mount(dialog);
  else if (!mountDialog(dialog)) return { stored: false, reason: 'unavailable' };

  const stored: { entry?: { name: string; domains: string[]; persisted: boolean } } = {};

  dialog.submitHandler = async (detail) => {
    try {
      if (detail.persist) await backend.setPersisted(detail.name, detail.value, detail.domains);
      else await backend.setSession(detail.name, detail.value, detail.domains);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    stored.entry = { name: detail.name, domains: detail.domains, persisted: detail.persist };
    return null;
  };

  try {
    const submitted = await dialog.open(toDialogRequest(request));
    const entry = stored.entry;
    if (!submitted || !entry) return { stored: false, reason: 'cancelled' };
    return {
      stored: true,
      name: entry.name,

      maskedValue: await readMask(backend, entry.name),
      domains: entry.domains,
      persisted: entry.persisted,
    };
  } finally {
    dialog.remove();
  }
}

async function readMask(backend: SecretBackend, name: string): Promise<string | null> {
  try {
    return (await backend.getMasked(name))?.maskedValue ?? null;
  } catch (err) {
    log.warn('secret stored, but the mask could not be read back', {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function installSecretRequestSurface(deps: SecretRequestSurfaceDeps = {}): () => void {
  setSecretRequestSurface((request) => requestSecretFromUser(request, deps));
  return () => setSecretRequestSurface(null);
}
