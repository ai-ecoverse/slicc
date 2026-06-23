import { createLogger } from '../../core/logger.js';
import type { BootStageLogger } from '../boot/types.js';
import type { UiRuntimeMode } from '../runtime-mode.js';

const log = createLogger('wc-follower');

/** Lightweight no-kernel follower boot. Built out across Tasks 3-6. */
export async function mountWcUiFollower(
  _app: HTMLElement,
  _log: BootStageLogger,
  runtimeMode: UiRuntimeMode
): Promise<void> {
  log.info('mountWcUiFollower (placeholder)', { runtimeMode });
}
