/**
 * `setup-standalone-runtime.ts` — composite stage that runs the full
 * post-panels runtime for the standalone-worker float: host-ready
 * join, onboarding wiring, inline-dip lick callback, sprinkle manager
 * construction, and the leader-runtime / panel-RPC / sprinkle-layout
 * / tray-bootstrap / trailers sequence (`setupStandalonePostSprinkle`).
 *
 * Extracted from `mainStandaloneWorker` (~main.ts:310–406) so the
 * orchestrator stays under the boy-scout function-size cap. Owns the
 * `pageLeaderTray` / `pageFollowerTray` mutable bindings internally
 * — the dip-lick handler is the only consumer that needs to read the
 * follower binding before `setupStandalonePostSprinkle` populates it.
 */

import type { CherryHostTransport } from '../../cdp/cherry-host-transport.js';
import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { PageFollowerTrayHandle } from '../page-follower-tray.js';
import type { PageLeaderTrayHandle } from '../page-leader-tray.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import { setupStandaloneDipLick } from './setup-standalone-dip-lick.js';
import { setupStandaloneHostReady } from './setup-standalone-host-ready.js';
import { setupStandaloneOnboarding } from './setup-standalone-onboarding.js';
import { setupStandalonePostSprinkle } from './setup-standalone-post-sprinkle.js';
import { setupStandaloneSprinkle } from './setup-standalone-sprinkle.js';
import type { BootStageLogger, FrozenSessionsHandle, VfsHandle } from './types.js';

export interface StandaloneRuntimeDeps {
  runtimeMode: UiRuntimeMode;
  cherryJoinUrl?: string;
  cherryTransport?: CherryHostTransport;
  layout: Layout;
  client: OffscreenClient;
  browser: BrowserAPI;
  agentHandle: ReturnType<OffscreenClient['createAgentHandle']>;
  realCdpTransport: CDPTransport;
  vfsHandle: VfsHandle;
  frozenSessions: FrozenSessionsHandle;
  hostReady: Promise<void>;
  disarmMigrationSplash(): void;
  instanceId: string;
  getSelectedScoop(): RegisteredScoop | null;
  firedWelcomeActions: Set<string>;
  persistFiredWelcomeActions(set: Set<string>): void;
  /** Names of sprinkles to hydrate as inline dips in chat history. */
  inlineSprinkles: ReadonlySet<string>;
  window: Window;
  log: BootStageLogger;
}

export interface StandaloneRuntimeHandle {
  stopStorageSync(): void;
  stopSprinkleHandler(): void;
}

export async function setupStandaloneRuntime(
  deps: StandaloneRuntimeDeps
): Promise<StandaloneRuntimeHandle> {
  const {
    runtimeMode,
    cherryJoinUrl,
    cherryTransport,
    layout,
    client,
    browser,
    agentHandle,
    realCdpTransport,
    vfsHandle,
    frozenSessions,
    hostReady,
    disarmMigrationSplash,
    instanceId,
    getSelectedScoop,
    firedWelcomeActions,
    persistFiredWelcomeActions,
    inlineSprinkles,
    window: win,
    log,
  } = deps;
  const { localFs, useRpcVfs, opfsLeader, panelReadVfs, writableFs } = vfsHandle;

  const { stopStorageSync } = await setupStandaloneHostReady({
    client,
    hostReady,
    disarmMigrationSplash,
    frozenSessions,
    localStorage: win.localStorage,
    log,
  });

  const { onboardingHandle, interceptWelcomeLick } = await setupStandaloneOnboarding({
    client,
    layout,
    localFs,
    writableFs,
    useRpcVfs,
    isOpfsLeader: opfsLeader.isLeader,
    firedWelcomeActions,
    log,
  });
  const getOnboardingOrchestrator = () => onboardingHandle.get();

  let pageLeaderTray: PageLeaderTrayHandle | null = null;
  let pageFollowerTray: PageFollowerTrayHandle | null = null;

  setupStandaloneDipLick({
    layout,
    client,
    getFollower: () => pageFollowerTray,
    interceptWelcomeLick,
    log,
  });

  const { sprinkleManager, stopSprinkleHandler } = await setupStandaloneSprinkle({
    client,
    layout,
    localFs,
    panelReadVfs,
    writableFs,
    useRpcVfs,
    instanceId,
    inlineSprinkles,
    interceptWelcomeLick,
  });

  await setupStandalonePostSprinkle({
    runtimeMode,
    cherryJoinUrl,
    cherryTransport,
    layout,
    client,
    browser,
    sprinkleManager,
    agentHandle,
    realCdpTransport,
    localFs,
    instanceId,
    getSelectedScoop,
    getLeader: () => pageLeaderTray,
    setLeader: (h) => {
      pageLeaderTray = h;
    },
    getFollower: () => pageFollowerTray,
    setFollower: (h) => {
      pageFollowerTray = h;
    },
    firedWelcomeActions,
    persistFiredWelcomeActions,
    getOnboardingOrchestrator,
    window: win,
    log,
  });

  return { stopStorageSync, stopSprinkleHandler };
}
