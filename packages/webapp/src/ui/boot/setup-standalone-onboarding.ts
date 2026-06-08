/**
 * `setup-standalone-onboarding.ts` — kernel-worker mirror of
 * `setup-extension-onboarding.ts`. Wires the on-page
 * OnboardingOrchestrator, welcome-lick interceptor, and inline-dip lick
 * forwarder. The `onShortcutMigrate` callback routes the welcome
 * sentinel write through `writableFs` so under `slicc_opfs_vfs=opfs` it
 * lands on the worker-owned canonical OPFS.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import { broadcastToDips } from '../dip.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { flushCredentialsToWorker } from '../onboarding-helpers.js';
import { persistWelcomeSentinel } from '../welcome-sentinel.js';
import {
  createOnboardingOrchestratorSetup,
  type OnboardingOrchestratorHandle,
} from './setup-onboarding-orchestrator.js';
import { applyPendingMount } from './setup-pending-mount.js';
import { createWelcomeLickInterceptor, dispatchWelcomeLickOnce } from './setup-welcome-flow.js';
import type { BootStageLogger } from './types.js';

export interface StandaloneOnboardingSetupDeps {
  client: OffscreenClient;
  layout: Layout;
  localFs: VirtualFS;
  writableFs: WritableVfsClient;
  useRpcVfs: boolean;
  isOpfsLeader: boolean;
  firedWelcomeActions: Set<string>;
  log: BootStageLogger;
}

export interface StandaloneOnboardingHandle {
  onboardingHandle: OnboardingOrchestratorHandle;
  interceptWelcomeLick(event: LickEvent): boolean;
}

export async function setupStandaloneOnboarding(
  deps: StandaloneOnboardingSetupDeps
): Promise<StandaloneOnboardingHandle> {
  const { client, layout, localFs, writableFs, useRpcVfs, isOpfsLeader, firedWelcomeActions, log } =
    deps;
  const providerSettings = await import('../provider-settings.js');
  const { getAccounts, getProviderConfig } = providerSettings;
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
        'orchestrator-worker',
        log
      );
    },
  });
  const getOrchestrator = () => onboardingHandle.get();

  const interceptWelcomeLick = createWelcomeLickInterceptor({
    firedWelcomeActions,
    getAccounts,
    getProviderConfig,
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
          'fast-forward-worker',
          log
        );
      },
      broadcastAlreadyConnected: (providerId) => {
        const cfg = (() => {
          try {
            return getProviderConfig(providerId);
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
      persistWelcomeSentinel({
        writableFs,
        isWriter: !useRpcVfs || isOpfsLeader,
      });
    },
    contextLabel: 'worker',
    vfs: localFs,
    log,
  });

  return { onboardingHandle, interceptWelcomeLick };
}
