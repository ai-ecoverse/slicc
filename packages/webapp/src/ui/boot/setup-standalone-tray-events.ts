/**
 * `setup-standalone-tray-events.ts` — installs the `slicc:tray-join`
 * and `slicc:tray-leave` window event listeners for the
 * standalone-worker float. The avatar popover dispatches these when
 * the user pastes a join URL or drops out of a tray; both events
 * also flow through the panel-RPC bridge when `host leave` runs in
 * the worker terminal.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:1217–1369).
 * The tray-join handler exceeded the cognitive-complexity budget
 * when inlined; relocating it lets the orchestrator stay under the
 * boy-scout cap and surfaces the teardown sequence as a discrete,
 * testable unit.
 */

import type { BrowserAPI } from '../../cdp/index.js';
import type { TrayLeaveResult } from '../../scoops/tray-leave.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { PageFollowerTrayHandle } from '../page-follower-tray.js';
import { startPageFollowerTray } from '../page-follower-tray.js';
import type { PageLeaderTrayHandle } from '../page-leader-tray.js';
import type { SprinkleManager } from '../sprinkle-manager.js';
import type { BootStageLogger } from './types.js';

export interface StandaloneTrayEventsDeps {
  /** Read the current leader handle (mutated externally on role-switch). */
  getLeader(): PageLeaderTrayHandle | null;
  /** Replace the current leader handle (null on teardown). */
  setLeader(handle: PageLeaderTrayHandle | null): void;
  /** Read the current follower handle. */
  getFollower(): PageFollowerTrayHandle | null;
  /** Replace the current follower handle. */
  setFollower(handle: PageFollowerTrayHandle | null): void;
  layout: Layout;
  client: OffscreenClient;
  browser: BrowserAPI;
  sprinkleManager: SprinkleManager;
  /**
   * Null every leader hook AND dispose the remote-CDP bridge — same
   * teardown used by `clearLeaderHooks` in `setup-tray.ts`, threaded in
   * so a leader→follower role-switch doesn't leak federated CDP
   * transports. Must be a superset of the four leader hook clears.
   */
  clearLeaderHooks(): void;
  performTrayLeaveLocally(opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult>;
  /** Page-level `window` (injectable for tests). */
  window: Window;
  log: BootStageLogger;
}

/** Build the follower options bag used by `slicc:tray-join`. */
function buildJoinFollowerOptions(
  deps: StandaloneTrayEventsDeps,
  joinUrl: string
): Parameters<typeof startPageFollowerTray>[0] {
  const { layout, browser, client } = deps;
  return {
    joinUrl,
    onSnapshot: (messages) => layout.panels.chat.loadMessages(messages),
    onUserMessage: (text, _messageId, _scoopJid, attachments) =>
      layout.panels.chat.addUserMessage(text, attachments),
    onStatus: (status) => layout.panels.chat.setProcessing(status === 'processing'),
    setChatAgent: (agent) => layout.panels.chat.setAgent(agent),
    browserAPI: browser,
    onForwardingToggle: (enabled) => client.sendSetFollowerForwarding(enabled),
    addSprinkle: (name, title, element, zone, options) =>
      layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined, options),
    removeSprinkle: (name) => layout.removeSprinkle(name),
  };
}

/** Mid-switch teardown: null refs first, then stop each side guarded. */
function teardownForJoin(deps: StandaloneTrayEventsDeps): {
  leaderToStop: PageLeaderTrayHandle | null;
  previousFollower: PageFollowerTrayHandle | null;
} {
  const { getLeader, setLeader, getFollower, setFollower, clearLeaderHooks, log } = deps;
  const leaderToStop = getLeader();
  setLeader(null);
  clearLeaderHooks();
  const previousFollower = getFollower();
  setFollower(null);
  try {
    leaderToStop?.stop();
  } catch (err) {
    log.error('Leader stop threw during tray-join switch — runtime resources may have leaked', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    previousFollower?.stop();
  } catch (err) {
    log.error(
      'Previous follower stop threw during tray-join switch — runtime resources may have leaked',
      { error: err instanceof Error ? err.message : String(err) }
    );
  }
  return { leaderToStop, previousFollower };
}

function handleTrayJoin(deps: StandaloneTrayEventsDeps, rawEvent: Event): void {
  const { setFollower, window: win, log } = deps;
  const event = rawEvent as CustomEvent<{ joinUrl: string; requestId?: string }>;
  const joinUrl = event.detail?.joinUrl;
  const requestId = event.detail?.requestId;
  if (!joinUrl) {
    log.error('slicc:tray-join fired without joinUrl — UI dispatcher contract violation');
    return;
  }
  teardownForJoin(deps);
  try {
    setFollower(startPageFollowerTray(buildJoinFollowerOptions(deps, joinUrl)));
  } catch (err) {
    log.error('slicc:tray-join handler failed — runtime is in a half-state, page reload required', {
      joinUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      win.dispatchEvent(
        new CustomEvent('slicc:tray-join-failed', {
          detail: {
            joinUrl,
            error: err instanceof Error ? err.message : String(err),
            requestId,
          },
        })
      );
    } catch (dispatchErr) {
      log.error('slicc:tray-join-failed dispatch itself threw', {
        dispatchError: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
      });
    }
  }
}

export function setupStandaloneTrayEvents(deps: StandaloneTrayEventsDeps): void {
  const { performTrayLeaveLocally, window: win, log } = deps;
  win.addEventListener('slicc:tray-join', (rawEvent: Event) => handleTrayJoin(deps, rawEvent));
  win.addEventListener('slicc:tray-leave', (rawEvent: Event) => {
    const event = rawEvent as CustomEvent<{ workerBaseUrl?: string | null; requestId?: string }>;
    const workerBaseUrl = event.detail?.workerBaseUrl ?? null;
    const requestId = event.detail?.requestId;
    void performTrayLeaveLocally({ workerBaseUrl, requestId }).catch((err) => {
      log.error('slicc:tray-leave handler failed', {
        workerBaseUrl,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}
