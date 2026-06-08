/**
 * `setup-extension-panels.ts` — wires the side-panel layout to the
 * OffscreenClient: agent handle + attachment writer, scoops/memory
 * orchestrator panels, brain icon (model + thinking level), and the
 * `onClearChat` / `onClearFilesystem` handlers.
 *
 * Extracted from `mainExtension` so the orchestrator function stays
 * close to its 150-line cap. Pure wiring — no async work, no I/O.
 */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { VirtualFS } from '../../fs/index.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import type { Orchestrator } from '../../scoops/orchestrator.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { createAttachmentTmpWriter } from '../attachment-vfs.js';
import type { Layout } from '../layout.js';
import { runNewSessionFreeze, runNewSessionFreezeQuick } from '../new-session.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { resolveCurrentModel, resolveModelById } from '../provider-settings.js';
import type { BootStageLogger } from './types.js';

export interface ExtensionPanelsSetupDeps {
  client: OffscreenClient;
  layout: Layout;
  localFs: VirtualFS;
  writableFs: WritableVfsClient;
  selectScoop(scoop: RegisteredScoop): Promise<void>;
  getSelectedScoop(): RegisteredScoop | null;
  log: BootStageLogger;
}

export interface ExtensionPanelsHandle {
  /** Sync the brain icon to the active scoop's resolved model + level. */
  syncThinkingButtonForScoop(scoop: RegisteredScoop): void;
}

export function setupExtensionPanels(deps: ExtensionPanelsSetupDeps): ExtensionPanelsHandle {
  const { client, layout, localFs, writableFs, selectScoop, getSelectedScoop, log } = deps;

  // Wire local VFS to client so memory panel can read CLAUDE.md files.
  client.setLocalFS(localFs);

  // Off-load oversized attachments to /tmp on the local VFS so the
  // offscreen agent can read them via the shared IndexedDB.
  layout.panels.chat.setAttachmentWriter(createAttachmentTmpWriter(localFs));

  // Wire agent handle.
  layout.panels.chat.setAgent(client.createAgentHandle());

  // Wire panels — OffscreenClient implements the Orchestrator surface
  // ScoopsPanel / ScoopSwitcher / MemoryPanel need.
  layout.panels.scoops.setOrchestrator(client as unknown as Orchestrator);
  layout.panels.memory.setOrchestrator(client as unknown as Orchestrator);
  layout.setScoopSwitcherOrchestrator?.(client as unknown as Orchestrator);
  // Scope-label tooltip uses the side-effect-free transcript accessor —
  // same role as `Orchestrator.getMessagesForScoop` in the standalone
  // rail, but routed through a dedicated `request-scoop-transcript`
  // round-trip so the chat panel is never repainted.
  layout.setScoopSwitcherTranscriptSource?.((jid) => client.getScoopTranscript(jid));
  layout.setScoopsRailTranscriptSource?.((jid) => client.getScoopTranscript(jid));

  layout.onScoopSelect = selectScoop;

  // Brain icon: same lookup as the standalone version, but reads
  // `scoop.config` from the proxied snapshot.
  const syncThinkingButtonForScoop = (scoop: RegisteredScoop): void => {
    const modelId = scoop.config?.modelId;
    const model = modelId ? resolveModelById(modelId) : resolveCurrentModel();
    layout.panels.chat.setModelSupportsReasoning(
      !!model.reasoning,
      getSupportedThinkingLevels(model).includes('xhigh')
    );
    layout.panels.chat.setThinkingLevel(scoop.config?.thinkingLevel);
  };

  layout.onModelChange = (modelId) => {
    localStorage.setItem('selected-model', modelId);
    client.updateModel();
    const sel = getSelectedScoop();
    if (sel) syncThinkingButtonForScoop(sel);
  };
  layout.onThinkingLevelChange = (level) => {
    const sel = getSelectedScoop();
    if (!sel) return;
    client.setScoopThinkingLevel(sel.jid, level);
  };
  layout.onModelsRefreshed = () => {
    const sel = getSelectedScoop();
    if (sel) syncThinkingButtonForScoop(sel);
  };

  // Wire "New session" — freeze the cone's chat to /sessions/ via the
  // freezer, then delete ONLY the cone session. Scoops survive so the
  // fresh cone inherits the existing scoop roster. See `boot/setup-
  // standalone-clear-chat` callers for the matching standalone wiring.
  layout.onClearChat = async (opts) => {
    if (opts?.freeze === 'quick') {
      try {
        await runNewSessionFreezeQuick({ vfs: writableFs });
      } catch (err) {
        log.warn('Quick freezer step failed (clearing anyway)', { error: String(err) });
      }
    } else if (opts?.freeze !== false) {
      try {
        await runNewSessionFreeze({ vfs: writableFs });
      } catch (err) {
        log.warn('Freezer step failed (clearing anyway)', { error: String(err) });
      }
    } else {
      log.info('New session: freezer skipped (long-press)');
    }
    await layout.panels.chat.deleteSessionById('session-cone');
    await client.clearAllMessages();
  };
  layout.onClearFilesystem = async () => {
    client.clearFilesystem();
  };

  return { syncThinkingButtonForScoop };
}
