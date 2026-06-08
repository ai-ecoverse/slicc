/**
 * `setup-standalone-tray-bootstrap.ts` — bundles the page-side tray
 * runtime bring-up: the initial role selection (hosted-leader /
 * cherry / follower / leader / dormant), the `slicc.leaderTrayStatus`
 * propagation into the worker's localStorage shim, the runtime
 * tray-join / tray-leave window listeners, and the page-unload
 * tear-down for the active leader/follower handles.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:559–636).
 * The init block runs first so the status subscription captures the
 * leader handle's first push; tray-events are installed last so a
 * user-driven role switch can't race the boot init.
 */

import type { CherryHostTransport } from '../../cdp/cherry-host-transport.js';
import type { BrowserAPI } from '../../cdp/index.js';
import {
  getLeaderTrayRuntimeStatus,
  subscribeToLeaderTrayRuntimeStatus,
} from '../../scoops/tray-leader.js';
import type { TrayLeaveResult } from '../../scoops/tray-leave.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { PageFollowerTrayHandle } from '../page-follower-tray.js';
import type { PageLeaderTrayHandle, StartPageLeaderTrayOptions } from '../page-leader-tray.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import type { SprinkleManager } from '../sprinkle-manager.js';
import { setupStandaloneTrayEvents } from './setup-standalone-tray-events.js';
import { setupStandaloneTrayInit } from './setup-standalone-tray-init.js';
import type { BootStageLogger } from './types.js';

export interface StandaloneTrayBootstrapDeps {
  runtimeMode: UiRuntimeMode;
  cherryJoinUrl?: string;
  cherryTransport?: CherryHostTransport;
  layout: Layout;
  client: OffscreenClient;
  browser: BrowserAPI;
  sprinkleManager: InstanceType<typeof SprinkleManager>;
  buildLeaderTrayOptions(workerBaseUrl: string): StartPageLeaderTrayOptions;
  wireLeaderHooks(handle: PageLeaderTrayHandle): void;
  /** Null leader hooks and dispose remote-CDP bridge — see `setup-tray.ts`. */
  clearLeaderHooks(): void;
  performTrayLeaveLocally(opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult>;
  /** Mutable leader/follower bindings owned by the orchestrator. */
  getLeader(): PageLeaderTrayHandle | null;
  setLeader(handle: PageLeaderTrayHandle | null): void;
  getFollower(): PageFollowerTrayHandle | null;
  setFollower(handle: PageFollowerTrayHandle | null): void;
  window: Window;
  log: BootStageLogger;
}

export async function setupStandaloneTrayBootstrap(
  deps: StandaloneTrayBootstrapDeps
): Promise<void> {
  const {
    runtimeMode,
    cherryJoinUrl,
    cherryTransport,
    layout,
    client,
    browser,
    sprinkleManager,
    buildLeaderTrayOptions,
    wireLeaderHooks,
    clearLeaderHooks,
    performTrayLeaveLocally,
    getLeader,
    setLeader,
    getFollower,
    setFollower,
    window: win,
    log,
  } = deps;

  const trayInit = await setupStandaloneTrayInit({
    runtimeMode,
    cherryJoinUrl,
    cherryTransport,
    layout,
    client,
    browser,
    buildLeaderTrayOptions,
    wireLeaderHooks,
    window: win,
    log,
  });
  setLeader(trayInit.pageLeaderTray);
  setFollower(trayInit.pageFollowerTray);

  subscribeToLeaderTrayRuntimeStatus((status) => {
    win.localStorage.setItem('slicc.leaderTrayStatus', JSON.stringify(status));
  });
  win.localStorage.setItem('slicc.leaderTrayStatus', JSON.stringify(getLeaderTrayRuntimeStatus()));

  setupStandaloneTrayEvents({
    getLeader,
    setLeader,
    getFollower,
    setFollower,
    layout,
    client,
    browser,
    sprinkleManager,
    clearLeaderHooks,
    performTrayLeaveLocally,
    window: win,
    log,
  });

  win.addEventListener(
    'beforeunload',
    () => {
      getLeader()?.stop();
      getFollower()?.stop();
    },
    { once: true }
  );
}
