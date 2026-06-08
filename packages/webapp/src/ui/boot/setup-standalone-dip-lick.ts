/**
 * `setup-standalone-dip-lick.ts` — wires the chat panel's `onDipLick`
 * callback so inline `<img>`-hydrated dip clicks (the welcome dip is
 * the canonical example) reach the welcome interceptor first, then
 * either forward to a connected leader (follower mode) or dispatch
 * locally via `client.sendSprinkleLick('inline', …)`.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:375–404).
 * Follower routing predicates on `pageFollowerTray` (set on join,
 * cleared only on permanent leave) rather than `?.currentSync` so a
 * transient WebRTC reconnect logs+drops instead of silently routing
 * to the model-less local cone.
 */

import type { LickEvent } from '../../scoops/lick-manager.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { PageFollowerTrayHandle } from '../page-follower-tray.js';
import type { BootStageLogger } from './types.js';

export interface StandaloneDipLickDeps {
  layout: Layout;
  client: OffscreenClient;
  /** Lazy accessor — reads the live follower binding. */
  getFollower(): PageFollowerTrayHandle | null;
  interceptWelcomeLick(event: LickEvent): boolean;
  log: BootStageLogger;
}

export function setupStandaloneDipLick(deps: StandaloneDipLickDeps): void {
  const { layout, client, getFollower, interceptWelcomeLick, log } = deps;
  layout.panels.chat.onDipLick = (action: string, data: unknown) => {
    const event: LickEvent = {
      type: 'sprinkle',
      sprinkleName: 'inline',
      targetScoop: undefined,
      timestamp: new Date().toISOString(),
      body: { action, data },
    };
    if (interceptWelcomeLick(event)) return;
    const follower = getFollower();
    if (follower) {
      const sync = follower.currentSync;
      if (sync) {
        sync.sendSprinkleLick('inline', { action, data });
      } else {
        log.warn('Dip lick dropped: follower sync mid-reconnect', { action });
      }
      return;
    }
    client.sendSprinkleLick('inline', { action, data });
  };
}
