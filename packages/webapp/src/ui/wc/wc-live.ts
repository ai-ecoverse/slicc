/**
 * Live boot for the WC shell (`?ui=wc`): spawns the kernel worker directly —
 * no legacy `Layout` — and wires its callbacks onto a `WcChatController` and
 * the shell's scoop switcher. Phase 1 scope is the conversation loop:
 * composer → orchestrator prompt, agent events → thread, scoop switching.
 * Sprinkles, terminal, onboarding, tray, and sudo approvals still live only
 * in the legacy UI.
 */

import { spawnKernelWorker } from '../../kernel/spawn.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { setupStandalonePrelude } from '../boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../boot/types.js';
import { isLickChannel } from '../lick-channels.js';
import type { OffscreenClient, OffscreenClientCallbacks } from '../offscreen-client.js';
import type { ChatMessage } from '../types.js';
import { WcChatController } from './wc-chat-controller.js';
import { mountWcShell, type SwitcherScoop, submittedText, type WcShellRefs } from './wc-shell.js';

const CONE_COLOR = '#b07823';
const SCOOP_PALETTE = ['#06b6d4', '#8b5cf6', '#f59e0b', '#10b981', '#3b82f6', '#ef4444'];

/** Stable palette pick for a scoop chip, keyed by name. */
export function scoopColor(scoop: Pick<RegisteredScoop, 'isCone' | 'name'>): string {
  if (scoop.isCone) return CONE_COLOR;
  let hash = 0;
  for (const ch of scoop.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SCOOP_PALETTE[hash % SCOOP_PALETTE.length];
}

/** Map registered scoops onto switcher chip descriptors (cone first). */
export function toSwitcherScoops(scoops: readonly RegisteredScoop[]): SwitcherScoop[] {
  return [...scoops]
    .sort((a, b) => Number(b.isCone) - Number(a.isCone))
    .map((scoop) => ({
      key: scoop.jid,
      type: scoop.isCone ? 'cone' : 'scoop',
      color: scoopColor(scoop),
      label: scoop.isCone ? 'sliccy' : scoop.name,
      eyes: 'open' as const,
    }));
}

export interface WcLiveWiring {
  refs: WcShellRefs;
  getController(): WcChatController | null;
  getClient(): OffscreenClient | null;
  getSelected(): RegisteredScoop | null;
  selectScoop(scoop: RegisteredScoop): void;
}

/**
 * Kernel callbacks for the WC live shell. Pure factory over the wiring
 * handle so tests can drive it with fakes — no worker required.
 */
export function createWcLiveCallbacks(wiring: WcLiveWiring): OffscreenClientCallbacks {
  const refreshScoops = (): void => {
    const client = wiring.getClient();
    if (client) wiring.refs.switcher.scoops = toSwitcherScoops(client.getScoops());
  };
  return {
    onStatusChange: (jid, status) => {
      if (wiring.getSelected()?.jid !== jid) return;
      wiring.getController()?.setProcessing(status === 'processing');
    },
    onScoopCreated: (scoop) => {
      refreshScoops();
      if (!wiring.getSelected()) wiring.selectScoop(scoop);
    },
    onScoopListUpdate: () => refreshScoops(),
    onIncomingMessage: (jid, message) => {
      if (wiring.getSelected()?.jid !== jid) return;
      if (message.channel !== 'web' && isLickChannel(message.channel)) {
        wiring
          .getController()
          ?.addLickMessage(
            message.id,
            message.content,
            message.channel,
            new Date(message.timestamp).getTime()
          );
      }
    },
    onScoopMessagesReplaced: (jid, messages) => {
      if (wiring.getSelected()?.jid !== jid) return;
      wiring.getController()?.loadMessages(messages as unknown as ChatMessage[]);
    },
    onReady: () => {
      const client = wiring.getClient();
      refreshScoops();
      const cone = client?.getScoops().find((s) => s.isCone);
      if (cone && !wiring.getSelected()) wiring.selectScoop(cone);
    },
  };
}

/** Point the thread chrome at a scoop (context label + accent hue). */
function applyThreadContext(refs: WcShellRefs, scoop: RegisteredScoop): void {
  refs.thread.setAttribute('context', scoop.isCone ? 'cone' : `scoop:${scoop.name}`);
  refs.thread.setAttribute('accent', scoopColor(scoop));
  refs.switcher.setAttribute('active', scoop.jid);
}

/** Boot the live WC shell: prelude → kernel spawn → controller wiring. */
export async function mountWcUiLive(app: HTMLElement, log: BootStageLogger): Promise<void> {
  const { realCdpTransport, instanceId } = await setupStandalonePrelude({
    runtimeMode: 'standalone',
    envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
    window,
    log,
  });

  const refs = mountWcShell(app, {
    messages: [],
    scoops: [],
    floatLabel: 'standalone · live',
    placeholder: 'Ask sliccy, or describe a change…',
  });

  let controller: WcChatController | null = null;
  let client: OffscreenClient | null = null;
  let selected: RegisteredScoop | null = null;

  const selectScoop = (scoop: RegisteredScoop): void => {
    selected = scoop;
    if (!client) return;
    client.setSelectedScoopJid(scoop.jid);
    applyThreadContext(refs, scoop);
    client.requestScoopMessages(scoop.jid);
    controller?.setProcessing(client.isProcessing(scoop.jid));
  };

  const wiring: WcLiveWiring = {
    refs,
    getController: () => controller,
    getClient: () => client,
    getSelected: () => selected,
    selectScoop,
  };

  const host = spawnKernelWorker({
    realCdpTransport,
    instanceId,
    callbacks: createWcLiveCallbacks(wiring),
  });
  client = host.client;

  controller = new WcChatController({
    thread: refs.thread,
    agent: client.createAgentHandle(),
    onProcessingChange: (processing) => {
      refs.frame.toggleAttribute('data-processing', processing);
    },
  });

  refs.inputCard.addEventListener('submit', (event) => {
    const text = submittedText(event);
    if (text) controller?.sendUserMessage(text);
  });

  refs.switcher.addEventListener('slicc-scoop-select', (event) => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    const scoop = client?.getScoops().find((s) => s.jid === key);
    if (scoop && scoop.jid !== selected?.jid) selectScoop(scoop);
  });

  await host.ready;
  log.info('WC live shell ready', { scoops: client.getScoops().length });
}
