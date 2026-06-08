/**
 * `setup-standalone-sprinkle-wiring.ts` — connects the page-side
 * `Layout`'s sprinkle-related callbacks (`onSprinkleClose`,
 * `onSprinkleActivate`, `getAvailableSprinkles`, `onOpenSprinkle`,
 * `resolveSprinkleIcon`), nudges the add-buttons, and runs the
 * persistent-open-state restoration.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:544–557).
 * `restoreOpenSprinkles()` is awaited so a layout-attached promise
 * never strays beyond the orchestrator's lifetime; failures are
 * downgraded to a warn so a single bad sprinkle doesn't strand the
 * rest of boot.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { Layout } from '../layout.js';
import { resolveSprinkleIconHtml } from '../sprinkle-icon.js';
import type { SprinkleManager } from '../sprinkle-manager.js';
import type { BootStageLogger } from './types.js';

export interface StandaloneSprinkleWiringDeps {
  layout: Layout;
  sprinkleManager: InstanceType<typeof SprinkleManager>;
  localFs: VirtualFS;
  log: BootStageLogger;
}

export async function setupStandaloneSprinkleWiring(
  deps: StandaloneSprinkleWiringDeps
): Promise<void> {
  const { layout, sprinkleManager, localFs, log } = deps;
  await sprinkleManager.refresh();
  layout.onSprinkleClose = (name) => sprinkleManager.close(name);
  layout.onSprinkleActivate = (name) => {
    void sprinkleManager.activate(name);
  };
  layout.getAvailableSprinkles = () => [];
  layout.onOpenSprinkle = (name, zone) => sprinkleManager.open(name, zone);
  layout.resolveSprinkleIcon = (spec) => resolveSprinkleIconHtml(spec, localFs);
  layout.updateAddButtons();
  await sprinkleManager.restoreOpenSprinkles().catch((err) => {
    log.warn('Failed to restore open sprinkles', err);
  });
}
