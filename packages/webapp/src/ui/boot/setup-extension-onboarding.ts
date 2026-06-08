/**
 * `setup-extension-onboarding.ts` — bundles the extension-side
 * OnboardingOrchestrator + welcome-lick interceptor + inline-dip lick
 * forwarder. Source-of-truth comments live in
 * `setup-onboarding-orchestrator.ts` and `setup-welcome-flow.ts`.
 *
 * Extracted from `mainExtension` so the orchestrator stays under cap.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import { broadcastToDips } from '../dip.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { flushCredentialsToWorker } from '../onboarding-helpers.js';
import {
  createOnboardingOrchestratorSetup,
  type OnboardingOrchestratorHandle,
} from './setup-onboarding-orchestrator.js';
import { applyPendingMount } from './setup-pending-mount.js';
import { createWelcomeLickInterceptor, dispatchWelcomeLickOnce } from './setup-welcome-flow.js';
import type { BootStageLogger } from './types.js';

export interface ExtensionOnboardingSetupDeps {
  client: OffscreenClient;
  layout: Layout;
  localFs: VirtualFS;
  firedWelcomeActions: Set<string>;
  log: BootStageLogger;
}

export interface ExtensionOnboardingHandle {
  onboardingHandle: OnboardingOrchestratorHandle;
  interceptWelcomeLick(event: LickEvent): boolean;
}

export async function setupExtensionOnboarding(
  deps: ExtensionOnboardingSetupDeps
): Promise<ExtensionOnboardingHandle> {
  const { client, layout, localFs, firedWelcomeActions, log } = deps;
  const providerSettings = await import('../provider-settings.js');
  const { getAccounts: getAccountsExt, getProviderConfig: getProviderConfigExt } = providerSettings;
  const { createSprinkleDeviceCodePrompter, resolveDeviceCodeDecision } = await import(
    '../../providers/device-code-bridge.js'
  );
  const onboardingHandle = await createOnboardingOrchestratorSetup({
    fs: localFs,
    log,
    providers: providerSettings,
    deviceCode: { createSprinkleDeviceCodePrompter },
    postSystemMessage: (line) => layout.panels.chat.addSystemMessage(line),
    postDipReference: (md) => layout.panels.chat.addSystemMessage(md),
    broadcastToDip: (payload) => broadcastToDips(payload),
    onFireFinalLick: (data) => {
      flushCredentialsToWorker(client);
      const action = String((data as { action?: unknown })?.action ?? '');
      dispatchWelcomeLickOnce(
        action,
        firedWelcomeActions,
        () => client.sendSprinkleLick('welcome', data),
        'orchestrator-ext',
        log
      );
    },
  });
  const getOrchestrator = () => onboardingHandle.get();

  const interceptWelcomeLick = createWelcomeLickInterceptor({
    firedWelcomeActions,
    getAccounts: getAccountsExt,
    getProviderConfig: getProviderConfigExt,
    resolveDeviceCodeDecision,
    getOnboardingOrchestrator: getOrchestrator,
    applyPendingMount: () => applyPendingMount(localFs, log),
    fastForward: {
      fire: (data) => {
        const action = String((data as { action?: unknown }).action ?? '');
        dispatchWelcomeLickOnce(
          action,
          firedWelcomeActions,
          () => client.sendSprinkleLick('welcome', data),
          'fast-forward-ext',
          log
        );
      },
      broadcastAlreadyConnected: (providerId) => {
        const cfg = (() => {
          try {
            return getProviderConfigExt(providerId);
          } catch {
            return null;
          }
        })();
        broadcastToDips({
          type: 'slicc-already-connected',
          provider: providerId,
          note: cfg?.name ? `Already connected to ${cfg.name}.` : 'Already connected.',
        });
      },
    },
    onShortcutMigrate: () => {
      void localFs
        .writeFile('/shared/.welcomed', '1')
        .catch((err) => log.warn('Failed to persist welcome completion marker', err));
    },
    contextLabel: 'ext',
    vfs: localFs,
    log,
  });

  // Inline-dip lick callback — the welcome dip is mounted as an inline
  // `<img>`-hydrated dip in chat history, so its licks reach us through
  // this path rather than the SprinkleManager. Run them through the
  // same welcome-flow interceptor before falling back to the cone-bound
  // `client.sendSprinkleLick`.
  layout.panels.chat.onDipLick = (action: string, data: unknown) => {
    const event: LickEvent = {
      type: 'sprinkle',
      sprinkleName: 'inline',
      targetScoop: undefined,
      timestamp: new Date().toISOString(),
      body: { action, data },
    };
    if (interceptWelcomeLick(event)) return;
    client.sendSprinkleLick('inline', { action, data });
  };

  return { onboardingHandle, interceptWelcomeLick };
}
