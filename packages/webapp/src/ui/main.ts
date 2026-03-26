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
import { createLogger } from '../core/index.js';
import type { VirtualFS } from '../fs/index.js';
import { installSkillFromDrop } from '../skills/install-from-drop.js';
import { findDroppedSkillTransferFile, hasDroppedFiles } from './skill-drop.js';
// Auto-discover and register all providers (built-in + external).
// IMPORTANT: This import must also appear in packages/chrome-extension/src/offscreen.ts
// — the extension agent engine runs in the offscreen document, not in this file.
import '../providers/index.js';
import { BrowserAPI } from '../cdp/index.js';
import { Orchestrator } from '../scoops/index.js';
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

const log = createLogger('main');

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
  onInstalled: () => Promise<void>
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
      overlay.show('Drop .skill to install', 'Unpack into /workspace/skills/{name}.');
    }
  });

  window.addEventListener('dragover', (event) => {
    if (!hasDroppedFiles(event.dataTransfer)) return;

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!installInProgress) {
      overlay.show('Drop .skill to install', 'Unpack into /workspace/skills/{name}.');
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

    if (!skillFile) {
      resetDrag();
      return;
    }

    event.preventDefault();
    dragDepth = 0;

    if (installInProgress) {
      overlay.hide();
      onNotice('Another .skill installation is already in progress.', 'error');
      return;
    }

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
  });
}

// ---------------------------------------------------------------------------
// Extension mode — pure UI connecting to offscreen agent engine
// ---------------------------------------------------------------------------

async function mainExtension(app: HTMLElement): Promise<void> {
  const { OffscreenClient } = await import('./offscreen-client.js');
  const { VirtualFS } = await import('../fs/index.js');

  const layout = new Layout(app, true);
  // Expose debug tab toggle for the shell `debug` command
  (window as any).__slicc_debug_tabs = (show: boolean) => layout.setDebugTabs(show);
  await layout.panels.chat.initSession('session-cone');

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
  registerSkillDropInstall(localFs, skillDropToast, async () => {
    await layout.panels.fileBrowser.refresh();
  });

  // Mount a terminal shell on the local VFS with BrowserAPI via CDP proxy
  try {
    const { WasmShell } = await import('../shell/index.js');
    const { PanelCdpProxy, BrowserAPI: BrowserAPIClass } = await import('../cdp/index.js');
    const panelCdp = new PanelCdpProxy();
    await panelCdp.connect();
    const panelBrowser = new BrowserAPIClass(panelCdp);
    const shell = new WasmShell({ fs: localFs, browserAPI: panelBrowser });
    await layout.panels.terminal.mountShell(shell);
    log.info('Terminal mounted with shared VFS and BrowserAPI (CDP proxy)');
  } catch (e) {
    log.warn('Failed to mount shell to terminal', e);
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
      if (selectedScoop?.jid === scoopJid) {
        const content =
          message.channel === 'delegation'
            ? `**[Instructions from sliccy]**\n\n${message.content}`
            : message.content;
        layout.panels.chat.addUserMessage(content);
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

  // Wire agent handle
  const agentHandle = client.createAgentHandle();
  layout.panels.chat.setAgent(agentHandle);

  // Wire panels — OffscreenClient implements the Orchestrator methods
  // that ScoopsPanel, ScoopSwitcher, and MemoryPanel need
  layout.panels.scoops.setOrchestrator(client as any);
  layout.panels.memory.setOrchestrator(client as any);
  layout.setScoopSwitcherOrchestrator?.(client as any);

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
    (event: LickEvent) => {
      // Route sprinkle licks to the offscreen orchestrator's cone
      if (event.type === 'sprinkle') {
        // Mark onboarding complete so welcome sprinkle doesn't reappear
        if (
          event.sprinkleName === 'welcome' &&
          (event.body as any)?.action === 'onboarding-complete'
        ) {
          localStorage.setItem('slicc-welcomed', '1');
        }
        client.sendSprinkleLick(event.sprinkleName!, event.body);
      }
    },
    {
      addSprinkle: (name, title, element, zone) =>
        layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined),
      removeSprinkle: (name) => layout.removeSprinkle(name),
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
  client.setSprinkleOpHandler((payload: any) => {
    const { id, op, name, data } = payload;
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
        (chrome as any).runtime
          .sendMessage({
            source: 'panel',
            payload: { type: 'sprinkle-op-response', id, result },
          })
          .catch(() => {});
      } catch (err) {
        (chrome as any).runtime
          .sendMessage({
            source: 'panel',
            payload: {
              type: 'sprinkle-op-response',
              id,
              error: err instanceof Error ? err.message : String(err),
            },
          })
          .catch(() => {});
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

  // Open welcome sprinkle on first run (extension mode)
  if (
    !localStorage.getItem('slicc-welcomed') &&
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

  // Initialize operational telemetry (fire-and-forget)
  initTelemetry().catch(() => {});
}

// ---------------------------------------------------------------------------
// CLI mode — direct Orchestrator in this page (unchanged)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
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
    // Default to tray-join form when not on the default port (5710 prod, 3000 legacy dev)
    const isDefaultPort =
      window.location.port === '5710' ||
      window.location.port === '3000' ||
      window.location.port === '';
    await showProviderSettings({ preferTrayJoin: !isDefaultPort });
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
      // Buffer incoming messages (delegations, etc.) for display
      const chatMsg: ChatMessage = {
        id: message.id,
        role: 'user',
        content:
          message.channel === 'delegation'
            ? `**[Instructions from sliccy]**\n\n${message.content}`
            : message.content,
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
      }
    );

    try {
      const { WasmShell } = await import('../shell/index.js');
      const shell = new WasmShell({ fs: sharedFs, browserAPI: browser });
      await layout.panels.terminal.mountShell(shell);
      log.info('Terminal mounted with shared VFS');

      // Start BSH navigation watchdog — auto-executes .bsh scripts on matching navigations
      try {
        const { BshWatchdog } = await import('../shell/bsh-watchdog.js');
        const bshWatchdog = new BshWatchdog({
          browserAPI: browser,
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
    const cone = await layout.panels.scoops.createScoop('Cone', true);
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
    sendMessage(text: string, messageId?: string): void {
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
        timestamp: new Date().toISOString(),
        fromAssistant: false,
        channel: 'web',
      };

      // Buffer the user message for this scoop
      getBuffer(selectedScoop.jid).push({
        id: msg.id,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      });

      // Broadcast user message to all followers (leader mode)
      leaderSyncRef?.broadcastUserMessage(text, msg.id);

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
    const eventName = isWebhook
      ? event.webhookName
      : isSprinkle
        ? event.sprinkleName
        : event.cronName;
    const eventId = isWebhook ? event.webhookId : isSprinkle ? event.sprinkleName : event.cronId;
    const channel = event.type;

    log.debug('Lick event', { type: event.type, name: eventName, targetScoop: event.targetScoop });

    // Mark onboarding complete so welcome sprinkle doesn't reappear
    if (
      isSprinkle &&
      event.sprinkleName === 'welcome' &&
      (event.body as any)?.action === 'onboarding-complete'
    ) {
      localStorage.setItem('slicc-welcomed', '1');
    }

    // Determine the target:
    // - Sprinkle licks and untargeted events default to cone
    // - Webhook/cron licks use explicit targetScoop if set
    const scoops = orchestrator.getScoops();
    let resolvedTarget: RegisteredScoop | undefined;

    if (isSprinkle || !event.targetScoop) {
      // Sprinkle licks + untargeted cron/webhook events → cone
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
      const eventLabel = isWebhook ? 'Webhook Event' : isSprinkle ? 'Sprinkle Event' : 'Cron Event';
      const content = `[${eventLabel}: ${eventName}]\n\`\`\`json\n${JSON.stringify(event.body, null, 2)}\n\`\`\``;

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

      getBuffer(resolvedTarget.jid).push({
        id: msgId,
        role: 'user',
        content,
        timestamp: Date.now(),
        source: 'lick',
        channel,
      });

      if (selectedScoop?.jid === resolvedTarget.jid) {
        layout.panels.chat.addLickMessage(
          msgId,
          content,
          channel as 'webhook' | 'cron' | 'sprinkle'
        );
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
    sprinkleManager = new SprinkleManager(sharedFs, routeLickToScoop, {
      addSprinkle: (name, title, element, zone) =>
        layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined),
      removeSprinkle: (name) => layout.removeSprinkle(name),
    });
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

    // Open welcome sprinkle on first run (flag set when onboarding-complete lick fires)
    if (
      !localStorage.getItem('slicc-welcomed') &&
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

  // Wire clear chat to also clear orchestrator messages + buffers
  layout.onClearChat = async () => {
    await orchestrator.clearAllMessages();
    scoopMessageBuffers.clear();
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

    // Switch chat context. Load from per-scoop message buffer (has full tool call detail)
    // falling back to SessionStore, then orchestrator DB.
    const contextId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
    const buffer = scoopMessageBuffers.get(scoop.jid);

    // Pass scoop name for non-cone contexts
    const scoopName = scoop.isCone ? undefined : scoop.name;

    if (buffer && buffer.length > 0) {
      // Load from in-memory buffer (has tool calls captured during this session)
      await layout.panels.chat.switchToContext(contextId, !scoop.isCone, scoopName);
      layout.panels.chat.loadMessages(buffer);
    } else {
      // No buffer — load from SessionStore (persisted from previous sessions)
      await layout.panels.chat.switchToContext(contextId, !scoop.isCone, scoopName);

      // If still empty, fall back to orchestrator DB (simple text, no tool calls)
      if (layout.panels.chat.getMessages().length === 0) {
        const messages = await orchestrator.getMessagesForScoop(scoop.jid);
        for (const msg of messages) {
          // Determine the proper role and source for display
          const isLick = msg.channel === 'webhook' || msg.channel === 'cron';
          const isDelegation = msg.channel === 'delegation';

          if (isLick) {
            // Lick events - show as incoming with tongue emoji
            const chatMsg: ChatMessage = {
              id: msg.id,
              role: 'user',
              content: msg.content,
              timestamp: new Date(msg.timestamp).getTime(),
              source: 'lick',
              channel: msg.channel,
            };
            getBuffer(scoop.jid).push(chatMsg);
            layout.panels.chat.addUserMessage(msg.content);
          } else if (isDelegation) {
            // Delegation from cone - show as incoming instructions
            const chatMsg: ChatMessage = {
              id: msg.id,
              role: 'user',
              content: `**[Instructions from sliccy]**\n\n${msg.content}`,
              timestamp: new Date(msg.timestamp).getTime(),
              source: 'delegation',
              channel: 'delegation',
            };
            getBuffer(scoop.jid).push(chatMsg);
            layout.panels.chat.addUserMessage(chatMsg.content);
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
    }

    // If switching back to cone and it's currently processing (e.g., handling
    // a scoop notification), re-lock the input. switchToContext resets streaming
    // state, but we need to reflect the cone's actual status.
    if (scoop.isCone && orchestrator.isProcessing(scoop.jid)) {
      layout.panels.chat.setProcessing(true);
    }
  };

  layout.onScoopSelect = handleScoopSelect;

  // Initialize the selected scoop's tab and trigger initial load
  if (selectedScoop) {
    orchestrator.createScoopTab(selectedScoop.jid);
    // Trigger scoop select to properly load the chat context
    await handleScoopSelect(selectedScoop);
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
        onUserMessage: (text) => {
          layout.panels.chat.addUserMessage(text);
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

      const createAndWireLeaderSync = () => {
        leaderSync = new LeaderSyncManager({
          browserTransport: browser.getTransport(),
          browserAPI: browser,
          getMessages: () => {
            return layout.panels.chat.getMessages();
          },
          getScoopJid: () => selectedScoop?.jid ?? 'cone',
          onFollowerMessage: (text, messageId) => {
            // Display the follower's message in the leader's chat panel
            layout.panels.chat.addUserMessage(text);
            // Route follower messages through the same path as local user messages.
            // coneAgentHandle.sendMessage broadcasts user_message_echo to all followers.
            coneAgentHandle.sendMessage(text, messageId);
          },
          onFollowerAbort: () => {
            coneAgentHandle.stop();
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
