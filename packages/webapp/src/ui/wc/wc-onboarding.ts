/**
 * Deterministic onboarding for the WC shell — the welcome flow the legacy
 * Layout boots drove from `main.ts`. The engine modules survive
 * (`scoops/onboarding-orchestrator.ts`, `scoops/welcome-detection.ts`, the
 * revived `boot/setup-*` stages); this adapter binds them to the WC seams:
 *
 * - welcome lines + dips land as synthetic assistant messages on the
 *   {@link WcChatController} (the dip pipeline hydrates the `![…](…shtml)`
 *   references exactly like agent-authored ones);
 * - the page-side VFS is the worker-owned remote client (an `exists` shim
 *   over `stat` bridges the VirtualFS surface);
 * - welcome licks from the inline dips run through the revived interceptor
 *   BEFORE `client.sendSprinkleLick` — the cone has no API key at
 *   welcome-time and an unintercepted lick would fatal there.
 *
 * Float-agnostic by construction: standalone and the extension panel both
 * wire it from `attachWcClient`.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import { runFirstRunDetection } from '../boot/setup-onboarding.js';
import {
  createOnboardingOrchestratorSetup,
  type OnboardingOrchestratorHandle,
} from '../boot/setup-onboarding-orchestrator.js';
import {
  createWelcomeLickInterceptor,
  dispatchWelcomeLickOnce,
  loadFiredWelcomeActions,
  persistFiredWelcomeActions,
} from '../boot/setup-welcome-flow.js';
import type { BootStageLogger } from '../boot/types.js';
import { broadcastToDips } from '../dip.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { flushCredentialsToWorker } from '../onboarding-helpers.js';
import type { WcChatController } from './wc-chat-controller.js';
import type { WcPageVfs } from './wc-live.js';

export interface WcOnboardingDeps {
  client: OffscreenClient;
  getController(): WcChatController | null;
  openVfs(): Promise<WcPageVfs>;
  log: BootStageLogger;
}

export interface WcOnboardingHandle {
  /**
   * Run a dip/sprinkle lick through the welcome-flow interceptor. Returns
   * `true` when the lick was consumed and MUST NOT reach the cone.
   */
  interceptWelcomeLick(event: LickEvent): boolean;
}

/**
 * Bridge the remote VFS clients to the `VirtualFS` surface the onboarding
 * engine reads (`readFile`/`writeFile`/`readDir`/`stat` pass through; the
 * remote clients lack `exists`, shimmed over `stat`).
 */
function onboardingFs(vfs: WcPageVfs): VirtualFS {
  const { writer } = vfs;
  return {
    readFile: writer.readFile.bind(writer),
    writeFile: writer.writeFile.bind(writer),
    readDir: writer.readDir.bind(writer),
    stat: writer.stat.bind(writer),
    mkdir: writer.mkdir.bind(writer),
    exists: async (path: string) => {
      try {
        await writer.stat(path);
        return true;
      } catch {
        return false;
      }
    },
  } as unknown as VirtualFS;
}

export async function wireWcOnboarding(deps: WcOnboardingDeps): Promise<WcOnboardingHandle> {
  const { client, getController, openVfs, log } = deps;
  const providers = await import('../provider-settings.js');
  const { createSprinkleDeviceCodePrompter, resolveDeviceCodeDecision } = await import(
    '../../providers/device-code-bridge.js'
  );
  const fs = onboardingFs(await openVfs());
  const firedWelcomeActions = loadFiredWelcomeActions();

  const postLine = (line: string): void => {
    const controller = getController();
    if (controller) controller.addAssistantMessage(line);
    else log.warn('WC onboarding: no controller to post welcome line');
  };

  const fireFinalLick = (data: Record<string, unknown>): void => {
    flushCredentialsToWorker(client);
    const action = String((data as { action?: unknown })?.action ?? '');
    dispatchWelcomeLickOnce(
      action,
      firedWelcomeActions,
      () => client.sendSprinkleLick('welcome', data),
      'orchestrator-wc',
      log
    );
  };

  const onboardingHandle: OnboardingOrchestratorHandle = await createOnboardingOrchestratorSetup({
    fs,
    log,
    providers,
    deviceCode: { createSprinkleDeviceCodePrompter },
    postSystemMessage: postLine,
    postDipReference: postLine,
    broadcastToDip: (payload) => broadcastToDips(payload),
    onFireFinalLick: fireFinalLick,
  });

  const interceptWelcomeLick = createWelcomeLickInterceptor({
    firedWelcomeActions,
    getAccounts: providers.getAccounts,
    getProviderConfig: providers.getProviderConfig,
    resolveDeviceCodeDecision,
    getOnboardingOrchestrator: () => onboardingHandle.get(),
    fastForward: {
      fire: (data) => {
        const action = String((data as { action?: unknown }).action ?? '');
        dispatchWelcomeLickOnce(
          action,
          firedWelcomeActions,
          () => client.sendSprinkleLick('welcome', data),
          'fast-forward-wc',
          log
        );
      },
      broadcastAlreadyConnected: (providerId) => {
        const name = (() => {
          try {
            return providers.getProviderConfig(providerId)?.name ?? null;
          } catch {
            return null;
          }
        })();
        broadcastToDips({
          type: 'slicc-already-connected',
          provider: providerId,
          note: name ? `Already connected to ${name}.` : 'Already connected.',
        });
      },
    },
    onShortcutMigrate: () => {
      void fs
        .writeFile('/shared/.welcomed', '1')
        .catch((err) => log.warn('Failed to persist welcome completion marker', err));
    },
    contextLabel: 'wc',
    vfs: fs,
    log,
  });

  // First-run probe: no `.welcomed` marker + no welcome lick in chat
  // history + no tray-join URL → post the welcome dip.
  runFirstRunDetection({
    vfs: fs,
    storage: window.localStorage,
    firedWelcomeActions,
    persistFiredWelcomeActions,
    getOrchestrator: () => onboardingHandle.get(),
    log,
  });

  return { interceptWelcomeLick };
}
