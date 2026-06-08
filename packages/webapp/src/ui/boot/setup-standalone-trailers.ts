/**
 * `setup-standalone-trailers.ts` — fires the welcome first-run check
 * and publishes `globalThis.__slicc_tool_ui_send` so the panel-side
 * dip's button clicks route to the WORKER's `toolUIRegistry` over the
 * kernel transport instead of the panel's empty registry.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:588–601).
 * Without the tool-ui hook, every cone-driven dip (mount approval,
 * confirm prompts, …) hangs on user click because the agent's
 * promise is registered in the worker.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { runFirstRunDetection } from './setup-onboarding.js';
import type { BootStageLogger, OnboardingFirstRunHandler } from './types.js';

export interface StandaloneTrailersDeps {
  client: OffscreenClient;
  localFs: VirtualFS;
  firedWelcomeActions: Set<string>;
  persistFiredWelcomeActions(set: Set<string>): void;
  getOnboardingOrchestrator(): OnboardingFirstRunHandler;
  window: Window;
  log: BootStageLogger;
}

export function setupStandaloneTrailers(deps: StandaloneTrailersDeps): void {
  const {
    client,
    localFs,
    firedWelcomeActions,
    persistFiredWelcomeActions,
    getOnboardingOrchestrator,
    window: win,
    log,
  } = deps;

  runFirstRunDetection({
    vfs: localFs,
    storage: win.localStorage,
    firedWelcomeActions,
    persistFiredWelcomeActions,
    getOrchestrator: getOnboardingOrchestrator,
    log,
  });

  (
    globalThis as typeof globalThis & {
      __slicc_tool_ui_send?: (requestId: string, action: string, data: unknown) => void;
    }
  ).__slicc_tool_ui_send = (requestId, action, data) => {
    client.sendRaw({ type: 'tool-ui-action', requestId, action, data });
  };
}
