/**
 * `setup-standalone-tray-init.ts` — runs the boot-time tray init block:
 * decides whether this standalone instance starts as a hosted-leader,
 * cherry follower, regular follower (stored join URL), regular leader
 * (stored worker base URL), or stays dormant. Extracted verbatim from
 * `mainStandaloneWorker` (~main.ts:1004–1197) so the orchestrator stays
 * under the boy-scout function-size cap.
 *
 * Gating + storage semantics are unchanged: hosted-leader always
 * clears any stale follower join URL and any persisted leader-tray
 * session before starting a fresh leader; cherry mode requires the
 * caller to supply a join URL + transport; the storage branches mirror
 * what `resolveTrayRuntimeConfig` seeded earlier in boot.
 */

import type { CherryHostTransport } from '../../cdp/cherry-host-transport.js';
import type { BrowserAPI } from '../../cdp/index.js';
import { IndexedDbLeaderTraySessionStore } from '../../scoops/tray-leader.js';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../scoops/tray-runtime-config.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { PageFollowerTrayHandle } from '../page-follower-tray.js';
import { CHERRY_RUNTIME_TAG, startPageFollowerTray } from '../page-follower-tray.js';
import type { PageLeaderTrayHandle, StartPageLeaderTrayOptions } from '../page-leader-tray.js';
import { startPageLeaderTray } from '../page-leader-tray.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import { runHostedBootstrap } from './setup-standalone-tray-init-hosted.js';
import type { BootStageLogger } from './types.js';

export interface StandaloneTrayInitDeps {
  runtimeMode: UiRuntimeMode;
  cherryJoinUrl?: string;
  cherryTransport?: CherryHostTransport;
  layout: Layout;
  client: OffscreenClient;
  browser: BrowserAPI;
  /** Build the full leader-tray options for the supplied worker URL. */
  buildLeaderTrayOptions(workerBaseUrl: string): StartPageLeaderTrayOptions;
  /** Wire the leader-only hooks (chat, sprinkles, etc.) after start. */
  wireLeaderHooks(handle: PageLeaderTrayHandle): void;
  /** Page-level `window`. */
  window: Window;
  log: BootStageLogger;
}

export interface StandaloneTrayInitResult {
  pageLeaderTray: PageLeaderTrayHandle | null;
  pageFollowerTray: PageFollowerTrayHandle | null;
}

function buildBootFollowerOptions(
  deps: Pick<StandaloneTrayInitDeps, 'layout' | 'browser' | 'client'>,
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

function buildCherryFollowerOptions(
  deps: Pick<StandaloneTrayInitDeps, 'layout' | 'browser' | 'cherryTransport'>,
  joinUrl: string
): Parameters<typeof startPageFollowerTray>[0] {
  const { layout, browser, cherryTransport } = deps;
  return {
    joinUrl,
    runtime: CHERRY_RUNTIME_TAG,
    onSnapshot: (messages) => layout.panels.chat.loadMessages(messages),
    onUserMessage: (text, _messageId, _scoopJid, attachments) =>
      layout.panels.chat.addUserMessage(text, attachments),
    onStatus: (status) => layout.panels.chat.setProcessing(status === 'processing'),
    onCherrySliccEvent: (name, detail) => cherryTransport?.emitSliccEventToHost(name, detail),
    setChatAgent: (agent) => layout.panels.chat.setAgent(agent),
    browserAPI: browser,
    addSprinkle: (name, title, element, zone, options) =>
      layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined, options),
    removeSprinkle: (name) => layout.removeSprinkle(name),
  };
}

async function startHostedLeader(deps: StandaloneTrayInitDeps): Promise<PageLeaderTrayHandle> {
  const { buildLeaderTrayOptions, wireLeaderHooks, window: win, log } = deps;
  win.localStorage.removeItem(TRAY_JOIN_STORAGE_KEY);
  await new IndexedDbLeaderTraySessionStore().clear();
  const workerBaseUrl = win.localStorage.getItem(TRAY_WORKER_STORAGE_KEY);
  if (!workerBaseUrl) {
    throw new Error(
      'hosted-leader: TRAY_WORKER_STORAGE_KEY not seeded — runtime-config resolution failed'
    );
  }
  const handle = startPageLeaderTray({
    ...buildLeaderTrayOptions(workerBaseUrl),
    runtime: 'slicc-hosted-leader',
    kind: 'hosted',
    onLeaderReady: (session) => {
      void fetch('/api/cloud-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          joinUrl: session.joinUrl,
          trayId: session.trayId,
          controllerUrl: session.controllerUrl,
          webhookUrl: session.webhookUrl,
          runtime: session.runtime,
          sliccVersion: __SLICC_VERSION__,
        }),
        signal: AbortSignal.timeout(10000),
      }).catch((err) => {
        log.error('failed to POST /api/cloud-status', { error: String(err) });
      });
    },
  });
  wireLeaderHooks(handle);
  void runHostedBootstrap({ log });
  return handle;
}

export async function setupStandaloneTrayInit(
  deps: StandaloneTrayInitDeps
): Promise<StandaloneTrayInitResult> {
  const { runtimeMode, cherryJoinUrl, cherryTransport, buildLeaderTrayOptions, wireLeaderHooks } =
    deps;
  const storedJoinUrl = deps.window.localStorage.getItem(TRAY_JOIN_STORAGE_KEY);
  const storedWorkerBaseUrl = deps.window.localStorage.getItem(TRAY_WORKER_STORAGE_KEY);
  if (runtimeMode === 'hosted-leader') {
    return { pageLeaderTray: await startHostedLeader(deps), pageFollowerTray: null };
  }
  if (runtimeMode === 'cherry' && cherryJoinUrl) {
    const follower = startPageFollowerTray(buildCherryFollowerOptions(deps, cherryJoinUrl));
    if (cherryTransport) {
      cherryTransport.onHostEvent = (name, detail) =>
        follower.currentSync?.sendCherryHostEvent(name, detail);
    }
    return { pageLeaderTray: null, pageFollowerTray: follower };
  }
  if (storedJoinUrl) {
    return {
      pageLeaderTray: null,
      pageFollowerTray: startPageFollowerTray(buildBootFollowerOptions(deps, storedJoinUrl)),
    };
  }
  if (storedWorkerBaseUrl) {
    const handle = startPageLeaderTray(buildLeaderTrayOptions(storedWorkerBaseUrl));
    wireLeaderHooks(handle);
    return { pageLeaderTray: handle, pageFollowerTray: null };
  }
  return { pageLeaderTray: null, pageFollowerTray: null };
}
