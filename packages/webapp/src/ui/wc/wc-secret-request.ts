/**
 * The secret-entry surface: the only place in SLICC where a human types a
 * credential.
 *
 * Two callers share it — the composer's "Share secret securely" action
 * (`wc-attach.ts`) and the agent's `request_secret` tool (page realm directly,
 * kernel worker via the `secret-request` panel-RPC op). Both get the same
 * chrome, and both get back the same value-free outcome.
 *
 * ## Why the write happens HERE
 *
 * The plaintext must not travel further than it has to. This module opens the
 * dialog, hands the typed value straight to the trusted-realm secret store
 * (node-server `/api/secrets*`, the extension SW, …) via the existing
 * `SecretBackend`, reads the masked stand-in back, and returns only that. The
 * caller — including a tool the model invoked — never sees the credential, so an
 * agent asking for a secret cannot learn it by asking.
 *
 * ## Why the trusted layer
 *
 * `trusted-layer.ts` exists because a main-realm panel can draw a convincing
 * fake "enter your API key" form. This dialog is exactly that form, so it mounts
 * through `mountTrusted` and paints above every panel.
 *
 * A float with no trusted layer FAILS CLOSED: it reports `unavailable` and never
 * shows the form. Mounting into `document.body` instead would ask for a
 * credential on a surface a panel can cover or impersonate, and a console warning
 * is addressed to an operator while the risk lands on whoever is typing. "No
 * prompt" is a recoverable state — `secret set` and the settings UI still work —
 * whereas a credential entered into spoofable chrome is not.
 */

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

/** Injectable seams (tests, floats with a non-default store). */
export interface SecretRequestSurfaceDeps {
  /** Store to write into. Defaults to the topology's production backend. */
  backend?: SecretBackend;
  /** Where the dialog mounts. Defaults to the trusted layer. */
  mount?: (element: HTMLElement) => void;
  /** Element factory (tests inject a stub dialog). */
  createDialog?: () => SliccSecretDialog;
}

/** Mount into the trusted layer, or refuse: `false` means nothing was mounted. */
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

/**
 * The page's selected provider — the FALLBACK label, used only when the caller
 * named none (the composer action, where the human is asking on their own
 * behalf). Best-effort: an unreadable selection leaves the component's generic
 * wording in place.
 */
function selectedProviderLabel(): string | undefined {
  try {
    return providerLabel(getSelectedProvider());
  } catch {
    return undefined;
  }
}

/** Translate the registry's request into the component's prefill shape. */
function toDialogRequest(request: SecretRequest): SecretDialogRequest {
  return {
    name: request.name,
    domains: request.domains,
    reason: request.reason,
    requester: request.requester,
    persist: request.persist,
    // The asking unit's own provider when it named one; the page's selection is
    // only the fallback, because a background scoop can run on a different one.
    provider: request.provider ?? selectedProviderLabel(),
  };
}

/**
 * Open the dialog, store what the human typed, and resolve with the stored
 * secret's NAME, MASK, and scope — never its value. A dismissal resolves
 * `{ stored: false, reason: 'cancelled' }`; the promise never rejects.
 *
 * A failed store keeps the dialog open with the value intact (the component's
 * `submitHandler` contract), so a stalled Keychain costs a click rather than a
 * re-paste from the password manager. A float with no trusted layer resolves
 * `{ stored: false, reason: 'unavailable' }` without ever showing the form.
 */
export async function requestSecretFromUser(
  request: SecretRequest = {},
  deps: SecretRequestSurfaceDeps = {}
): Promise<SecretRequestOutcome> {
  const backend = deps.backend ?? createDefaultSecretBackend(resolveSecretTopology());
  const dialog =
    deps.createDialog?.() ?? (document.createElement('slicc-secret-dialog') as SliccSecretDialog);
  if (deps.mount) deps.mount(dialog);
  else if (!mountDialog(dialog)) return { stored: false, reason: 'unavailable' };

  // Filled by the submit handler so the resolved outcome can describe what
  // actually landed (the human may have edited the name or the scope). Held in a
  // box rather than a bare `let` because the write happens inside the handler
  // closure, which control-flow narrowing does not see.
  const stored: { entry?: { name: string; domains: string[]; persisted: boolean } } = {};

  dialog.submitHandler = async (detail) => {
    try {
      if (detail.persist) await backend.setPersisted(detail.name, detail.value, detail.domains);
      else await backend.setSession(detail.name, detail.value, detail.domains);
    } catch (err) {
      // Returned, not thrown: the dialog shows it and stays open.
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
      // Best-effort: a store that accepted the write but cannot report a mask
      // still stored the secret, so this is not a failure — the caller says so.
      maskedValue: await readMask(backend, entry.name),
      domains: entry.domains,
      persisted: entry.persisted,
    };
  } finally {
    dialog.remove();
  }
}

/** The masked stand-in for `name`, or `null` when the store can't report one. */
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

/**
 * Publish this float's secret-entry surface so the tool layer (and the
 * `secret-request` panel-RPC handler) can reach it. Call from the LEADER boot
 * path only: a follower has no local secret store to write into, and leaving the
 * registry empty is what makes both entry points hide themselves instead of
 * dead-ending.
 */
export function installSecretRequestSurface(deps: SecretRequestSurfaceDeps = {}): () => void {
  setSecretRequestSurface((request) => requestSecretFromUser(request, deps));
  return () => setSecretRequestSurface(null);
}
