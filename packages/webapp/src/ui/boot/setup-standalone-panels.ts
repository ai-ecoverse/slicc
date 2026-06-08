/**
 * `setup-standalone-panels.ts` — orchestrator-shim panel wiring +
 * clearChat / brain-icon / new-session callbacks + chat-agent handle
 * + frozen-sessions sidebar for the standalone-worker float.
 *
 * Extracted from `mainStandaloneWorker` (~main.ts:381–552). Does NOT
 * await `hostReady`; the caller still owns the
 * `await hostReady → requestState → frozenSessions.attachScoopsVfs()
 * → setupStorageSync` ordering so a boot failure can disarm the
 * migration splash without strand-locking the user.
 */

import { SessionStore as AgentSessionStore } from '../../core/session.js';
import { clearAllMessages as clearOrchestratorMessages } from '../../scoops/db.js';
import type { Orchestrator } from '../../scoops/index.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { createAttachmentTmpWriter } from '../attachment-vfs.js';
import type { Layout } from '../layout.js';
import { runNewSessionFreeze, runNewSessionFreezeQuick } from '../new-session.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { resolveCurrentModel } from '../provider-settings.js';
import type { AgentHandle } from '../types.js';
import { setupFrozenSessions } from './setup-frozen-sessions.js';
import { attachWorkerVfs } from './setup-vfs.js';
import type { BootStageLogger, VfsHandle } from './types.js';

export interface StandalonePanelsDeps {
  client: OffscreenClient;
  layout: Layout;
  vfsHandle: VfsHandle;
  selectScoop(scoop: RegisteredScoop): Promise<void> | void;
  getSelectedScoop(): RegisteredScoop | null;
  syncThinkingButtonForScoop(scoop: RegisteredScoop): void;
  log: BootStageLogger;
}

export interface StandalonePanelsHandle {
  agentHandle: AgentHandle;
  frozenSessions: ReturnType<typeof setupFrozenSessions>;
}

function wireOrchestratorPanels(deps: StandalonePanelsDeps): void {
  const { layout, client, vfsHandle, selectScoop, getSelectedScoop, syncThinkingButtonForScoop } =
    deps;
  layout.panels.scoops.setOrchestrator(client as unknown as Orchestrator);
  layout.panels.memory.setOrchestrator(client as unknown as Orchestrator);
  layout.setScoopSwitcherOrchestrator?.(client as unknown as Orchestrator);
  layout.setScoopSwitcherTranscriptSource?.((jid) => client.getScoopTranscript(jid));
  layout.setScoopsRailTranscriptSource?.((jid) => client.getScoopTranscript(jid));
  layout.onScoopSelect = selectScoop;
  layout.onClearChat = async () => {
    await clearOrchestratorMessages().catch(() => {});
    await new AgentSessionStore().clearAll().catch(() => {});
    const scoops = client.getScoops();
    for (const scoop of scoops) {
      const sessionId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
      await layout.panels.chat.deleteSessionById(sessionId);
    }
    client.clearAllMessages();
  };
  layout.onModelChange = (modelId) => {
    localStorage.setItem('selected-model', modelId);
    client.updateModel();
    const selected = getSelectedScoop();
    if (selected) syncThinkingButtonForScoop(selected);
  };
  layout.onThinkingLevelChange = (level) => {
    const selected = getSelectedScoop();
    if (!selected) return;
    client.setScoopThinkingLevel(selected.jid, level);
  };
  layout.onModelsRefreshed = () => {
    const selected = getSelectedScoop();
    if (selected) syncThinkingButtonForScoop(selected);
  };
  client.setLocalFS(vfsHandle.localFs);
}

function wireNewSessionClearChat(deps: StandalonePanelsDeps): void {
  const { client, layout, vfsHandle, log } = deps;
  const { useRpcVfs, opfsLeader } = vfsHandle;
  layout.onClearChat = async (opts) => {
    if (useRpcVfs && !opfsLeader.isLeader) {
      log.info('New session affordance skipped (OPFS follower — read-only tab)');
      return;
    }
    if (opts?.freeze === 'quick') {
      try {
        await runNewSessionFreezeQuick({ vfs: vfsHandle.writableFs });
      } catch (err) {
        log.warn('Quick freezer step failed (clearing anyway)', { error: String(err) });
      }
    } else if (opts?.freeze !== false) {
      try {
        await runNewSessionFreeze({ vfs: vfsHandle.writableFs });
      } catch (err) {
        log.warn('Freezer step failed (clearing anyway)', { error: String(err) });
      }
    } else {
      log.info('New session: freezer skipped (long-press)');
    }
    await layout.panels.chat.deleteSessionById('session-cone');
    await client.clearAllMessages();
  };
}

function wireChatAgent(deps: StandalonePanelsDeps): AgentHandle {
  const { client, layout, vfsHandle, log } = deps;
  layout.panels.chat.onMessagesChanged = (estimatedTokens) => {
    let contextWindow = 200000;
    try {
      const model = resolveCurrentModel();
      contextWindow = model.contextWindow ?? contextWindow;
    } catch {
      /* no active model — keep the default and the gauge stays cold */
    }
    layout.setNewSessionGlow(estimatedTokens / contextWindow);
  };
  const agentHandle = client.createAgentHandle();
  layout.panels.chat.setAgent(agentHandle);
  layout.panels.chat.setAttachmentWriter(createAttachmentTmpWriter(vfsHandle.localFs));
  layout.panels.chat.setDeleteQueuedMessageCallback((_messageId) => {
    log.warn('deleteQueuedMessage is a no-op in kernel-worker mode');
  });
  return agentHandle;
}

export async function setupStandalonePanels(
  deps: StandalonePanelsDeps
): Promise<StandalonePanelsHandle> {
  const { client, layout, vfsHandle, log } = deps;
  wireOrchestratorPanels(deps);
  await attachWorkerVfs({ handle: vfsHandle, client, layout, log });
  wireNewSessionClearChat(deps);
  const frozenSessions = setupFrozenSessions({ layout, vfs: vfsHandle, log });
  const agentHandle = wireChatAgent(deps);
  return { agentHandle, frozenSessions };
}
