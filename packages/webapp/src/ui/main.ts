// ── CSS imports (order matters for specificity) ──────────────────────
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/header.css';
import './styles/chat.css';
import './styles/tools.css';
import './styles/markdown.css';
import './styles/panels.css';
import './styles/tabs.css';
import './styles/dialog.css';
import './styles/sprinkle-components.css';
import './styles/feedback.css';

/**
 * Main entry point for the Browser Coding Agent UI.
 *
 * Bootstraps the layout, checks for API key, initializes the
 * orchestrator with cone + scoops, and wires events to the Chat UI.
 * Always uses cone+orchestrator mode — no direct agent path.
 */

import { Layout } from './layout.js';
import { getApiKey, showProviderSettings, applyProviderDefaults } from './provider-settings.js';
import { initTheme } from './theme.js';
import { initTooltips } from './tooltip.js';
import type { AgentHandle, AgentEvent as UIAgentEvent, ChatMessage } from './types.js';
import type { MessageAttachment } from '../core/attachments.js';
import { isLickChannel, type LickChannel } from './lick-channels.js';
import { createLogger } from '../core/index.js';
import type { VirtualFS } from '../fs/index.js';
import { installSkillFromDrop } from '../skills/install-from-drop.js';
import {
  findDroppedNonSkillTransferFiles,
  findDroppedSkillTransferFile,
  hasDroppedFiles,
} from './skill-drop.js';
import { createAttachmentTmpWriter } from './attachment-vfs.js';
// Auto-discover and register all providers (built-in + external).
// IMPORTANT: This import must also appear in packages/chrome-extension/src/offscreen.ts
// — the extension agent engine runs in the offscreen document, not in this file.
import '../providers/index.js';
import { BrowserAPI, NavigationWatcher } from '../cdp/index.js';
import { Orchestrator } from '../scoops/index.js';
import { publishAgentBridge } from '../scoops/agent-bridge.js';
import type { RegisteredScoop, ChannelMessage } from '../scoops/types.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import {
  LeaderTrayManager,
  createTrayFetch,
  getLeaderTrayRuntimeStatus,
} from '../scoops/tray-leader.js';
import {
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  DEFAULT_STAGING_TRAY_WORKER_BASE_URL,
  buildTrayLaunchUrl,
  fetchRuntimeConfig,
  hasStoredTrayJoinUrl,
  resolveTrayRuntimeConfig,
  TRAY_JOIN_STORAGE_KEY,
} from '../scoops/tray-runtime-config.js';
import {
  FollowerTrayManager,
  LeaderTrayPeerManager,
  startFollowerWithAutoReconnect,
  type FollowerAutoReconnectHandle,
} from '../scoops/tray-webrtc.js';
import { LeaderSyncManager } from '../scoops/tray-leader-sync.js';
import { FollowerSyncManager } from '../scoops/tray-follower-sync.js';
import { TabPersistenceGuard } from '../scoops/tab-persistence-guard.js';
import {
  getElectronOverlayInitialTab,
  getLickWebSocketUrl,
  getTrayWebhookUrl,
  getWebhookUrl,
  isElectronOverlaySetTabMessage,
  resolveUiRuntimeMode,
  shouldUseRuntimeModeTrayDefaults,
} from './runtime-mode.js';
import {
  setConnectedFollowersGetter,
  setTrayResetter,
} from '../shell/supplemental-commands/host-command.js';
import { setRsyncSendFsRequest } from '../shell/supplemental-commands/rsync-command.js';
import {
  setPlaywrightTeleportBestFollower,
  setPlaywrightTeleportConnectedFollowers,
} from '../shell/supplemental-commands/playwright-command.js';
import { SprinkleManager } from './sprinkle-manager.js';
import { initTelemetry } from './telemetry.js';
import { getAllMountEntries } from '../fs/mount-table-store.js';
import { recoverMounts, formatMountRecoveryPrompt } from '../fs/mount-recovery.js';
import { detectUpgrade } from '../scoops/upgrade-detection.js';

const log = createLogger('main');

const PENDING_MOUNT_DB = 'slicc-pending-mount';
const PENDING_MOUNT_KEY = 'pendingMount';

/** True when the current URL requests the design-time UI fixture
 *  (`?ui-fixture=1`). Accepts `1`, `true`, and the bare presence of the key
 *  so both `?ui-fixture` and `?ui-fixture=1` work for quick toggling. */
function isUIFixtureRequested(): boolean {
  try {
    const raw = new URLSearchParams(window.location.search).get('ui-fixture');
    if (raw === null) return false;
    return raw === '' || raw === '1' || raw.toLowerCase() === 'true';
  } catch {
    return false;
  }
}

/** Load the design-time UI fixture into the chat panel.
 *
 * Writes messages to a dedicated `session-ui-fixture` session id so the
 * fixture survives reloads without touching real scoop storage. Real
 * scoops remain selectable in the sidebar — clicking one switches away
 * and saves any fixture state under its own session id. */
async function loadUIFixtureIntoChat(chatPanel: {
  switchToContext: (id: string, readOnly: boolean, scoopName?: string) => Promise<void>;
  loadMessages: (msgs: ChatMessage[]) => void;
}): Promise<void> {
  const [{ createChatFixture, FIXTURE_SESSION_ID, FIXTURE_SCOOP_NAME }] = await Promise.all([
    import('./chat-fixture.js'),
  ]);
  await chatPanel.switchToContext(FIXTURE_SESSION_ID, true, FIXTURE_SCOOP_NAME);
  chatPanel.loadMessages(createChatFixture());
  log.info('Loaded UI fixture session for design iteration');
}

/** Store a directory handle for later mount during onboarding completion. */
async function storePendingMount(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(PENDING_MOUNT_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('handles', 'readwrite');
  tx.objectStore('handles').put(handle, PENDING_MOUNT_KEY);
  await new Promise<void>((r) => (tx.oncomplete = () => r()));
  db.close();
}

/** Retrieve and clear the pending mount handle, then mount it to /mnt/<dirname>. */
async function applyPendingMount(fs: VirtualFS): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(PENDING_MOUNT_DB, 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return; // DB doesn't exist yet
  }
  const tx = db.transaction('handles', 'readwrite');
  const handle = await new Promise<FileSystemDirectoryHandle | undefined>((resolve) => {
    const req = tx.objectStore('handles').get(PENDING_MOUNT_KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
  if (handle) {
    tx.objectStore('handles').delete(PENDING_MOUNT_KEY);
    await new Promise<void>((r) => (tx.oncomplete = () => r()));
    const mountPath = `/mnt/${handle.name}`;
    await fs.mount(mountPath, handle);
    log.info('Mounted folder from welcome onboarding', { name: handle.name, path: mountPath });
  }
  db.close();
}

type SkillDropNoticeKind = 'success' | 'error';

function createSkillDropOverlay(): {
  show(title: string, description: string): void;
  hide(): void;
} {
  const overlay = document.createElement('div');
  overlay.className = 'skill-drop-overlay';

  const card = document.createElement('div');
  card.className = 'skill-drop-overlay__card';

  const titleEl = document.createElement('div');
  titleEl.className = 'skill-drop-overlay__title';
  card.appendChild(titleEl);

  const descEl = document.createElement('div');
  descEl.className = 'skill-drop-overlay__desc';
  card.appendChild(descEl);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  return {
    show(title: string, description: string): void {
      titleEl.textContent = title;
      descEl.textContent = description;
      overlay.classList.add('skill-drop-overlay--visible');
    },
    hide(): void {
      overlay.classList.remove('skill-drop-overlay--visible');
    },
  };
}

function createSkillDropToast(): (message: string, kind: SkillDropNoticeKind) => void {
  const container = document.createElement('div');
  container.className = 'skill-drop-toast-container';
  document.body.appendChild(container);

  return (message: string, kind: SkillDropNoticeKind): void => {
    const toast = document.createElement('div');
    toast.className = `skill-drop-toast skill-drop-toast--${kind}`;
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('skill-drop-toast--visible'));

    const dismiss = () => {
      toast.classList.remove('skill-drop-toast--visible');
      window.setTimeout(() => toast.remove(), 180);
    };

    window.setTimeout(dismiss, 4200);
  };
}

function registerSkillDropInstall(
  fs: VirtualFS,
  onNotice: (message: string, kind: SkillDropNoticeKind) => void,
  onInstalled: () => Promise<void>,
  onAttachFiles?: (files: File[]) => Promise<void>
): void {
  const overlay = createSkillDropOverlay();
  let dragDepth = 0;
  let installInProgress = false;

  const resetDrag = (): void => {
    dragDepth = 0;
    if (!installInProgress) overlay.hide();
  };

  window.addEventListener('dragenter', (event) => {
    // During drag, browsers restrict file access — only check if files are present
    if (!hasDroppedFiles(event.dataTransfer)) return;

    event.preventDefault();
    dragDepth += 1;
    if (!installInProgress) {
      overlay.show('Drop files', '.skill archives install; other files attach to chat.');
    }
  });

  window.addEventListener('dragover', (event) => {
    if (!hasDroppedFiles(event.dataTransfer)) return;

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!installInProgress) {
      overlay.show('Drop files', '.skill archives install; other files attach to chat.');
    }
  });

  window.addEventListener('dragleave', () => {
    if (dragDepth === 0) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && !installInProgress) {
      overlay.hide();
    }
  });

  window.addEventListener('dragend', resetDrag);
  window.addEventListener('blur', resetDrag);

  window.addEventListener('drop', async (event) => {
    const skillFile = findDroppedSkillTransferFile(event.dataTransfer);
    const attachmentFiles = findDroppedNonSkillTransferFiles<File>(event.dataTransfer);

    if (!skillFile && attachmentFiles.length === 0) {
      resetDrag();
      return;
    }

    event.preventDefault();
    dragDepth = 0;

    if (skillFile && installInProgress) {
      overlay.hide();
      onNotice('Another .skill installation is already in progress.', 'error');
      return;
    }

    if (attachmentFiles.length > 0 && onAttachFiles) {
      try {
        await onAttachFiles(attachmentFiles);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onNotice(`Failed to attach dropped files: ${message}`, 'error');
      }
    }

    if (skillFile) {
      installInProgress = true;
      overlay.show('Installing skill…', skillFile.name);

      try {
        const result = await installSkillFromDrop(fs, skillFile);
        await onInstalled();
        onNotice(
          `Installed "${result.skillName}" to ${result.destinationPath} (${result.fileCount} files). Run "skill install ${result.skillName}" to apply it.`,
          'success'
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onNotice(`Failed to install dropped skill: ${message}`, 'error');
      } finally {
        installInProgress = false;
        overlay.hide();
      }
    } else {
      overlay.hide();
    }
  });
}

// ---------------------------------------------------------------------------
// Extension mode — pure UI connecting to offscreen agent engine
// ---------------------------------------------------------------------------

async function mainExtension(app: HTMLElement): Promise<void> {
  const { OffscreenClient } = await import('./offscreen-client.js');
  const { VirtualFS } = await import('../fs/index.js');
  const { publishAgentBridgeProxy } = await import('../scoops/agent-bridge.js');

  const layout = new Layout(app, true);
  // Expose debug tab toggle for the shell `debug` command
  (window as unknown as Record<string, unknown>).__slicc_debug_tabs = (show: boolean) =>
    layout.setDebugTabs(show);
  await layout.panels.chat.initSession('session-cone');

  // Publish the AgentBridge proxy on the panel realm's globalThis. The
  // real bridge lives in the offscreen document (`publishAgentBridge` in
  // `offscreen.ts`); the proxy forwards spawn requests through
  // chrome.runtime.sendMessage and awaits the offscreen response.
  publishAgentBridgeProxy();

  let selectedScoop: RegisteredScoop | null = null;

  // Create a local VFS instance for the file browser and terminal.
  // IndexedDB is shared across all same-origin extension pages, so this
  // reads/writes the same data as the offscreen document's VFS.
  const localFs = await VirtualFS.create({ dbName: 'slicc-fs' });
  layout.panels.fileBrowser.setFs(localFs);
  log.info('File browser wired to shared VFS (local IndexedDB)');

  // Listen for preview SW file-read requests (falls back here for mounted dirs).
  // Uses BroadcastChannel because the SW's `/preview/` scope excludes this page.
  const previewVfsCh = new BroadcastChannel('preview-vfs');
  previewVfsCh.onmessage = (event) => {
    if (event.data?.type !== 'preview-vfs-read') return;
    const { id, path, asText } = event.data;
    (async () => {
      try {
        const encoding = asText ? 'utf-8' : 'binary';
        const content = await localFs.readFile(path, { encoding });
        previewVfsCh.postMessage({ type: 'preview-vfs-response', id, content });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!errMsg.includes('ENOENT')) {
          log.error('Preview VFS read failed', { path, error: errMsg });
        }
        previewVfsCh.postMessage({ type: 'preview-vfs-response', id, error: errMsg });
      }
    })();
  };

  // Wire skill drop install with toast feedback
  const skillDropToast = createSkillDropToast();
  registerSkillDropInstall(
    localFs,
    skillDropToast,
    async () => {
      await layout.panels.fileBrowser.refresh();
    },
    (files) => layout.panels.chat.addAttachmentsFromFiles(files)
  );

  // Mount a terminal shell on the local VFS with BrowserAPI via CDP proxy
  try {
    const { WasmShell } = await import('../shell/index.js');
    const { PanelCdpProxy, BrowserAPI: BrowserAPIClass } = await import('../cdp/index.js');
    const { fetchSecretEnvVars } = await import('../core/secret-env.js');
    const panelCdp = new PanelCdpProxy();
    await panelCdp.connect();
    const panelBrowser = new BrowserAPIClass(panelCdp);
    const secretEnv = await fetchSecretEnvVars();
    const shell = new WasmShell({
      fs: localFs,
      browserAPI: panelBrowser,
      env: Object.keys(secretEnv).length > 0 ? secretEnv : undefined,
    });
    await layout.panels.terminal.mountShell(shell);
    log.info('Terminal mounted with shared VFS and BrowserAPI (CDP proxy)');
  } catch (e) {
    log.warn('Failed to mount shell to terminal', e);
  }

  // Register session costs provider for the panel's terminal shell.
  // The offscreen document owns the orchestrator, so we request cost data via chrome.runtime.
  {
    const { registerSessionCostsProvider } =
      await import('../shell/supplemental-commands/cost-command.js');
    registerSessionCostsProvider(
      () =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { source: 'panel' as const, payload: { type: 'get-session-costs' } },
            (response: unknown) => {
              if (chrome.runtime.lastError || !(response as { ok?: boolean })?.ok) {
                resolve([]);
                return;
              }
              resolve(((response as { costs?: unknown[] }).costs as []) ?? []);
            }
          );
        })
    );
  }

  // Define selectScoop early so onReady can reference it.
  // Uses `client` which is assigned right after construction.
  let client!: InstanceType<typeof OffscreenClient>;
  let knownScoopFolders = new Set<string>();

  const selectScoop = async (scoop: RegisteredScoop) => {
    selectedScoop = scoop;
    client.selectedScoopJid = scoop.jid;
    layout.panels.memory.setSelectedScoop(scoop.jid);
    layout.setScoopSwitcherSelected?.(scoop.jid);
    layout.panels.scoops.setSelectedJid(scoop.jid);

    // switchToContext loads messages from the shared browser-coding-agent IndexedDB
    // (written by the offscreen bridge). No buffer reconciliation needed.
    const contextId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
    const scoopName = scoop.isCone ? undefined : scoop.name;
    await layout.panels.chat.switchToContext(contextId, !scoop.isCone, scoopName);

    if (client.isProcessing(scoop.jid)) {
      layout.panels.chat.setProcessing(true);
    }
  };

  client = new OffscreenClient({
    onStatusChange: (scoopJid, status) => {
      layout.panels.scoops.updateScoopStatus(scoopJid, status);
      layout.updateScoopSwitcherStatus?.(scoopJid, status);

      if (selectedScoop?.jid === scoopJid) {
        layout.setAgentProcessing(status === 'processing');
        if (status === 'processing') {
          layout.panels.chat.setProcessing(true);
        } else if (status === 'ready') {
          layout.panels.chat.setProcessing(false);
        }
      }
    },
    onScoopCreated: (scoop) => {
      layout.panels.scoops.refreshScoops();
      layout.refreshScoopSwitcher?.();
      if (!selectedScoop) {
        selectedScoop = scoop;
        client.selectedScoopJid = scoop.jid;
        layout.panels.memory.setSelectedScoop(scoop.jid);
      }
    },
    onScoopListUpdate: () => {
      // Clean up UI sessions for dropped scoops
      const currentFolders = new Set(client.getScoops().map((s) => s.folder));
      for (const folder of knownScoopFolders) {
        if (!currentFolders.has(folder)) {
          layout.panels.chat.deleteSessionById(`session-${folder}`);
        }
      }
      knownScoopFolders = currentFolders;

      layout.panels.scoops.refreshScoops();
      layout.refreshScoopSwitcher?.();

      // If no scoop selected yet, pick the cone
      if (!selectedScoop) {
        const scoops = client.getScoops();
        const cone = scoops.find((s) => s.isCone);
        if (cone) {
          selectedScoop = cone;
          client.selectedScoopJid = cone.jid;
          layout.panels.memory.setSelectedScoop(cone.jid);
        }
      }
    },
    onIncomingMessage: (scoopJid, message) => {
      // Scoop lifecycle licks (scoop-notify / scoop-idle) are forwarded by
      // the orchestrator for display only — render them as licks in the
      // cone's chat (and persist to the target session) exactly like
      // webhook/cron events. This fixes the gap where scoop completions
      // enqueued for the cone's agent but never appeared in the chat.
      if (isLickChannel(message.channel)) {
        const lickTs = new Date(message.timestamp).getTime();
        const channel = message.channel as LickChannel;
        if (selectedScoop?.jid === scoopJid) {
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
      if (selectedScoop?.jid === scoopJid) {
        const content =
          message.channel === 'delegation'
            ? `**[Instructions from sliccy]**\n\n${message.content}`
            : message.content;
        layout.panels.chat.addUserMessage(content, message.attachments);
      }
    },
    onReady: async () => {
      try {
        log.info('Offscreen engine ready, scoop count:', client.getScoops().length);

        if (window.localStorage.getItem(TRAY_JOIN_STORAGE_KEY)) {
          void chrome.runtime
            .sendMessage({
              source: 'panel' as const,
              payload: { type: 'refresh-tray-runtime' as const },
            })
            .catch(() => {
              // Offscreen may already be syncing runtime state.
            });
        }

        // Pick the cone (or first scoop) and run full scoop selection.
        // switchToContext inside selectScoop loads from shared IndexedDB.
        const target =
          selectedScoop ?? client.getScoops().find((s) => s.isCone) ?? client.getScoops()[0];
        if (target) {
          selectedScoop = target;
          client.selectedScoopJid = target.jid;
          await selectScoop(target);
        }
      } catch (err) {
        log.error('Failed to initialize on ready', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  // Wire local VFS to client so memory panel can read CLAUDE.md files
  client.setLocalFS(localFs);

  // Off-load oversized attachments to /tmp on the local VFS so the
  // offscreen agent can read them via the shared IndexedDB.
  layout.panels.chat.setAttachmentWriter(createAttachmentTmpWriter(localFs));

  // Wire agent handle
  const agentHandle = client.createAgentHandle();
  layout.panels.chat.setAgent(agentHandle);

  // Wire panels — OffscreenClient implements the Orchestrator methods
  // that ScoopsPanel, ScoopSwitcher, and MemoryPanel need
  layout.panels.scoops.setOrchestrator(client as unknown as Orchestrator);
  layout.panels.memory.setOrchestrator(client as unknown as Orchestrator);
  layout.setScoopSwitcherOrchestrator?.(client as unknown as Orchestrator);

  layout.onScoopSelect = selectScoop;

  // Wire model picker
  layout.onModelChange = (modelId) => {
    localStorage.setItem('selected-model', modelId);
    client.updateModel();
  };

  // Wire clear chat — delete all scoop sessions from the shared IndexedDB
  // synchronously (from the panel's perspective) before the reload happens.
  // The bridge also clears its in-memory buffers via the clear-chat message.
  layout.onClearChat = async () => {
    const scoops = client.getScoops();
    for (const scoop of scoops) {
      const sessionId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
      await layout.panels.chat.deleteSessionById(sessionId);
    }
    client.clearAllMessages();
  };

  layout.onClearFilesystem = async () => {
    client.clearFilesystem();
  };

  // Wire inline sprinkle lick callback (extension mode)
  layout.panels.chat.onInlineSprinkleLick = (action: string, data: unknown) => {
    client.sendSprinkleLick('inline', { action, data });
  };

  // ── Sprinkle Manager (SHTML sprinkle panels) ────────────────────────
  const sprinkleManager = new SprinkleManager(
    localFs,
    async (event: LickEvent) => {
      // Route sprinkle licks to the offscreen orchestrator's cone
      if (event.type === 'sprinkle') {
        // Handle welcome sprinkle lifecycle events
        if (event.sprinkleName === 'welcome') {
          const body = event.body as Record<string, unknown> | null;
          const action = body?.action;
          if (action === 'onboarding-complete' || action === 'shortcut-migrate') {
            void localFs
              .writeFile('/shared/.welcomed', '1')
              .catch((err) => log.warn('Failed to persist welcome completion marker', err));
          }
          if (action === 'shortcut-migrate') {
            sprinkleManager.close('welcome');
          }
          // Perform the actual mount if user selected a folder during onboarding
          if (
            action === 'onboarding-complete' &&
            (body?.data as Record<string, unknown> | undefined)?.mountWorkspace
          ) {
            applyPendingMount(localFs).catch((err) =>
              log.warn('Failed to mount workspace from onboarding', err)
            );
          }
        }
        // Handle request-mount from welcome sprinkle (sandbox can't call showDirectoryPicker)
        if (
          event.sprinkleName === 'welcome' &&
          (event.body as Record<string, unknown> | null)?.action === 'request-mount'
        ) {
          try {
            const w = window as Window & {
              showDirectoryPicker?: (
                opts: Record<string, unknown>
              ) => Promise<FileSystemDirectoryHandle>;
            };
            if (!w.showDirectoryPicker) throw new Error('showDirectoryPicker not supported');
            const handle = await w.showDirectoryPicker({ mode: 'readwrite' });
            await storePendingMount(handle);
            sprinkleManager.sendToSprinkle('welcome', {
              action: 'mount-complete',
              dirName: handle.name,
            });
          } catch (err: unknown) {
            if ((err as { name?: string }).name !== 'AbortError') {
              log.warn('Mount picker failed', err);
            }
            sprinkleManager.sendToSprinkle('welcome', { action: 'mount-cancelled' });
          }
          return; // Don't forward to orchestrator
        }
        client.sendSprinkleLick(event.sprinkleName!, event.body, event.targetScoop);
      }
    },
    {
      addSprinkle: (name, title, element, zone) =>
        layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined),
      removeSprinkle: (name) => layout.removeSprinkle(name),
    },
    () => {
      const cone = client.getScoops().find((s) => s.isCone);
      if (cone) {
        client.stopScoop(cone.jid);
      }
    }
  );
  (window as unknown as Record<string, unknown>).__slicc_sprinkleManager = sprinkleManager;
  (window as unknown as Record<string, unknown>).__slicc_reloadSkills = () => {
    chrome.runtime.sendMessage({
      source: 'panel',
      payload: { type: 'reload-skills' },
    });
    return Promise.resolve();
  };

  // Register handler so the offscreen proxy can relay sprinkle operations here.
  // Routed through the OffscreenClient's existing onMessage listener to ensure delivery.
  client.setSprinkleOpHandler((payload: Record<string, unknown>) => {
    const { id, op, name, data } = payload as {
      id: unknown;
      op: string;
      name: string;
      data: unknown;
    };
    console.log('[main-ext] sprinkle-op handler called', { id, op, name });
    (async () => {
      try {
        let result: unknown;
        switch (op) {
          case 'list':
            await sprinkleManager.refresh();
            result = sprinkleManager.available();
            break;
          case 'opened':
            result = sprinkleManager.opened();
            break;
          case 'refresh':
            await sprinkleManager.refresh();
            result = sprinkleManager.available().length;
            break;
          case 'open':
            await sprinkleManager.open(name);
            result = true;
            break;
          case 'close':
            sprinkleManager.close(name);
            result = true;
            break;
          case 'send':
            sprinkleManager.sendToSprinkle(name, data);
            result = true;
            break;
          case 'openNewAutoOpen':
            await sprinkleManager.openNewAutoOpenSprinkles();
            result = true;
            break;
        }
        console.log('[main-ext] sprinkle-op response sending', { id, op, result: typeof result });
        (
          chrome.runtime.sendMessage({
            source: 'panel',
            payload: { type: 'sprinkle-op-response', id, result },
          }) as Promise<unknown>
        ).catch(() => {});
      } catch (err) {
        (
          chrome.runtime.sendMessage({
            source: 'panel',
            payload: {
              type: 'sprinkle-op-response',
              id,
              error: err instanceof Error ? err.message : String(err),
            },
          }) as Promise<unknown>
        ).catch(() => {});
      }
    })();
  });

  await sprinkleManager.refresh();
  layout.onSprinkleClose = (name) => sprinkleManager.close(name);
  layout.getAvailableSprinkles = () => {
    const opened = new Set(sprinkleManager.opened());
    return sprinkleManager
      .available()
      .filter((p) => !opened.has(p.name))
      .map((p) => ({ name: p.name, title: p.title }));
  };
  layout.onOpenSprinkle = (name, zone) => sprinkleManager.open(name, zone);
  layout.updateAddButtons();
  await sprinkleManager.restoreOpenSprinkles();

  // Migrate legacy localStorage flag to VFS marker
  if (!(await localFs.exists('/shared/.welcomed')) && localStorage.getItem('slicc-welcomed')) {
    await localFs.writeFile('/shared/.welcomed', '1').catch(() => {});
    localStorage.removeItem('slicc-welcomed');
  }

  // Open welcome sprinkle on first run (extension mode)
  if (
    !(await localFs.exists('/shared/.welcomed')) &&
    !hasStoredTrayJoinUrl(window.localStorage) &&
    sprinkleManager.available().some((p) => p.name === 'welcome')
  ) {
    try {
      await sprinkleManager.open('welcome');
    } catch (e) {
      log.warn('Failed to open welcome sprinkle', e);
    }
  }

  log.info('SprinkleManager initialized (extension mode)');

  // Request state from offscreen — retries automatically until ready
  client.requestState();

  log.info('Extension UI connected to offscreen agent engine');

  // `?ui-fixture=1` — same design-time override as the CLI path, but run
  // last so the normal extension boot (state sync, scoop selection) has
  // populated the sidebar before we overwrite the chat view.
  if (isUIFixtureRequested()) {
    await loadUIFixtureIntoChat(layout.panels.chat);
  }

  // Initialize operational telemetry (fire-and-forget)
  initTelemetry().catch(() => {});
}

// ---------------------------------------------------------------------------
// CLI mode — direct Orchestrator in this page (unchanged)
// ---------------------------------------------------------------------------

// ── Main-thread freeze watchdog ──────────────────────────────────────
// Uses a Worker that pings the main thread every 2s. If the main thread
// doesn't pong within 5s, the worker logs a warning. When the main thread
// recovers, it captures a performance timeline and console.trace().
function startFreezeWatchdog(): void {
  // Extension CSP blocks blob: workers; skip in extension mode.
  // The extension offscreen document is a separate process anyway,
  // so a frozen sprinkle in the panel won't block the agent.
  if (typeof chrome !== 'undefined' && !!chrome?.runtime?.id) return;

  const workerCode = `
    let lastPong = Date.now();
    let frozen = false;
    setInterval(() => {
      postMessage({ type: 'ping' });
      const elapsed = Date.now() - lastPong;
      if (elapsed > 5000 && !frozen) {
        frozen = true;
        postMessage({ type: 'freeze-detected', elapsed });
      }
    }, 2000);
    self.onmessage = (e) => {
      if (e.data.type === 'pong') {
        lastPong = Date.now();
        if (frozen) {
          frozen = false;
          postMessage({ type: 'freeze-recovered' });
        }
      }
    };
  `;
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  const worker = new Worker(blobUrl);
  URL.revokeObjectURL(blobUrl);

  worker.onmessage = (e) => {
    if (e.data.type === 'ping') {
      worker.postMessage({ type: 'pong' });
    } else if (e.data.type === 'freeze-detected') {
      // This won't fire until the main thread unblocks, but the worker detected it via postMessage
      console.error(
        `[freeze-watchdog] Main thread blocked for ${e.data.elapsed}ms — capturing trace on recovery`
      );
    } else if (e.data.type === 'freeze-recovered') {
      console.error('[freeze-watchdog] Main thread recovered. Stack trace at recovery point:');
      console.trace('[freeze-watchdog] recovery stack');
      // Also dump long-task entries
      const longTasks = performance.getEntriesByType('longtask');
      if (longTasks.length > 0) {
        console.error(
          '[freeze-watchdog] Long tasks:',
          longTasks.map((t) => ({ duration: t.duration, startTime: t.startTime, name: t.name }))
        );
      }
    }
  };

  window.addEventListener(
    'beforeunload',
    () => {
      worker.terminate();
    },
    { once: true }
  );
}

async function main(): Promise<void> {
  startFreezeWatchdog();
  initTheme();
  initTooltips();

  const app = document.getElementById('app');
  if (!app) throw new Error('#app element not found');

  // Register preview service worker (serves VFS content at /preview/*)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/preview-sw.js', { scope: '/preview/' })
      .then(() => log.info('Preview SW registered'))
      .catch((err) =>
        log.error('Preview SW registration failed — preview feature will not work', err)
      );
  }

  // Apply providers.json defaults before checking for API key
  applyProviderDefaults();

  // Check for API key (first-run dialog)
  // Skip the dialog if the user already has a stored tray join URL (providerless follower mode)
  let apiKey = getApiKey();
  const hasTrayJoin = hasStoredTrayJoinUrl(window.localStorage);
  if (!apiKey && !hasTrayJoin) {
    // Three modes based on runtime context:
    // 1. Port 5710/3000: leader/production — default to account login
    // 2. Port '' (443/HTTPS) with /join/ path: remote tray UI — auto-join confirmation
    // 3. Any other port: follower — default to "Join a tray" paste form
    const isDefaultPort = window.location.port === '5710' || window.location.port === '3000';
    const isRemoteTrayUI =
      window.location.port === '' && window.location.pathname.includes('/join/');

    if (isRemoteTrayUI) {
      const joinUrl = window.location.origin + window.location.pathname;
      await showProviderSettings({ autoJoinUrl: joinUrl });
    } else if (!isDefaultPort && window.location.port !== '') {
      await showProviderSettings({ preferTrayJoin: true });
    } else {
      await showProviderSettings();
    }
    apiKey = getApiKey();
  }
  const allowProviderlessTrayJoin = !apiKey && hasStoredTrayJoinUrl(window.localStorage);

  // Build the layout — tabbed in extension mode, split panels in standalone
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  const runtimeMode = resolveUiRuntimeMode(window.location.href, isExtension);

  // Extension mode: delegate to offscreen-backed UI
  if (runtimeMode === 'extension') {
    return mainExtension(app);
  }

  const layout = new Layout(app, runtimeMode === 'electron-overlay');
  if (runtimeMode === 'electron-overlay') {
    const initialTab = getElectronOverlayInitialTab(window.location.href);
    layout.setActiveTab(initialTab);

    const runtimeStyle = document.createElement('style');
    runtimeStyle.id = 'slicc-electron-overlay-runtime-style';
    runtimeStyle.textContent = `
      #app > .tab-bar { display: none !important; }
      #app > .tab-content {
        height: calc(100vh - var(--s2-header-height));
      }
      #app > .tab-content > .tab-content__panel {
        height: 100%;
      }
    `;
    document.head.appendChild(runtimeStyle);

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (!isElectronOverlaySetTabMessage(event.data)) return;
      layout.setActiveTab(
        getElectronOverlayInitialTab(`http://localhost/?tab=${event.data.tab ?? ''}`)
      );
    });

    window.addEventListener(
      'keydown',
      (event: KeyboardEvent) => {
        if (
          event.code === 'Semicolon' &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey &&
          !event.repeat
        ) {
          event.preventDefault();
          event.stopPropagation();
          window.parent.postMessage({ type: 'slicc-electron-overlay:toggle' }, '*');
        }
      },
      true
    );
  }
  const showSkillDropToast = createSkillDropToast();

  // Initialize session persistence — use 'session-cone' from the start
  // so it matches the contextId used in switchToContext()
  await layout.panels.chat.initSession('session-cone');
  log.info('Session initialized');

  // Initialize the BrowserAPI (CLI mode only — extension uses CDP proxy in offscreen)
  const browser = new BrowserAPI();

  // Event system for UI
  const eventListeners = new Set<(event: UIAgentEvent) => void>();

  const emitToUI = (event: UIAgentEvent): void => {
    log.debug('Emit to UI', { type: event.type, listenerCount: eventListeners.size });
    for (const cb of eventListeners) {
      try {
        cb(event);
      } catch (err) {
        log.error('Listener error', {
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  // Track currently selected scoop for routing
  let selectedScoop: RegisteredScoop | null = null;

  // Track current message ID per scoop (unique per response)
  const scoopCurrentMessageId = new Map<string, string>();

  // ── Per-scoop message buffers ──────────────────────────────────────
  // Captures ALL scoop events (tool calls, content, etc.) regardless of
  // which scoop is currently selected. When switching views, we load from
  // the buffer so nothing is lost.
  const scoopMessageBuffers = new Map<string, ChatMessage[]>();

  function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** Get or create buffer for a scoop. */
  function getBuffer(jid: string): ChatMessage[] {
    let buf = scoopMessageBuffers.get(jid);
    if (!buf) {
      buf = [];
      scoopMessageBuffers.set(jid, buf);
    }
    return buf;
  }

  /** Get the current (last) assistant message in a buffer, or create one. */
  function getOrCreateAssistantMsg(jid: string, channel?: string): ChatMessage {
    const buf = getBuffer(jid);
    let msgId = scoopCurrentMessageId.get(jid);
    if (msgId) {
      const existing = buf.find((m) => m.id === msgId);
      if (existing) return existing;
    }
    // Create new assistant message
    msgId = `scoop-${jid}-${uid()}`;
    scoopCurrentMessageId.set(jid, msgId);

    // Determine source based on jid
    const scoops = orchestrator.getScoops();
    const scoop = scoops.find((s) => s.jid === jid);
    const source = scoop?.isCone ? 'cone' : (scoop?.name ?? 'unknown');

    const msg: ChatMessage = {
      id: msgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      isStreaming: true,
      source,
      channel,
    };
    buf.push(msg);
    // Emit to UI if this is the selected scoop
    if (selectedScoop?.jid === jid) {
      emitToUI({ type: 'message_start', messageId: msgId });
    }
    return msg;
  }

  // Initialize the orchestrator (always — no direct agent mode)
  const orchestrator = new Orchestrator(layout.getIframeContainer(), {
    onResponse: (scoopJid, text, isPartial) => {
      // Always buffer
      const msg = getOrCreateAssistantMsg(scoopJid);
      if (isPartial) {
        msg.content += text;
      } else {
        msg.content = text;
        msg.isStreaming = false;
      }
      // Emit to UI if selected
      if (selectedScoop?.jid === scoopJid) {
        emitToUI({ type: 'content_delta', messageId: msg.id, text });
        if (!isPartial) {
          emitToUI({ type: 'content_done', messageId: msg.id });
        }
      }
    },
    onResponseDone: (scoopJid) => {
      // Per-turn: finalize message, clear ID so next turn creates a new one
      const buf = getBuffer(scoopJid);
      const msgId = scoopCurrentMessageId.get(scoopJid);
      if (msgId) {
        const msg = buf.find((m) => m.id === msgId);
        if (msg) msg.isStreaming = false;
        if (selectedScoop?.jid === scoopJid) {
          emitToUI({ type: 'content_done', messageId: msgId });
        }
        scoopCurrentMessageId.delete(scoopJid);
      }
    },
    onSendMessage: (targetJid, text) => {
      log.debug('Send message requested', { targetJid, textLength: text.length });
      const msgId = `msg-${uid()}`;
      const msg: ChannelMessage = {
        id: msgId,
        chatJid: targetJid,
        senderId: 'assistant',
        senderName: 'sliccy',
        content: text,
        timestamp: new Date().toISOString(),
        fromAssistant: true,
        channel: 'web',
      };
      orchestrator.handleMessage(msg);
      // Buffer as a system-like message for the source scoop
      const buf = getBuffer(targetJid);
      buf.push({ id: msgId, role: 'assistant', content: text, timestamp: Date.now() });
      if (selectedScoop?.jid === targetJid) {
        emitToUI({ type: 'message_start', messageId: msgId });
        emitToUI({ type: 'content_delta', messageId: msgId, text });
        emitToUI({ type: 'content_done', messageId: msgId });
      }
    },
    onStatusChange: (scoopJid, status) => {
      layout.panels.scoops.updateScoopStatus(scoopJid, status);
      layout.updateScoopSwitcherStatus?.(scoopJid, status);

      if (selectedScoop?.jid === scoopJid) {
        layout.setAgentProcessing(status === 'processing');
        if (status === 'processing') {
          layout.panels.chat.setProcessing(true);
        } else if (status === 'ready') {
          layout.panels.chat.setProcessing(false);
          const messageId = scoopCurrentMessageId.get(scoopJid) ?? `done-${scoopJid}-${uid()}`;
          scoopCurrentMessageId.delete(scoopJid);
          emitToUI({ type: 'turn_end', messageId });
        }
      }
    },
    onError: (scoopJid, error) => {
      log.error('Scoop error', { scoopJid, error });
      if (selectedScoop?.jid === scoopJid) {
        emitToUI({ type: 'error', error });
      }
    },
    getBrowserAPI: () => browser,
    onToolStart: (scoopJid, toolName, toolInput) => {
      // Hide infrastructure tools from the chat (their output is shown elsewhere)
      const hiddenTools = new Set(['send_message', 'list_scoops', 'list_tasks']);
      if (hiddenTools.has(toolName)) return;

      // Always buffer tool calls
      const msg = getOrCreateAssistantMsg(scoopJid);
      if (!msg.toolCalls) msg.toolCalls = [];
      msg.toolCalls.push({ id: uid(), name: toolName, input: toolInput });
      // Emit to UI if selected
      if (selectedScoop?.jid === scoopJid) {
        emitToUI({ type: 'tool_use_start', messageId: msg.id, toolName, toolInput });
      }
    },
    onToolEnd: (scoopJid, toolName, result, isError) => {
      const hiddenTools = new Set(['send_message', 'list_scoops', 'list_tasks']);
      if (hiddenTools.has(toolName)) return;

      // Always buffer tool results
      const buf = getBuffer(scoopJid);
      const msgId = scoopCurrentMessageId.get(scoopJid);
      if (msgId) {
        const msg = buf.find((m) => m.id === msgId);
        if (msg?.toolCalls) {
          const tc = [...msg.toolCalls]
            .reverse()
            .find((t) => t.name === toolName && t.result === undefined);
          if (tc) {
            tc.result = result;
            tc.isError = isError;
          }
        }
      }
      // Emit to UI if selected
      if (selectedScoop?.jid === scoopJid && msgId) {
        emitToUI({ type: 'tool_result', messageId: msgId, toolName, result, isError });
      }
    },
    onToolUI: (scoopJid, toolName, requestId, html) => {
      // Emit tool UI request to chat panel
      // Always emit regardless of selection - the chat panel handles missing messages with retries
      // and this prevents tool UI from hanging when a scoop is not selected
      const msgId = scoopCurrentMessageId.get(scoopJid);
      if (msgId) {
        emitToUI({ type: 'tool_ui', messageId: msgId, toolName, requestId, html });
      } else {
        log.warn('Cannot emit tool_ui - no message ID for scoop', { scoopJid, requestId });
      }
    },
    onToolUIDone: (scoopJid, requestId) => {
      // Always emit to ensure renderers are disposed, regardless of selection
      const msgId = scoopCurrentMessageId.get(scoopJid);
      if (msgId) {
        emitToUI({ type: 'tool_ui_done', messageId: msgId, requestId });
      }
    },
    onIncomingMessage: (scoopJid, message) => {
      // Scoop lifecycle licks (scoop-notify / scoop-idle) get the same
      // lick widget treatment as webhook/cron events so the user can
      // see scoop completions in the cone's chat. Also goes through
      // addLickMessage/persistLickToSession rather than the agent-event
      // stream so it doesn't collide with a concurrent cone turn.
      if (isLickChannel(message.channel)) {
        const lickTs = new Date(message.timestamp).getTime();
        const channel = message.channel as LickChannel;
        getBuffer(scoopJid).push({
          id: message.id,
          role: 'user',
          content: message.content,
          timestamp: lickTs,
          source: 'lick',
          channel,
        });
        if (selectedScoop?.jid === scoopJid) {
          layout.panels.chat.addLickMessage(message.id, message.content, channel, lickTs);
        } else {
          const target = orchestrator.getScoops().find((s) => s.jid === scoopJid);
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

      // Buffer incoming messages (delegations, etc.) for display
      const chatMsg: ChatMessage = {
        id: message.id,
        role: 'user',
        content:
          message.channel === 'delegation'
            ? `**[Instructions from sliccy]**\n\n${message.content}`
            : message.content,
        attachments: message.attachments,
        timestamp: new Date(message.timestamp).getTime(),
        source: message.channel === 'delegation' ? 'delegation' : undefined,
        channel: message.channel,
      };
      getBuffer(scoopJid).push(chatMsg);

      // Emit to UI if this scoop is selected
      if (selectedScoop?.jid === scoopJid) {
        emitToUI({ type: 'message_start', messageId: message.id });
        emitToUI({ type: 'content_delta', messageId: message.id, text: chatMsg.content });
        emitToUI({ type: 'content_done', messageId: message.id });
      }
    },
  });

  await orchestrator.init();
  layout.panels.scoops.setOrchestrator(orchestrator);
  layout.panels.memory.setOrchestrator(orchestrator);
  layout.setScoopSwitcherOrchestrator?.(orchestrator);

  // Publish the AgentBridge on globalThis.__slicc_agent so the `agent`
  // supplemental shell command can spawn sub-scoops from any bash
  // invocation (terminal panel OR a scoop's bash tool). Must happen AFTER
  // orchestrator.init() resolves so sharedFs is available, and BEFORE any
  // WasmShell registers its supplemental commands.
  {
    const sharedFs = orchestrator.getSharedFS();
    if (sharedFs) {
      publishAgentBridge(orchestrator, sharedFs, orchestrator.getSessionStore());
    } else {
      log.warn('AgentBridge not published — orchestrator.getSharedFS() returned null');
    }
  }

  // Wire shared FS to file browser and terminal
  const sharedFs = orchestrator.getSharedFS();
  if (sharedFs) {
    layout.panels.fileBrowser.setFs(sharedFs);
    log.info('File browser wired to shared VFS');

    // Listen for preview SW file-read requests (falls back here for mounted dirs).
    // Uses BroadcastChannel because the SW's `/preview/` scope excludes this page.
    const previewVfsCh = new BroadcastChannel('preview-vfs');
    previewVfsCh.onmessage = (event) => {
      if (event.data?.type !== 'preview-vfs-read') return;
      const { id, path, asText } = event.data;
      (async () => {
        try {
          const encoding = asText ? 'utf-8' : 'binary';
          const content = await sharedFs.readFile(path, { encoding });
          previewVfsCh.postMessage({ type: 'preview-vfs-response', id, content });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!errMsg.includes('ENOENT')) {
            log.error('Preview VFS read failed', { path, error: errMsg });
          }
          previewVfsCh.postMessage({ type: 'preview-vfs-response', id, error: errMsg });
        }
      })();
    };

    registerSkillDropInstall(
      sharedFs,
      (message, kind) => {
        if (kind === 'error') {
          log.warn('Dropped skill install failed', { message });
        } else {
          log.info('Dropped skill installed', { message });
        }
        showSkillDropToast(message, kind);
      },
      async () => {
        await layout.panels.fileBrowser.refresh();
      },
      (files) => layout.panels.chat.addAttachmentsFromFiles(files)
    );

    try {
      const { WasmShell } = await import('../shell/index.js');
      const { fetchSecretEnvVars } = await import('../core/secret-env.js');
      const secretEnv = await fetchSecretEnvVars();
      const shell = new WasmShell({
        fs: sharedFs,
        browserAPI: browser,
        env: Object.keys(secretEnv).length > 0 ? secretEnv : undefined,
      });
      await layout.panels.terminal.mountShell(shell);
      log.info('Terminal mounted with shared VFS');

      // Start BSH navigation watchdog — auto-executes .bsh scripts on matching navigations
      try {
        const { BshWatchdog } = await import('../shell/bsh-watchdog.js');
        const bshWatchdog = new BshWatchdog({
          browserAPI: browser,
          scriptCatalog: shell.getScriptCatalog(),
          fs: sharedFs,
        });
        void bshWatchdog.start();
        window.addEventListener('beforeunload', () => bshWatchdog.stop(), { once: true });
        log.info('BSH navigation watchdog started');
      } catch (e) {
        log.warn('Failed to start BSH watchdog', e);
      }
    } catch (e) {
      log.warn('Failed to mount shell to terminal', e);
    }
  }

  // Create cone if it doesn't exist
  const allScoops = orchestrator.getScoops();
  const hasCone = allScoops.some((s) => s.isCone);
  if (allowProviderlessTrayJoin) {
    log.info('Skipping local cone bootstrap while joining a tray without a configured provider');
  } else if (!hasCone) {
    const cone = await layout.panels.scoops.createCone();
    selectedScoop = cone;
    log.info('Created cone');
  } else {
    // Check URL for selected scoop
    const urlParams = new URLSearchParams(window.location.search);
    const scoopFolder = urlParams.get('scoop');
    if (scoopFolder) {
      const urlScoop = allScoops.find((s) => s.folder === scoopFolder);
      if (urlScoop) {
        selectedScoop = urlScoop;
        log.info('Restored scoop from URL', { folder: scoopFolder });
      } else {
        selectedScoop = allScoops.find((s) => s.isCone) ?? allScoops[0];
      }
    } else {
      selectedScoop = allScoops.find((s) => s.isCone) ?? allScoops[0];
    }
  }

  // Set initial scoop for memory panel and trigger scoop select
  if (selectedScoop) {
    layout.panels.memory.setSelectedScoop(selectedScoop.jid);
  }

  // Mutable reference to leader sync — set when tray leader mode is active.
  // Used by coneAgentHandle to broadcast user messages to followers.
  let leaderSyncRef: LeaderSyncManager | null = null;

  // Build the cone agent handle — all user input routes through orchestrator
  const coneAgentHandle: AgentHandle = {
    sendMessage(text: string, messageId?: string, attachments?: MessageAttachment[]): void {
      if (!selectedScoop) {
        emitToUI({ type: 'error', error: 'No scoop selected' });
        return;
      }

      const msg: ChannelMessage = {
        id: messageId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatJid: selectedScoop.jid,
        senderId: 'user',
        senderName: 'User',
        content: text,
        attachments,
        timestamp: new Date().toISOString(),
        fromAssistant: false,
        channel: 'web',
      };

      // Buffer the user message for this scoop
      getBuffer(selectedScoop.jid).push({
        id: msg.id,
        role: 'user',
        content: text,
        attachments,
        timestamp: Date.now(),
      });

      // Broadcast user message to all followers (leader mode)
      leaderSyncRef?.broadcastUserMessage(text, msg.id, attachments);

      orchestrator.handleMessage(msg);
      orchestrator.createScoopTab(selectedScoop.jid);
    },

    onEvent(callback: (event: UIAgentEvent) => void): () => void {
      eventListeners.add(callback);
      return () => eventListeners.delete(callback);
    },

    stop(): void {
      if (selectedScoop) {
        orchestrator.stopScoop(selectedScoop.jid);
        // Clear queued messages from orchestrator so they don't get processed later
        orchestrator.clearQueuedMessages(selectedScoop.jid).catch((err) => {
          log.error('Failed to clear queued messages on stop', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    },
  };

  layout.panels.chat.setAgent(coneAgentHandle);

  // Off-load oversized attachments to /tmp on the orchestrator's VFS so
  // the agent can `read_file`/`cat` them instead of inlining the whole
  // payload in the prompt.
  if (sharedFs) {
    layout.panels.chat.setAttachmentWriter(createAttachmentTmpWriter(sharedFs));
  }

  // Wire delete callback for queued messages
  layout.panels.chat.setDeleteQueuedMessageCallback((messageId: string) => {
    if (selectedScoop) {
      orchestrator.deleteQueuedMessage(selectedScoop.jid, messageId).catch((err) => {
        log.error('Failed to delete queued message', {
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // Also remove from the in-memory message buffer so it doesn't reappear on scoop switch
      const buf = scoopMessageBuffers.get(selectedScoop.jid);
      if (buf) {
        const idx = buf.findIndex((m) => m.id === messageId);
        if (idx !== -1) buf.splice(idx, 1);
      }
    }
  });

  log.info('Cone agent handle wired to chat UI');

  // ---------------------------------------------------------------------------
  // Lick system — WebSocket for webhooks/crontasks (all logic runs in browser)
  // ---------------------------------------------------------------------------
  // Extension mode returns earlier, so this path is standalone/electron-overlay only.
  // Initialize lick manager
  const { getLickManager } = await import('../scoops/lick-manager.js');
  const lickManager = getLickManager();
  await lickManager.init();
  orchestrator.setLickManager(lickManager);

  // Route lick events to scoops
  const routeLickToScoop = (event: LickEvent) => {
    const isWebhook = event.type === 'webhook';
    const isSprinkle = event.type === 'sprinkle';
    const isFsWatch = event.type === 'fswatch';
    const isSessionReload = event.type === 'session-reload';
    const isNavigate = event.type === 'navigate';
    const isUpgrade = event.type === 'upgrade';
    const eventName = isWebhook
      ? event.webhookName
      : isSprinkle
        ? event.sprinkleName
        : isFsWatch
          ? event.fswatchName
          : isSessionReload
            ? 'session-reload'
            : isNavigate
              ? event.navigateUrl
              : isUpgrade
                ? `${event.upgradeFromVersion ?? 'unknown'}\u2192${event.upgradeToVersion ?? 'unknown'}`
                : event.cronName;
    const eventId = isWebhook
      ? event.webhookId
      : isSprinkle
        ? event.sprinkleName
        : isFsWatch
          ? event.fswatchId
          : isSessionReload
            ? 'session-reload'
            : isNavigate
              ? event.navigateUrl
              : isUpgrade
                ? `upgrade-${event.upgradeToVersion ?? 'unknown'}`
                : event.cronId;
    const channel = event.type;

    log.debug('Lick event', { type: event.type, name: eventName, targetScoop: event.targetScoop });

    // Handle welcome sprinkle lifecycle events
    if (isSprinkle && event.sprinkleName === 'welcome') {
      const body = event.body as Record<string, unknown> | null;
      const action = body?.action;
      if (action === 'onboarding-complete' || action === 'shortcut-migrate') {
        void sharedFs
          ?.writeFile('/shared/.welcomed', '1')
          .catch((err) => log.warn('Failed to persist welcome marker', err));
      }
      if (action === 'shortcut-migrate') {
        sprinkleManager?.close('welcome');
      }
      // Perform the actual mount if user selected a folder during onboarding
      if (
        action === 'onboarding-complete' &&
        (body?.data as Record<string, unknown> | undefined)?.mountWorkspace &&
        sharedFs
      ) {
        applyPendingMount(sharedFs).catch((err) =>
          log.warn('Failed to mount workspace from onboarding', err)
        );
      }
    }

    // Handle request-mount from welcome sprinkle (fallback if direct picker fails)
    if (
      isSprinkle &&
      event.sprinkleName === 'welcome' &&
      (event.body as Record<string, unknown> | null)?.action === 'request-mount'
    ) {
      (async () => {
        try {
          const w = window as Window & {
            showDirectoryPicker?: (
              opts: Record<string, unknown>
            ) => Promise<FileSystemDirectoryHandle>;
          };
          if (!w.showDirectoryPicker) throw new Error('showDirectoryPicker not supported');
          const handle = await w.showDirectoryPicker({ mode: 'readwrite' });
          await storePendingMount(handle);
          sprinkleManager?.sendToSprinkle('welcome', {
            action: 'mount-complete',
            dirName: handle.name,
          });
        } catch (err: unknown) {
          if ((err as { name?: string }).name !== 'AbortError') {
            log.warn('Mount picker failed', err);
          }
          sprinkleManager?.sendToSprinkle('welcome', { action: 'mount-cancelled' });
        }
      })();
      return; // Don't forward to orchestrator
    }

    // Determine the target:
    // - Events with explicit targetScoop route to that scoop
    // - Untargeted events default to cone
    const scoops = orchestrator.getScoops();
    let resolvedTarget: RegisteredScoop | undefined;

    if (!event.targetScoop) {
      // Untargeted events → cone
      resolvedTarget = scoops.find((s) => s.isCone);
    } else {
      resolvedTarget = scoops.find(
        (s) =>
          s.name === event.targetScoop ||
          s.folder === event.targetScoop ||
          s.folder === `${event.targetScoop}-scoop`
      );
    }

    if (resolvedTarget) {
      const msgId = `${channel}-${eventId}-${Date.now()}`;
      const eventLabel = isWebhook
        ? 'Webhook Event'
        : isSprinkle
          ? 'Sprinkle Event'
          : isFsWatch
            ? 'File Watch Event'
            : isSessionReload
              ? 'Session Reload'
              : isNavigate
                ? 'Navigate Event'
                : isUpgrade
                  ? 'Upgrade Event'
                  : 'Cron Event';
      let content: string | null = null;
      if (isSessionReload) {
        const body = event.body as
          | {
              reason?: string;
              mounts?: Array<{ path: string; dirName: string }>;
            }
          | null
          | undefined;
        if (body?.reason === 'mount-recovery') {
          content = formatMountRecoveryPrompt(body.mounts ?? []);
          if (content === null) {
            // Nothing actually needs recovery — drop the lick instead of
            // pestering the cone with an empty notification.
            log.debug('Dropping session-reload lick with empty mount-recovery list');
            return;
          }
        }
      }
      if (isUpgrade) {
        const from = event.upgradeFromVersion ?? 'unknown';
        const to = event.upgradeToVersion ?? 'unknown';
        const releasedAt =
          (event.body as { releasedAt?: string | null } | null | undefined)?.releasedAt ?? null;
        const releaseLine = releasedAt ? `\nReleased: ${releasedAt}` : '';
        content =
          `[${eventLabel}: ${from}\u2192${to}]\n\n` +
          `SLICC was upgraded from \`${from}\` to \`${to}\`.${releaseLine}\n\n` +
          `Use the **upgrade** skill (\`/workspace/skills/upgrade/SKILL.md\`) to:\n` +
          `- Show the user the changelog between these tags from GitHub\n` +
          `- Offer to merge new bundled vfs-root content into their workspace ` +
          `(three-way merge: bundled snapshot vs user's VFS, reconciled with the GitHub tag-to-tag diff).`;
      }
      if (content === null) {
        content = `[${eventLabel}: ${eventName}]\n\`\`\`json\n${JSON.stringify(event.body, null, 2)}\n\`\`\``;
      }

      const msg: ChannelMessage = {
        id: msgId,
        chatJid: resolvedTarget.jid,
        senderId: channel,
        senderName: `${channel}:${eventName}`,
        content,
        timestamp: event.timestamp,
        fromAssistant: false,
        channel,
      };

      const lickTs = Date.now();
      getBuffer(resolvedTarget.jid).push({
        id: msgId,
        role: 'user',
        content,
        timestamp: lickTs,
        source: 'lick',
        channel,
      });

      if (selectedScoop?.jid === resolvedTarget.jid) {
        layout.panels.chat.addLickMessage(msgId, content, channel, lickTs);
      } else {
        // Non-selected target: persist directly to the target scoop's
        // SessionStore so a reload's first-select can render this lick
        // as a lick widget (not a plain user bubble from the DB fallback).
        const targetSessionId = resolvedTarget.isCone
          ? 'session-cone'
          : `session-${resolvedTarget.folder}`;
        void layout.panels.chat.persistLickToSession(targetSessionId, {
          id: msgId,
          content,
          channel,
          timestamp: lickTs,
        });
      }

      log.info('Routing lick to scoop', {
        type: channel,
        name: eventName,
        scoopJid: resolvedTarget.jid,
      });
      orchestrator.handleMessage(msg);
    } else {
      log.warn('Lick target scoop not found', { targetScoop: event.targetScoop });
    }
  };

  lickManager.setEventHandler(routeLickToScoop);

  // ── Navigation watcher: emit 'navigate' licks for main-frame responses
  // that carry an x-slicc header. ──────────────────────────────────────
  const navigationWatcher = new NavigationWatcher(browser.getTransport(), (navEvent) => {
    lickManager.emitEvent({
      type: 'navigate',
      navigateUrl: navEvent.url,
      targetScoop: undefined,
      timestamp: new Date().toISOString(),
      body: {
        url: navEvent.url,
        sliccHeader: navEvent.sliccHeader,
        title: navEvent.title,
      },
    });
  });
  (async () => {
    try {
      await browser.connect();
      await navigationWatcher.start();
      log.info('Navigation watcher started');
    } catch (err) {
      log.warn('Failed to start navigation watcher', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  // ── Restore persisted mounts from IndexedDB ──────────────────────────
  // See `fs/mount-recovery.ts` for why some reloads require recovery and
  // some don't (short version: Chrome only retains readwrite permission
  // within a tab's active session, so a full restart drops every handle
  // back to `prompt`). The `session-reload` lick is only emitted when at
  // least one handle actually needs re-authorization.
  if (sharedFs) {
    getAllMountEntries()
      .then(async (entries) => {
        if (entries.length === 0) return;
        const { needsRecovery } = await recoverMounts(entries, sharedFs, log);
        if (needsRecovery.length === 0) return;
        const event: LickEvent = {
          type: 'session-reload',
          targetScoop: undefined,
          timestamp: new Date().toISOString(),
          body: { reason: 'mount-recovery', mounts: needsRecovery },
        };
        routeLickToScoop(event);
      })
      .catch((err) => log.warn('Failed to restore persisted mounts', err));
  }

  // ── Upgrade detection ────────────────────────────────────────────────
  // Compares the bundled SLICC version (baked into /shared/version.json
  // at release time) against the value last seen on a previous boot and
  // emits an `upgrade` lick when it bumped. The detection helper records
  // the new version itself; we just route the event.
  if (sharedFs) {
    detectUpgrade(sharedFs)
      .then((result) => {
        if (!result.isUpgrade || result.lastSeen === null) return;
        const event: LickEvent = {
          type: 'upgrade',
          targetScoop: undefined,
          timestamp: new Date().toISOString(),
          upgradeFromVersion: result.lastSeen,
          upgradeToVersion: result.bundled.version,
          body: {
            from: result.lastSeen,
            to: result.bundled.version,
            releasedAt: result.bundled.releasedAt,
          },
        };
        routeLickToScoop(event);
      })
      .catch((err) => log.warn('Upgrade detection failed', err));
  }

  // Wire inline sprinkle lick callback — routes to cone as a sprinkle lick event
  layout.panels.chat.onInlineSprinkleLick = (action: string, data: unknown) => {
    const event: LickEvent = {
      type: 'sprinkle',
      sprinkleName: 'inline',
      targetScoop: undefined,
      timestamp: new Date().toISOString(),
      body: { action, data },
    };
    routeLickToScoop(event);
  };

  // ── Sprinkle Manager (SHTML sprinkle panels) ────────────────────────
  let sprinkleManager: SprinkleManager | null = null;
  if (sharedFs) {
    sprinkleManager = new SprinkleManager(
      sharedFs,
      routeLickToScoop,
      {
        addSprinkle: (name, title, element, zone) =>
          layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined),
        removeSprinkle: (name) => layout.removeSprinkle(name),
      },
      () => {
        const cone = orchestrator.getScoops().find((s) => s.isCone);
        if (cone) {
          orchestrator.stopScoop(cone.jid);
          orchestrator.clearQueuedMessages(cone.jid).catch((err) => {
            log.error('Failed to clear queued messages on sprinkle stopCone', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    );
    // Expose for open command, sprinkle shell command, and E2E/demo scripts
    (window as unknown as Record<string, unknown>).__slicc_sprinkleManager = sprinkleManager;
    (window as unknown as Record<string, unknown>).__slicc_reloadSkills = () =>
      orchestrator.reloadAllSkills();
    if (__DEV__) (window as unknown as Record<string, unknown>).__slicc_orchestrator = orchestrator;

    await sprinkleManager.refresh();
    layout.onSprinkleClose = (name) => sprinkleManager!.close(name);

    // Wire [+] picker: available sprinkles + open callback
    layout.getAvailableSprinkles = () => {
      const opened = new Set(sprinkleManager!.opened());
      return sprinkleManager!
        .available()
        .filter((p) => !opened.has(p.name))
        .map((p) => ({ name: p.name, title: p.title }));
    };
    layout.onOpenSprinkle = (name, zone) => sprinkleManager!.open(name, zone);
    layout.updateAddButtons();

    // Migrate legacy localStorage flag to VFS marker
    if (!(await sharedFs.exists('/shared/.welcomed')) && localStorage.getItem('slicc-welcomed')) {
      await sharedFs.writeFile('/shared/.welcomed', '1').catch(() => {});
      localStorage.removeItem('slicc-welcomed');
    }

    // Open welcome sprinkle on first run (flag set when onboarding-complete lick fires)
    if (
      !(await sharedFs.exists('/shared/.welcomed')) &&
      !allowProviderlessTrayJoin &&
      sprinkleManager.available().some((p) => p.name === 'welcome')
    ) {
      try {
        await sprinkleManager.open('welcome');
      } catch (e) {
        log.warn('Failed to open welcome sprinkle', e);
      }
    }

    await sprinkleManager.restoreOpenSprinkles();
    log.info('SprinkleManager initialized');
  }

  // Connect WebSocket for server communication
  const connectLickWs = () => {
    const wsUrl = getLickWebSocketUrl(window.location.href);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      log.info('Lick WebSocket connected');
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type: string;
          requestId?: string;
          [key: string]: unknown;
        };

        // Handle management requests from server
        if (data.requestId) {
          let response: { type: string; requestId: string; data?: unknown; error?: string };

          try {
            switch (data.type) {
              case 'list_webhooks':
                response = {
                  type: 'response',
                  requestId: data.requestId,
                  data: lickManager.listWebhooks(),
                };
                break;
              case 'create_webhook': {
                const wh = await lickManager.createWebhook(
                  (data.name as string) || 'default',
                  data.scoop as string | undefined,
                  data.filter as string | undefined
                );
                const traySession = getLeaderTrayRuntimeStatus().session;
                const webhookUrl = traySession?.webhookUrl
                  ? getTrayWebhookUrl(traySession.webhookUrl, wh.id)
                  : getWebhookUrl(window.location.href, wh.id);
                response = {
                  type: 'response',
                  requestId: data.requestId,
                  data: { ...wh, url: webhookUrl },
                };
                break;
              }
              case 'delete_webhook': {
                const ok = await lickManager.deleteWebhook(data.id as string);
                response = ok
                  ? { type: 'response', requestId: data.requestId, data: { ok: true } }
                  : {
                      type: 'response',
                      requestId: data.requestId,
                      data: { error: 'Webhook not found' },
                    };
                break;
              }
              case 'list_crontasks':
                response = {
                  type: 'response',
                  requestId: data.requestId,
                  data: lickManager.listCronTasks(),
                };
                break;
              case 'create_crontask': {
                if (!data.name) throw new Error('name is required');
                if (!data.cron) throw new Error('cron is required');
                const ct = await lickManager.createCronTask(
                  data.name as string,
                  data.cron as string,
                  data.scoop as string | undefined,
                  data.filter as string | undefined
                );
                response = { type: 'response', requestId: data.requestId, data: ct };
                break;
              }
              case 'delete_crontask': {
                const ok = await lickManager.deleteCronTask(data.id as string);
                response = ok
                  ? { type: 'response', requestId: data.requestId, data: { ok: true } }
                  : {
                      type: 'response',
                      requestId: data.requestId,
                      data: { error: 'Cron task not found' },
                    };
                break;
              }
              case 'tray_status': {
                const leaderStatus = getLeaderTrayRuntimeStatus();
                response = {
                  type: 'response',
                  requestId: data.requestId,
                  data: {
                    state: leaderStatus.state,
                    joinUrl: leaderStatus.session?.joinUrl ?? null,
                    workerBaseUrl: leaderStatus.session?.workerBaseUrl ?? null,
                    trayId: leaderStatus.session?.trayId ?? null,
                  },
                };
                break;
              }
              default:
                response = {
                  type: 'response',
                  requestId: data.requestId,
                  error: `Unknown request type: ${data.type}`,
                };
            }
          } catch (err) {
            response = {
              type: 'response',
              requestId: data.requestId,
              error: err instanceof Error ? err.message : String(err),
            };
          }

          ws.send(JSON.stringify(response));
          return;
        }

        // Handle incoming webhook events from server
        if (data.type === 'webhook_event') {
          lickManager.handleWebhookEvent(
            data.webhookId as string,
            data.headers as Record<string, string>,
            data.body
          );
        }

        // Handle handoffs injected via POST /api/handoff. This is the
        // profile-independent fallback: the CDP navigation-watcher only
        // sees tabs in the SLICC-controlled Chrome profile, so external
        // tools running elsewhere post here instead.
        if (data.type === 'navigate_event') {
          const sliccHeader = typeof data.sliccHeader === 'string' ? data.sliccHeader : '';
          const navUrl = typeof data.url === 'string' && data.url.length > 0 ? data.url : '';
          if (sliccHeader && navUrl) {
            lickManager.emitEvent({
              type: 'navigate',
              navigateUrl: navUrl,
              targetScoop: undefined,
              timestamp:
                typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
              body: {
                url: navUrl,
                sliccHeader,
                title: typeof data.title === 'string' ? data.title : undefined,
              },
            });
          }
        }
      } catch (err) {
        log.error('Failed to process lick message', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    ws.onclose = () => {
      log.warn('Lick WebSocket disconnected, reconnecting in 3s...');
      setTimeout(connectLickWs, 3000);
    };

    ws.onerror = (err) => {
      log.error('Lick WebSocket error', { error: String(err) });
    };
  };

  connectLickWs();

  // Wire model picker changes
  layout.onModelChange = (modelId) => {
    localStorage.setItem('selected-model', modelId);
    // Immediately update all active agent contexts to use the new model
    orchestrator.updateModel();
  };

  // Track which scoops have been selected at least once this runtime.
  // The first select per scoop must load from SessionStore — the in-memory
  // buffer may contain boot-time lick events (e.g. mount-recovery from PR #325)
  // pushed before the UI rendered, and loadMessages(buffer) would wipe the
  // restored history by replacing this.messages with just the lick.
  const selectedOnceThisRuntime = new Set<string>();

  // Wire clear chat to also clear orchestrator messages + buffers
  layout.onClearChat = async () => {
    await orchestrator.clearAllMessages();
    scoopMessageBuffers.clear();
    selectedOnceThisRuntime.clear();
  };

  layout.onClearFilesystem = async () => {
    await orchestrator.resetFilesystem();
  };

  // Wire scoop selection
  const handleScoopSelect = async (scoop: RegisteredScoop) => {
    log.info('Scoop selected', { jid: scoop.jid, name: scoop.name });
    selectedScoop = scoop;
    orchestrator.createScoopTab(scoop.jid);

    // Update memory panel and scoops panel selection
    layout.panels.memory.setSelectedScoop(scoop.jid);
    layout.panels.scoops.setSelectedJid(scoop.jid);

    // Switch chat context.
    // - First select per scoop (this runtime): load from SessionStore, then
    //   fall back to orchestrator DB. The in-memory buffer is ignored here
    //   because boot-time licks pushed to it before the UI rendered, and
    //   loadMessages(buffer) would replace restored history with just the lick.
    // - Subsequent selects: prefer the buffer, which carries transient detail
    //   (screenshots, streamed tool calls) not in SessionStore.
    const contextId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
    const buffer = scoopMessageBuffers.get(scoop.jid);
    const isFirstSelect = !selectedOnceThisRuntime.has(scoop.jid);

    // Pass scoop name for non-cone contexts
    const scoopName = scoop.isCone ? undefined : scoop.name;

    if (!isFirstSelect && buffer && buffer.length > 0) {
      // Mid-session switch: the buffer carries transient detail (screenshots)
      // not in SessionStore, so prefer it over the persisted view. The buffer
      // was seeded with the canonical history on first-select, so it contains
      // prior-runtime messages in addition to runtime-only events.
      await layout.panels.chat.switchToContext(contextId, !scoop.isCone, scoopName);
      layout.panels.chat.loadMessages(buffer);
    } else {
      // First select, or no buffer — load from SessionStore (persisted from
      // previous sessions), then fall back to orchestrator DB if nothing there.
      await layout.panels.chat.switchToContext(contextId, !scoop.isCone, scoopName);

      // If still empty, fall back to orchestrator DB (simple text, no tool calls)
      if (layout.panels.chat.getMessages().length === 0) {
        const messages = await orchestrator.getMessagesForScoop(scoop.jid);
        for (const msg of messages) {
          // Determine the proper role and source for display
          const isDelegation = msg.channel === 'delegation';

          if (isLickChannel(msg.channel)) {
            // Preserve lick metadata (source/channel/timestamp) so the chat
            // renders licks as their distinctive collapsible widget instead
            // of a plain "You" bubble. Covers every lick channel, including
            // sprinkle/navigate/fswatch/session-reload.
            layout.panels.chat.addLickMessage(
              msg.id,
              msg.content,
              msg.channel,
              new Date(msg.timestamp).getTime()
            );
          } else if (isDelegation) {
            // Delegation from cone - show as incoming instructions
            layout.panels.chat.addUserMessage(`**[Instructions from sliccy]**\n\n${msg.content}`);
          } else if (msg.fromAssistant) {
            // Scoop's own response
            emitToUI({ type: 'message_start', messageId: msg.id });
            emitToUI({ type: 'content_delta', messageId: msg.id, text: msg.content });
            emitToUI({ type: 'content_done', messageId: msg.id });
          } else {
            layout.panels.chat.addUserMessage(msg.content);
          }
        }
      }

      // Merge the canonical view with any runtime-only buffer entries.
      //
      // Context: the buffer accumulates orchestrator events (streamed content,
      // tool calls, delegations, licks) regardless of whether this scoop was
      // selected. For scoops the cone delegates to, the buffer can hold rich
      // transient detail (including tool-call results with screenshots) that
      // was never written to SessionStore — we don't want to drop it on the
      // first open.
      //
      // At the same time, a later switch back to this scoop will take the
      // buffer branch above and call loadMessages(buffer), which replaces
      // this.messages wholesale. So the buffer needs to carry the full
      // history too, not just what arrived during this runtime.
      //
      // Solution: rebuild the buffer as [canonical + runtime-only entries],
      // deduped by id. If there were runtime-only entries, also surface them
      // in the chat view now so the first open isn't missing them.
      const canonical = layout.panels.chat.getMessages();
      const canonicalIds = new Set(canonical.map((m) => m.id));
      const buf = getBuffer(scoop.jid);
      const runtimeOnly = buf.filter((m) => !canonicalIds.has(m.id));
      buf.length = 0;
      buf.push(...canonical, ...runtimeOnly);
      if (runtimeOnly.length > 0) {
        layout.panels.chat.loadMessages(buf);
      }
    }

    // If switching back to cone and it's currently processing (e.g., handling
    // a scoop notification), re-lock the input. switchToContext resets streaming
    // state, but we need to reflect the cone's actual status.
    if (scoop.isCone && orchestrator.isProcessing(scoop.jid)) {
      layout.panels.chat.setProcessing(true);
    }

    selectedOnceThisRuntime.add(scoop.jid);
  };

  layout.onScoopSelect = handleScoopSelect;

  // Initialize the selected scoop's tab and trigger initial load
  if (selectedScoop) {
    orchestrator.createScoopTab(selectedScoop.jid);
    // Trigger scoop select to properly load the chat context
    await handleScoopSelect(selectedScoop);
  }

  // `?ui-fixture=1` — design-time override: replace the live chat context
  // with a synthetic session covering every message UI variant. Runs after
  // the normal scoop select so real scoops stay listed in the sidebar and
  // clicking one cleanly exits fixture mode.
  if (isUIFixtureRequested()) {
    await loadUIFixtureIntoChat(layout.panels.chat);
  }

  if (runtimeMode === 'standalone' || runtimeMode === 'electron-overlay') {
    const runtimeConfig = await fetchRuntimeConfig();
    const runtimeDefaultWorkerBaseUrl = shouldUseRuntimeModeTrayDefaults(
      runtimeMode,
      runtimeConfig !== null
    )
      ? __DEV__
        ? DEFAULT_STAGING_TRAY_WORKER_BASE_URL
        : DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL
      : null;

    const trayRuntimeConfig = await resolveTrayRuntimeConfig({
      locationHref: window.location.href,
      storage: window.localStorage,
      envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
      defaultWorkerBaseUrl: runtimeDefaultWorkerBaseUrl,
      runtimeConfigFetcher: async () => runtimeConfig,
    });

    // Start follower join from a joinUrl. Reusable — called at startup
    // and when the user pastes a join URL in the settings dialog.
    let activeFollowerSync: FollowerSyncManager | null = null;
    let activeReconnectHandle: FollowerAutoReconnectHandle | null = null;
    let followerTargetRefreshInterval: ReturnType<typeof setInterval> | null = null;

    // Wire rsync sendFsRequest — picks whichever sync manager is active (leader or follower)
    setRsyncSendFsRequest(() => {
      if (leaderSyncRef) return (rid, req) => leaderSyncRef!.sendFsRequest(rid, req);
      if (activeFollowerSync) return (rid, req) => activeFollowerSync!.sendFsRequest(rid, req);
      return null;
    });

    // Wire playwright teleport command callbacks
    setPlaywrightTeleportBestFollower(() => {
      if (leaderSyncRef) return () => leaderSyncRef!.getBestFollowerForTeleport();
      return null;
    });
    setPlaywrightTeleportConnectedFollowers(() => {
      if (leaderSyncRef) return () => leaderSyncRef!.getConnectedFollowers();
      return null;
    });

    const wireFollowerSync = (
      connection: import('../scoops/tray-webrtc.js').FollowerTrayConnection
    ) => {
      // Clean up previous sync if any
      if (followerTargetRefreshInterval) {
        clearInterval(followerTargetRefreshInterval);
        followerTargetRefreshInterval = null;
      }
      activeFollowerSync?.close();

      const runtimeId = `follower-${connection.bootstrapId}`;
      const followerSync = new FollowerSyncManager(connection.channel, {
        browserTransport: browser.getTransport(),
        browserAPI: browser,
        onSnapshot: (messages) => {
          layout.panels.chat.loadMessages(messages);
        },
        onUserMessage: (text, _messageId, _scoopJid, attachments) => {
          layout.panels.chat.addUserMessage(text, attachments);
        },
        onStatus: (status) => {
          layout.panels.chat.setProcessing(status === 'processing');
        },
        onTargetsChanged: () => void refreshFollowerTargets(),
      });
      activeFollowerSync = followerSync;
      browser.setTrayTargetProvider(followerSync);
      layout.panels.chat.setAgent(followerSync);
      followerSync.requestSnapshot();

      const refreshFollowerTargets = async () => {
        try {
          const pages = await browser.listPages();
          followerSync.advertiseTargets(
            pages.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url })),
            runtimeId
          );
        } catch {
          /* ignore errors */
        }
      };
      followerTargetRefreshInterval = setInterval(refreshFollowerTargets, 5000);
      void refreshFollowerTargets();

      log.info('Follower sync wired to chat panel', { trayId: connection.trayId });
    };

    const startFollowerJoin = (joinUrl: string) => {
      // Cancel any existing reconnect loop / follower
      activeReconnectHandle?.cancel();
      if (followerTargetRefreshInterval) {
        clearInterval(followerTargetRefreshInterval);
        followerTargetRefreshInterval = null;
      }
      activeFollowerSync?.close();
      activeFollowerSync = null;

      activeReconnectHandle = startFollowerWithAutoReconnect(
        {
          joinUrl,
          runtime: 'slicc-standalone',
          fetchImpl: createTrayFetch(),
        },
        {
          onConnected: (connection) => wireFollowerSync(connection),
          onReconnecting: (attempt) => {
            log.info('Follower reconnecting', { attempt });
          },
          onGaveUp: (lastError) => {
            log.warn('Follower reconnect gave up', { lastError });
          },
        }
      );
    };

    // Listen for join events from the settings dialog
    window.addEventListener('slicc:tray-join', ((event: CustomEvent<{ joinUrl: string }>) => {
      startFollowerJoin(event.detail.joinUrl);
    }) as EventListener);

    // Clean up on page unload
    window.addEventListener(
      'beforeunload',
      () => {
        if (followerTargetRefreshInterval) clearInterval(followerTargetRefreshInterval);
        activeFollowerSync?.close();
        activeReconnectHandle?.cancel();
      },
      { once: true }
    );

    if (trayRuntimeConfig?.joinUrl) {
      startFollowerJoin(trayRuntimeConfig.joinUrl);
    } else if (trayRuntimeConfig?.workerBaseUrl) {
      let leaderTray!: LeaderTrayManager;
      // Helper: create and wire a LeaderSyncManager + LeaderTrayPeerManager pair.
      // Called on initial startup and again after `host reset`.
      let leaderSync!: LeaderSyncManager;
      let trayPeers!: LeaderTrayPeerManager;
      let leaderTargetRefreshInterval: ReturnType<typeof setInterval>;
      const tabPersistenceGuard = new TabPersistenceGuard();

      const createAndWireLeaderSync = () => {
        leaderSync = new LeaderSyncManager({
          browserTransport: browser.getTransport(),
          browserAPI: browser,
          getMessages: () => {
            return layout.panels.chat.getMessages();
          },
          getScoopJid: () => selectedScoop?.jid ?? 'cone',
          onFollowerMessage: (text, messageId, attachments) => {
            // Display the follower's message in the leader's chat panel
            layout.panels.chat.addUserMessage(text, attachments);
            // Route follower messages through the same path as local user messages.
            // coneAgentHandle.sendMessage broadcasts user_message_echo to all followers.
            coneAgentHandle.sendMessage(text, messageId, attachments);
          },
          onFollowerAbort: () => {
            coneAgentHandle.stop();
          },
          onFollowerCountChanged: (count) => {
            // Keep this tab resident in Chrome's memory while followers are attached
            // — discarded leader tabs drop the join URL and force a hard reload.
            if (count > 0) {
              tabPersistenceGuard.activate();
            } else {
              tabPersistenceGuard.deactivate();
            }
          },
        });
        leaderSyncRef = leaderSync;
        setConnectedFollowersGetter(() => leaderSync.getConnectedFollowers());
        // Wire the leader as a TrayTargetProvider so BrowserAPI can list all tray targets
        browser.setTrayTargetProvider(leaderSync);

        // Periodically refresh leader's own browser targets into the registry
        if (leaderTargetRefreshInterval) clearInterval(leaderTargetRefreshInterval);
        const refreshLeaderTargets = async () => {
          try {
            const pages = await browser.listPages();
            leaderSync.setLocalTargets(
              pages.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url }))
            );
          } catch {
            /* ignore errors */
          }
        };
        leaderTargetRefreshInterval = setInterval(refreshLeaderTargets, 5000);
        void refreshLeaderTargets();

        trayPeers = new LeaderTrayPeerManager({
          sendControlMessage: (message) => leaderTray.sendControlMessage(message),
          onPeerConnected: (peer, channel) => {
            log.info('Tray follower data channel opened', {
              controllerId: peer.controllerId,
              bootstrapId: peer.bootstrapId,
              attempt: peer.attempt,
              runtime: peer.runtime,
            });
            leaderSync.addFollower(peer.bootstrapId, channel, {
              runtime: peer.runtime,
              connectedAt: peer.connectedAt ?? undefined,
            });
          },
        });
      };

      createAndWireLeaderSync();

      // Tap into the event system to broadcast to followers
      // Uses `leaderSync` variable (reassigned on reset) so it always targets the current instance.
      eventListeners.add((event: UIAgentEvent) => {
        leaderSync.broadcastEvent(event);
      });
      leaderTray = new LeaderTrayManager({
        workerBaseUrl: trayRuntimeConfig.workerBaseUrl,
        runtime: 'slicc-standalone',
        fetchImpl: createTrayFetch(),
        onControlMessage: (message) => {
          if (message.type === 'webhook.event') {
            lickManager.handleWebhookEvent(message.webhookId, message.headers, message.body);
            return;
          }
          void trayPeers.handleControlMessage(message).catch((error) => {
            log.warn('Tray leader bootstrap handling failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
        onReconnecting: (attempt, lastError) => {
          log.info('Leader tray reconnecting', { attempt, lastError });
        },
        onReconnected: (session) => {
          log.info('Leader tray reconnected', { trayId: session.trayId });
          const trayUrl = buildTrayLaunchUrl(
            window.location.href,
            session.workerBaseUrl,
            session.trayId
          );
          if (trayUrl !== window.location.href) {
            window.history.replaceState(window.history.state, '', trayUrl);
          }
        },
        onReconnectGaveUp: (lastError, attempts) => {
          log.warn('Leader tray reconnect gave up', { lastError, attempts });
        },
      });
      // Wire the tray reset callback for `host reset` command
      setTrayResetter(async () => {
        leaderSync.stop();
        trayPeers.stop();
        leaderTray.stop();
        await leaderTray.clearSession();
        const session = await leaderTray.start();
        const trayUrl = buildTrayLaunchUrl(
          window.location.href,
          session.workerBaseUrl,
          session.trayId
        );
        if (trayUrl !== window.location.href) {
          window.history.replaceState(window.history.state, '', trayUrl);
        }
        // Re-create LeaderSyncManager + TrayPeerManager so new followers can connect
        createAndWireLeaderSync();
        return getLeaderTrayRuntimeStatus();
      });

      void leaderTray
        .start()
        .then((session) => {
          const trayUrl = buildTrayLaunchUrl(
            window.location.href,
            session.workerBaseUrl,
            session.trayId
          );
          if (trayUrl !== window.location.href) {
            window.history.replaceState(window.history.state, '', trayUrl);
          }
        })
        .catch((error) => {
          log.warn('Leader tray join failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      window.addEventListener(
        'beforeunload',
        () => {
          clearInterval(leaderTargetRefreshInterval);
          leaderSync.stop();
          trayPeers.stop();
          leaderTray.stop();
          tabPersistenceGuard.deactivate();
        },
        { once: true }
      );
    }
  }

  log.info('Orchestrator initialized — cone+scoops ready', {
    scoopCount: orchestrator.getScoops().length,
  });

  // Check for auto-prompt from URL parameter (for debugging, dev mode only)
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    const urlParams = new URLSearchParams(window.location.search);
    const autoPrompt = urlParams.get('prompt');
    if (autoPrompt && selectedScoop) {
      log.info('Auto-submitting prompt from URL', { prompt: autoPrompt });
      // Clear previous state first - both the chat panel UI and the orchestrator data
      await layout.panels.chat.clearSession();
      await layout.onClearChat?.();
      await layout.onClearFilesystem?.();
      // Small delay to ensure UI is ready after clearing
      setTimeout(() => {
        orchestrator.handleMessage({
          id: `auto-${Date.now().toString(36)}`,
          senderId: 'user',
          senderName: 'User',
          channel: 'web',
          timestamp: new Date().toISOString(),
          content: autoPrompt,
          chatJid: selectedScoop!.jid,
          fromAssistant: false,
        });
      }, 500);
    }
  }

  // Initialize operational telemetry (fire-and-forget)
  initTelemetry().catch(() => {});
}

main().catch((err) => {
  log.error('Fatal error', err);
  const app = document.getElementById('app');
  if (app) {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding: 2rem; text-align: center;';
    const h1 = document.createElement('h1');
    h1.style.color = 'var(--s2-negative, #e34850)';
    h1.textContent = 'Failed to start';
    const p = document.createElement('p');
    p.style.color = 'var(--s2-content-tertiary, #717171)';
    p.textContent = err.message;
    errorDiv.appendChild(h1);
    errorDiv.appendChild(p);

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset all data & reload';
    resetBtn.style.cssText =
      'margin-top: 1rem; padding: 0.5rem 1.5rem; background: var(--s2-negative, #e34850); color: #fff; ' +
      'border: none; border-radius: 6px; cursor: pointer; font-size: 14px;';
    resetBtn.addEventListener('click', async () => {
      resetBtn.disabled = true;
      resetBtn.textContent = 'Resetting…';
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs.map((db) =>
          db.name
            ? new Promise<void>((res) => {
                const req = indexedDB.deleteDatabase(db.name!);
                req.onsuccess = () => res();
                req.onerror = () => res();
                req.onblocked = () => res();
              })
            : Promise.resolve()
        )
      );
      location.reload();
    });
    errorDiv.appendChild(resetBtn);

    while (app.firstChild) app.removeChild(app.firstChild);
    app.appendChild(errorDiv);
  }
});
