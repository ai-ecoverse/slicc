/**
 * `setup-extension-client.ts` — constructs the `OffscreenClient`, wires
 * its callbacks, and exposes a `selectScoop` helper used by the rest of
 * `mainExtension`. Extracted to keep the extension boot orchestrator
 * thin.
 *
 * The callback functions here all close over `getSelectedScoop()` and
 * `setSelectedScoop()` so the same selection state shared with the
 * caller stays the single source of truth.
 */

import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../scoops/tray-runtime-config.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import type { Layout } from '../layout.js';
import { isLickChannel, type LickChannel } from '../lick-channels.js';
import { OffscreenClient } from '../offscreen-client.js';
import type { ChatMessage } from '../types.js';
import type { BootStageLogger } from './types.js';

export interface ExtensionClientHandle {
  client: OffscreenClient;
  selectScoop(scoop: RegisteredScoop): Promise<void>;
}

export interface ExtensionClientSetupDeps {
  layout: Layout;
  log: BootStageLogger;
  getSelectedScoop(): RegisteredScoop | null;
  setSelectedScoop(scoop: RegisteredScoop | null): void;
  /** Called whenever the active scoop changes so the brain icon stays current. */
  syncThinkingButtonForScoop(scoop: RegisteredScoop): void;
}

export function setupExtensionClient(deps: ExtensionClientSetupDeps): ExtensionClientHandle {
  const { layout, log, getSelectedScoop, setSelectedScoop, syncThinkingButtonForScoop } = deps;
  let knownScoopFolders = new Set<string>();
  let client!: OffscreenClient;

  const selectScoop = async (scoop: RegisteredScoop): Promise<void> => {
    setSelectedScoop(scoop);
    client.setSelectedScoopJid(scoop.jid);
    layout.panels.memory.setSelectedScoop(scoop.jid);
    layout.setScoopSwitcherSelected?.(scoop.jid);
    layout.panels.scoops.setSelectedJid(scoop.jid);

    // switchToContext loads from the shared IDB. That snapshot can
    // drift if the side panel re-mounts mid-stream; ask offscreen for
    // the canonical history and the bridge replies via
    // `scoop-messages-replaced` which the caller wires below.
    const contextId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
    const scoopName = scoop.isCone ? undefined : scoop.name;
    await layout.panels.chat.switchToContext(contextId, !scoop.isCone, scoopName);
    client.requestScoopMessages(scoop.jid);

    if (client.isProcessing(scoop.jid)) {
      layout.panels.chat.setProcessing(true);
    }
    syncThinkingButtonForScoop(scoop);
  };

  client = new OffscreenClient({
    onStatusChange: (scoopJid, status) =>
      handleStatusChange(scoopJid, status, layout, getSelectedScoop),
    onScoopCreated: (scoop) => {
      layout.panels.scoops.refreshScoops();
      layout.refreshScoopSwitcher?.();
      if (!getSelectedScoop()) {
        setSelectedScoop(scoop);
        client.setSelectedScoopJid(scoop.jid);
        layout.panels.memory.setSelectedScoop(scoop.jid);
      }
    },
    onScoopListUpdate: () => {
      // Clean up UI sessions for dropped scoops.
      const currentFolders = new Set(client.getScoops().map((s) => s.folder));
      for (const folder of knownScoopFolders) {
        if (!currentFolders.has(folder)) {
          layout.panels.chat.deleteSessionById(`session-${folder}`);
        }
      }
      knownScoopFolders = currentFolders;
      layout.panels.scoops.refreshScoops();
      layout.refreshScoopSwitcher?.();
      if (!getSelectedScoop()) {
        const scoops = client.getScoops();
        const cone = scoops.find((s) => s.isCone);
        if (cone) {
          setSelectedScoop(cone);
          client.setSelectedScoopJid(cone.jid);
          layout.panels.memory.setSelectedScoop(cone.jid);
        }
      }
    },
    onIncomingMessage: (scoopJid, message) =>
      handleIncomingMessage(scoopJid, message, client, layout, getSelectedScoop),
    onScoopMessagesReplaced: (scoopJid, messages) => {
      if (getSelectedScoop()?.jid !== scoopJid) return;
      layout.panels.chat.loadMessages(messages as unknown as ChatMessage[]);
    },
    onCompactionStateChange: (scoopJid, state) => {
      if (getSelectedScoop()?.jid !== scoopJid) return;
      layout.panels.chat.setCompactionState(state);
    },
    onReady: async () => {
      try {
        log.info('Offscreen engine ready, scoop count:', client.getScoops().length);
        await replayTrayRuntimeRefresh();
        const target =
          getSelectedScoop() ?? client.getScoops().find((s) => s.isCone) ?? client.getScoops()[0];
        if (target) {
          setSelectedScoop(target);
          client.setSelectedScoopJid(target.jid);
          await selectScoop(target);
        }
      } catch (err) {
        log.error('Failed to initialize on ready', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  return { client, selectScoop };
}

function handleStatusChange(
  scoopJid: string,
  status: 'initializing' | 'processing' | 'ready' | 'error',
  layout: Layout,
  getSelectedScoop: () => RegisteredScoop | null
): void {
  layout.panels.scoops.updateScoopStatus(scoopJid, status);
  layout.updateScoopSwitcherStatus?.(scoopJid, status);
  if (getSelectedScoop()?.jid !== scoopJid) return;
  layout.setAgentProcessing(status === 'processing');
  if (status === 'processing') layout.panels.chat.setProcessing(true);
  else if (status === 'ready') layout.panels.chat.setProcessing(false);
}

function handleIncomingMessage(
  scoopJid: string,
  message: {
    id: string;
    content: string;
    channel: string;
    timestamp: string | number;
    attachments?: unknown;
  },
  client: OffscreenClient,
  layout: Layout,
  getSelectedScoop: () => RegisteredScoop | null
): void {
  if (isLickChannel(message.channel)) {
    const lickTs = new Date(message.timestamp).getTime();
    const channel = message.channel as LickChannel;
    if (getSelectedScoop()?.jid === scoopJid) {
      layout.panels.chat.addLickMessage(message.id, message.content, channel, lickTs);
    } else {
      const target = client.getScoops().find((s) => s.jid === scoopJid);
      const sessionId = target?.isCone
        ? 'session-cone'
        : target
          ? `session-${target.folder}`
          : `session-${scoopJid}`;
      void layout.panels.chat.persistLickToSession(sessionId, {
        id: message.id,
        content: message.content,
        channel,
        timestamp: lickTs,
      });
    }
    return;
  }
  if (getSelectedScoop()?.jid === scoopJid) {
    const content =
      message.channel === 'delegation'
        ? `**[Instructions from sliccy]**\n\n${message.content}`
        : message.content;
    layout.panels.chat.addUserMessage(
      content,
      message.attachments as Parameters<typeof layout.panels.chat.addUserMessage>[1]
    );
  }
}

async function replayTrayRuntimeRefresh(): Promise<void> {
  const storedJoinUrl = window.localStorage.getItem(TRAY_JOIN_STORAGE_KEY);
  if (!storedJoinUrl) return;
  void chrome.runtime
    .sendMessage({
      source: 'panel' as const,
      payload: {
        type: 'refresh-tray-runtime' as const,
        joinUrl: storedJoinUrl,
        workerBaseUrl: window.localStorage.getItem(TRAY_WORKER_STORAGE_KEY),
      },
    })
    .catch(() => {
      /* offscreen may already be syncing runtime state */
    });
}
