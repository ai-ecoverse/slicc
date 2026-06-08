/**
 * `setup-standalone-post-sprinkle.ts` — composite stage that runs every
 * post-sprinkle wiring for the standalone-worker float in the
 * canonical order: leader-runtime → panel-RPC → sprinkle-layout
 * callbacks → tray bootstrap → trailers (first-run + tool-ui hook).
 *
 * Extracted from `mainStandaloneWorker` (~main.ts:380–474) so the
 * orchestrator stays under the boy-scout function-size cap. Owns the
 * `pageLeaderTray` / `pageFollowerTray` forward-declared bindings —
 * earlier wirings that need to close over them (the dip-lick handler
 * is the only one) are passed `getFollower` instead.
 */

import type { CherryHostTransport } from '../../cdp/cherry-host-transport.js';
import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import type { VirtualFS } from '../../fs/index.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { PageFollowerTrayHandle } from '../page-follower-tray.js';
import type { PageLeaderTrayHandle } from '../page-leader-tray.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import type { SprinkleManager } from '../sprinkle-manager.js';
import { setupStandaloneLeaderRuntime } from './setup-standalone-leader-runtime.js';
import { setupStandalonePanelRpc } from './setup-standalone-panel-rpc.js';
import { setupStandaloneSprinkleWiring } from './setup-standalone-sprinkle-wiring.js';
import { setupStandaloneTrailers } from './setup-standalone-trailers.js';
import { setupStandaloneTrayBootstrap } from './setup-standalone-tray-bootstrap.js';
import type { BootStageLogger, OnboardingFirstRunHandler } from './types.js';

export interface StandalonePostSprinkleDeps {
  runtimeMode: UiRuntimeMode;
  cherryJoinUrl?: string;
  cherryTransport?: CherryHostTransport;
  layout: Layout;
  client: OffscreenClient;
  browser: BrowserAPI;
  sprinkleManager: InstanceType<typeof SprinkleManager>;
  agentHandle: ReturnType<OffscreenClient['createAgentHandle']>;
  realCdpTransport: CDPTransport;
  localFs: VirtualFS;
  instanceId: string;
  getSelectedScoop(): RegisteredScoop | null;
  /** Forward-declared by the orchestrator; mutated by this stage. */
  getLeader(): PageLeaderTrayHandle | null;
  setLeader(handle: PageLeaderTrayHandle | null): void;
  getFollower(): PageFollowerTrayHandle | null;
  setFollower(handle: PageFollowerTrayHandle | null): void;
  firedWelcomeActions: Set<string>;
  persistFiredWelcomeActions(set: Set<string>): void;
  getOnboardingOrchestrator(): OnboardingFirstRunHandler;
  window: Window;
  log: BootStageLogger;
}

export async function setupStandalonePostSprinkle(deps: StandalonePostSprinkleDeps): Promise<void> {
  const {
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
    getLeader,
    setLeader,
    getFollower,
    setFollower,
    firedWelcomeActions,
    persistFiredWelcomeActions,
    getOnboardingOrchestrator,
    window: win,
    log,
  } = deps;

  const {
    buildLeaderTrayOptions,
    wireLeaderHooks,
    clearLeaderHooks,
    performTrayLeaveLocally,
    remoteCdpBridge,
    remoteCdpPushChannel,
  } = setupStandaloneLeaderRuntime({
    layout,
    client,
    browser,
    sprinkleManager,
    agentHandle,
    realCdpTransport,
    localFs,
    instanceId,
    getSelectedScoop,
    getLeader,
    setLeader,
    getFollower,
    setFollower,
    window: win,
    log,
  });

  await setupStandalonePanelRpc({
    instanceId,
    browser,
    remoteCdpBridge,
    remoteCdpPushChannel,
    getLeader,
    performTrayLeaveLocally,
    window: win,
  });

  await setupStandaloneSprinkleWiring({ layout, sprinkleManager, localFs, log });

  await setupStandaloneTrayBootstrap({
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
  });

  setupStandaloneTrailers({
    client,
    localFs,
    firedWelcomeActions,
    persistFiredWelcomeActions,
    getOnboardingOrchestrator,
    window: win,
    log,
  });
}
