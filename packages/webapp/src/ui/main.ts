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
import {
  getApiKey,
  applyProviderDefaults,
  resolveCurrentModel,
  resolveModelById,
} from './provider-settings.js';
import { getSupportedThinkingLevels } from '@mariozechner/pi-ai';
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
import { registerProviders } from '../providers/index.js';
import { BrowserAPI, NavigationWatcher } from '../cdp/index.js';
import { type Orchestrator } from '../scoops/index.js';
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
  TRAY_WORKER_STORAGE_KEY,
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
import { resolveSprinkleIconHtml } from './sprinkle-icon.js';
import { initTelemetry } from './telemetry.js';
import { getAllMountEntries } from '../fs/mount-table-store.js';
import { recoverMounts } from '../fs/mount-recovery.js';
import { formatLickEventForCone } from '../scoops/lick-formatting.js';
import { LocalMountBackend } from '../fs/mount/backend-local.js';
import { newMountId } from '../fs/mount/mount-id.js';
import {
  openMountPickerPopup,
  loadAndClearPendingHandle,
  reactivateHandle,
} from '../fs/mount-picker-popup.js';
import { detectUpgrade, recordVersionSeen } from '../scoops/upgrade-detection.js';
import {
  detectWelcomeFirstRun,
  hasOnboardingFinalLickInHistory,
} from '../scoops/welcome-detection.js';
// Static-import dip helpers used by the onboarding orchestrator. dip.ts is
// already pulled into the main entry chunk via chat-panel.ts/tool-ui-renderer.ts
// — dynamic-importing it here only confused rollup's chunk graph (and triggered
// the INEFFECTIVE_DYNAMIC_IMPORT warning), occasionally surfacing as a runtime
// "o is not a function" error in the fs chunk because of the resulting
// circular module-evaluation order.
import { broadcastToDips } from './dip.js';

const log = createLogger('main');

/**
 * Welcome-flow lick actions that must fire at most ONCE per browser
 * profile (not per session — reloads share the same ledger). Each one
 * is a state transition (post deterministic intro lines, post the
 * cone's greeting, etc.) rather than an idempotent read, so re-firing
 * after a reload would double up the chat. Mount-time queries that
 * are safe to repeat (`connect-ready` for the catalogue probe,
 * `request-mount` for picker re-tries) are deliberately omitted.
 *
 * The ledger is persisted to localStorage under
 * `WELCOME_FLOW_LEDGER_KEY` so the guard survives page reloads, HMR,
 * and chat-history wipes. The `nuke` command explicitly removes this
 * key so a full reset re-enables the welcome flow.
 */
const DEDUPED_WELCOME_ACTIONS = new Set<string>([
  'first-run',
  'onboarding-complete',
  'onboarding-complete-with-provider',
  'shortcut-migrate',
]);

const WELCOME_FLOW_LEDGER_KEY = 'slicc:welcome-flow-fired';

function loadFiredWelcomeActions(): Set<string> {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(WELCOME_FLOW_LEDGER_KEY) : null;
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function persistFiredWelcomeActions(set: Set<string>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(WELCOME_FLOW_LEDGER_KEY, JSON.stringify([...set]));
  } catch {
    /* quota / disabled — fall back to in-memory dedup only */
  }
}

/**
 * Run `fire` only if the given welcome-flow action hasn't been fired
 * yet for this profile. Updates the persistent ledger on first fire.
 * Used at every welcome-lick dispatch site that doesn't go through
 * `routeLickToScoop` (extension `client.sendSprinkleLick` paths).
 */
function dispatchWelcomeLickOnce(
  action: string,
  set: Set<string>,
  fire: () => void,
  contextLabel: string
): void {
  if (DEDUPED_WELCOME_ACTIONS.has(action) && set.has(action)) {
    log.debug(`Suppressing duplicate welcome lick (${contextLabel})`, { action });
    return;
  }
  if (DEDUPED_WELCOME_ACTIONS.has(action)) {
    set.add(action);
    persistFiredWelcomeActions(set);
  }
  fire();
}

const PENDING_MOUNT_DB = 'slicc-pending-mount';
const PENDING_MOUNT_KEY = 'pendingMount';

/**
 * Sprinkle names whose `.shtml` file backs an inline dip rather than a
 * panel sprinkle. They live under `/shared/sprinkles/` for path-stability
 * reasons (the markdown image syntax `![](/shared/sprinkles/...)`
 * references them) but should never appear in the rail/picker, since the
 * inline dip is the sole intended rendering.
 */
const INLINE_DIP_SPRINKLES: ReadonlySet<string> = new Set(['welcome']);

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
    const backend = LocalMountBackend.fromHandle(handle, { mountId: newMountId() });
    await fs.mount(mountPath, backend);
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
          `Installed "${result.skillName}" to ${result.destinationPath} (${result.fileCount} files).`,
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

/**
 * Read the most recently-written `/home/<slug>/.welcome.json` so the
 * fast-forward path can hand the cone the same profile shape the
 * orchestrator would have. Returns an empty object on any failure —
 * the cone's welcome SKILL.md is happy to greet without personalization.
 */
async function loadPersistedProfile(fs: VirtualFS): Promise<Record<string, unknown>> {
  try {
    const homes = await fs.readDir('/home');
    let best: { profile: Record<string, unknown>; mtime: number } | null = null;
    for (const entry of homes) {
      if (entry.type !== 'directory') continue;
      const path = `/home/${entry.name}/.welcome.json`;
      try {
        const stat = await fs.stat(path);
        const mtime = stat.mtime ?? 0;
        if (best && mtime <= best.mtime) continue;
        const raw = await fs.readFile(path, { encoding: 'utf-8' });
        const parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
        if (parsed && typeof parsed === 'object') {
          best = { profile: parsed as Record<string, unknown>, mtime };
        }
      } catch {
        /* skip slugs without a profile */
      }
    }
    return best?.profile ?? {};
  } catch {
    return {};
  }
}

/**
 * When the connect-llm dip is fast-forwarded on reload (provider
 * already configured), the orchestrator's normal connect-attempt path
 * never runs and the final `onboarding-complete-with-provider` lick is
 * never fired. That stalls the welcome sequence — the cone never gets
 * to greet the user with the model name. Re-fire the lick here with
 * the on-disk profile + active provider/model. Skipped when the cone
 * has already received the lick in a previous session (chat history
 * persists across reloads).
 */
async function fireFastForwardFinalLick(
  fs: VirtualFS | null,
  providerId: string,
  fire: (data: Record<string, unknown>) => void
): Promise<void> {
  if (await hasOnboardingFinalLickInHistory()) return;
  const profile = fs ? await loadPersistedProfile(fs) : {};
  const { getSelectedModelId, getProviderConfig, getProviderModels } =
    await import('./provider-settings.js');
  const modelId = (() => {
    try {
      return getSelectedModelId() || null;
    } catch {
      return null;
    }
  })();
  const modelLabel = (() => {
    if (!modelId) return null;
    try {
      const found = getProviderModels(providerId).find((m) => m.id === modelId);
      return found?.name ?? modelId;
    } catch {
      return modelId;
    }
  })();
  let providerName: string | null = null;
  try {
    providerName = getProviderConfig(providerId).name ?? null;
  } catch {
    /* keep null */
  }
  fire({
    action: 'onboarding-complete-with-provider',
    data: {
      profile,
      provider: providerId,
      providerName,
      model: modelId,
      modelLabel,
      validation: 'preexisting',
    },
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

  // Restore persisted mounts. The side panel and the offscreen document
  // each have their own VirtualFS instance (sharing only the underlying
  // IDB store), so each must rebuild its own in-memory mount table on
  // boot. Without this, terminal-typed `mount` commands survive the
  // current session but vanish from the side panel's view as soon as
  // the panel is closed/reopened — even though the descriptors are
  // still in IDB and the offscreen agent can still see the mount.
  void getAllMountEntries()
    .then(async (entries) => {
      if (entries.length === 0) return;
      const { needsRecovery } = await recoverMounts(entries, localFs, log);
      if (needsRecovery.length === 0) return;
      // The offscreen already routes a session-reload lick when its own
      // recovery surfaces unrecoverable mounts; routing a second one
      // here from the panel would double-message the cone. Just log.
      log.warn('Some mounts could not be recovered in the panel VFS', {
        count: needsRecovery.length,
        paths: needsRecovery.map((r) => r.path),
      });
    })
    .catch((err) => log.warn('Failed to restore persisted mounts in panel VFS', err));

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

  // Panel terminal is a `RemoteTerminalView` over the offscreen
  // `TerminalSessionHost` (mirrors the standalone-worker wiring). This
  // unifies the panel terminal with the offscreen kernel host so
  // `ps` / `kill` / `/proc` / mounts all see the same table the agent
  // sees. Mounted lazily AFTER `client` is constructed below.

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

    syncThinkingButtonForExtensionScoop(scoop);
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
    onScoopMessagesReplaced: (scoopJid, messages) => {
      if (selectedScoop?.jid !== scoopJid) return;
      // The offscreen has already persisted the messages to IndexedDB,
      // so a panel reload would pick them up. Repaint the open chat.
      layout.panels.chat.loadMessages(messages as unknown as ChatMessage[]);
    },
    onReady: async () => {
      try {
        log.info('Offscreen engine ready, scoop count:', client.getScoops().length);

        const storedJoinUrl = window.localStorage.getItem(TRAY_JOIN_STORAGE_KEY);
        if (storedJoinUrl) {
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

  // Mount the panel terminal as a `RemoteTerminalView` backed by the
  // offscreen `TerminalSessionHost`. Keystrokes assemble locally; each
  // committed line dispatches a `terminal-exec` to the offscreen so
  // panel-typed commands share the same `ProcessManager` and `/proc`
  // view as the agent's bash tool.
  void (async () => {
    try {
      const { RemoteTerminalView } = await import('../kernel/remote-terminal-view.js');
      const remoteTerminal = new RemoteTerminalView({ client, cwd: '/' });
      await layout.panels.terminal.mountRemoteShell(remoteTerminal);
      window.addEventListener('beforeunload', () => remoteTerminal.dispose(), { once: true });
      log.info('Panel terminal mounted as RemoteTerminalView (offscreen TerminalSessionHost)');
    } catch (err) {
      log.warn('Failed to mount remote terminal view', err);
    }
  })();

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

  /**
   * Sync the brain icon to the active scoop's resolved model + persisted
   * thinking-level. Extension flavor: same lookup logic as the standalone
   * version, but reads `scoop.config` from the proxied snapshot and uses
   * provider-settings via the side-panel realm (which shares localStorage
   * with offscreen for the model id).
   */
  const syncThinkingButtonForExtensionScoop = (scoop: RegisteredScoop): void => {
    const modelId = scoop.config?.modelId;
    const model = modelId ? resolveModelById(modelId) : resolveCurrentModel();
    layout.panels.chat.setModelSupportsReasoning(
      !!model.reasoning,
      getSupportedThinkingLevels(model).includes('xhigh')
    );
    layout.panels.chat.setThinkingLevel(scoop.config?.thinkingLevel);
  };

  // Wire model picker
  layout.onModelChange = (modelId) => {
    localStorage.setItem('selected-model', modelId);
    client.updateModel();
    if (selectedScoop) {
      syncThinkingButtonForExtensionScoop(selectedScoop);
    }
  };

  // Wire brain-icon thinking-level cycle through the offscreen client.
  layout.onThinkingLevelChange = (level) => {
    if (!selectedScoop) return;
    client.setScoopThinkingLevel(selectedScoop.jid, level);
  };

  // Re-sync brain icon on provider account changes (see standalone path).
  layout.onModelsRefreshed = () => {
    if (selectedScoop) syncThinkingButtonForExtensionScoop(selectedScoop);
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

  // The chat-panel `onDipLick` wiring lives further down (after the
  // welcome-flow interceptor is defined) so inline dips can short-
  // circuit welcome actions before they reach the cone.

  // ── Onboarding orchestrator (extension) ─────────────────────────
  // Mirrors the standalone wiring in mainCli — instantiated lazily so
  // it has access to layout/chatPanel + provider settings + the
  // OffscreenClient sprinkle-lick relay.
  const { OnboardingOrchestrator: OnboardingOrchestratorExt } =
    await import('../scoops/onboarding-orchestrator.js');
  const broadcastToDipsExt = broadcastToDips;
  const {
    getAvailableProviders: getAvailableProvidersExt,
    getProviderConfig: getProviderConfigExt,
    getProviderModels: getProviderModelsExt,
    addAccount: addAccountExt,
    setSelectedModelId: setSelectedModelIdExt,
    getAccounts: getAccountsExt,
    isModelHiddenFromPicker: isModelHiddenFromPickerExt,
  } = await import('./provider-settings.js');
  const buildExtProviderCatalogue = () => {
    const ids = getAvailableProvidersExt();
    const providers = ids
      .map((id) => {
        const cfg = getProviderConfigExt(id);
        return {
          id: cfg.id,
          name: cfg.name,
          description: cfg.description,
          requiresApiKey: cfg.requiresApiKey ?? true,
          requiresBaseUrl: cfg.requiresBaseUrl ?? false,
          requiresDeployment: !!cfg.requiresDeployment,
          requiresApiVersion: !!cfg.requiresApiVersion,
          apiKeyPlaceholder: cfg.apiKeyPlaceholder ?? undefined,
          apiKeyEnvVar: cfg.apiKeyEnvVar ?? undefined,
          defaultBaseUrl: cfg.baseUrlPlaceholder ?? undefined,
          baseUrlDescription: cfg.baseUrlDescription ?? undefined,
          deploymentPlaceholder: cfg.deploymentPlaceholder ?? undefined,
          deploymentDescription: cfg.deploymentDescription ?? undefined,
          apiVersionDefault: cfg.apiVersionDefault ?? undefined,
          apiVersionDescription: cfg.apiVersionDescription ?? undefined,
          isOAuth: !!cfg.isOAuth,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const models: Record<string, Array<{ id: string; name?: string }>> = {};
    for (const id of ids) {
      try {
        // Hide picker-only-denied models (e.g. Haiku) from the
        // connect-llm wizard list. Programmatic surfaces still see
        // the full catalogue via `getProviderModels` directly.
        models[id] = getProviderModelsExt(id)
          .filter((m) => !isModelHiddenFromPickerExt(m.id))
          .map((m) => ({ id: m.id, name: m.name }));
      } catch {
        models[id] = [];
      }
    }
    return { providers, models };
  };
  let extOnboardingOrchestrator: InstanceType<typeof OnboardingOrchestratorExt> | null = null;
  const getExtOnboardingOrchestrator = () => {
    if (extOnboardingOrchestrator) return extOnboardingOrchestrator;
    extOnboardingOrchestrator = new OnboardingOrchestratorExt({
      fs: localFs,
      postSystemMessage: (line) => layout.panels.chat.addSystemMessage(line),
      postDipReference: (md) => layout.panels.chat.addSystemMessage(md),
      getProviderCatalogue: buildExtProviderCatalogue,
      saveAccount: (id, key, baseUrl, deployment, apiVersion) =>
        addAccountExt(id, key, baseUrl, deployment, apiVersion),
      setSelectedModel: (id) => setSelectedModelIdExt(id),
      resolveModelLabel: (provider, modelId) => {
        try {
          const found = getProviderModelsExt(provider).find((m) => m.id === modelId);
          return found?.name ?? null;
        } catch {
          return null;
        }
      },
      broadcastToDip: (payload) => broadcastToDipsExt(payload),
      fireFinalLick: (data) => {
        // Forward the synthetic completion event through the same
        // relay any other sprinkle lick would use, so the offscreen
        // cone receives it as a regular `[Sprinkle Event: welcome]`.
        // Dedup-gated so a stray re-fire (HMR, double-mount) can't
        // double the cone's greeting.
        const action = String((data as { action?: unknown })?.action ?? '');
        dispatchWelcomeLickOnce(
          action,
          firedWelcomeActions,
          () => client.sendSprinkleLick('welcome', data),
          'orchestrator-ext'
        );
      },
      launchOAuth: async (providerId, baseUrl) => {
        try {
          const cfg = getProviderConfigExt(providerId);
          if (!cfg.isOAuth || !cfg.onOAuthLogin) {
            return { ok: false, message: 'Provider does not support OAuth.' };
          }
          if (cfg.requiresBaseUrl && baseUrl) addAccountExt(providerId, '', baseUrl);
          const { createOAuthLauncher } = await import('../providers/oauth-service.js');
          const launcher = createOAuthLauncher();
          await cfg.onOAuthLogin(launcher, () => undefined);
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            message: err instanceof Error ? err.message : 'OAuth login failed.',
          };
        }
      },
    });
    return extOnboardingOrchestrator;
  };

  // Persistent dedup ledger of welcome-flow licks — same contract as
  // the standalone path. See DEDUPED_WELCOME_ACTIONS for the rationale.
  const firedWelcomeActions = loadFiredWelcomeActions();

  // ── Welcome lick interception (shared between SprinkleManager and inline dips) ──
  //
  // The deterministic welcome flow is driven by the on-panel
  // `OnboardingOrchestrator`, NOT by the cone — the cone has no API
  // key configured at this point and any lick that reaches it would
  // fatal with "No API key configured for provider …". Both lick
  // entry points (the SprinkleManager handler for panel-mounted
  // sprinkles, and chat-panel `onDipLick` for inline dips in the
  // chat history) need to short-circuit welcome-flow actions and
  // hand them to the orchestrator instead. This helper does the
  // dedup + dispatch and returns true when the lick was intercepted.
  //
  // Mirrors the standalone interception block inside
  // `routeLickToScoop` further down — keep them in sync.
  const interceptWelcomeLickExt = (event: LickEvent): boolean => {
    if (event.type !== 'sprinkle') return false;
    const welcomeAction =
      event.sprinkleName === 'welcome' || event.sprinkleName === 'inline'
        ? ((event.body as Record<string, unknown> | null)?.action as string | undefined)
        : undefined;
    if (welcomeAction && DEDUPED_WELCOME_ACTIONS.has(welcomeAction)) {
      if (firedWelcomeActions.has(welcomeAction)) {
        log.debug('Suppressing duplicate welcome lick (ext)', { action: welcomeAction });
        return true;
      }
      firedWelcomeActions.add(welcomeAction);
      persistFiredWelcomeActions(firedWelcomeActions);
    }
    const isWelcomeFlowAction =
      welcomeAction === 'first-run' ||
      welcomeAction === 'onboarding-complete' ||
      welcomeAction === 'connect-ready' ||
      welcomeAction === 'connect-attempt' ||
      welcomeAction === 'oauth-attempt' ||
      welcomeAction === 'shortcut-migrate';
    if (!isWelcomeFlowAction) return false;

    const body = event.body as Record<string, unknown> | null;
    const action = welcomeAction;

    if (action === 'first-run') {
      getExtOnboardingOrchestrator().handleFirstRun();
      return true;
    }
    if (action === 'onboarding-complete') {
      const orch = getExtOnboardingOrchestrator();
      const profile = (body?.data as Record<string, unknown> | undefined) ?? {};
      if ((profile as Record<string, unknown>).mountWorkspace) {
        applyPendingMount(localFs).catch((err) =>
          log.warn('Failed to mount workspace from onboarding', err)
        );
      }
      void orch
        .handleOnboardingComplete(profile as Record<string, unknown>)
        .catch((err) => log.warn('OnboardingOrchestrator failed', err));
      return true; // Suppress cone-routing — LLM isn't configured yet.
    }
    if (action === 'connect-ready') {
      // Reload short-circuit: if the user already configured a
      // provider in a previous session, the connect-llm dip is
      // being re-mounted from chat history. Don't ask them to
      // reconfigure — tell the dip to fast-forward to its done
      // card.
      const accounts = getAccountsExt();
      if (accounts.length > 0) {
        const primary = accounts[0];
        const cfg = (() => {
          try {
            return getProviderConfigExt(primary.providerId);
          } catch {
            return null;
          }
        })();
        broadcastToDipsExt({
          type: 'slicc-already-connected',
          provider: primary.providerId,
          note: cfg?.name ? `Already connected to ${cfg.name}.` : 'Already connected.',
        });
        // Same final-lick advance as the standalone path —
        // see comment there for the chat-history gate. Routed
        // through `dispatchWelcomeLickOnce` so the persistent
        // ledger gates duplicate fires across reloads.
        void fireFastForwardFinalLick(localFs, primary.providerId, (data) => {
          const finalAction = String((data as { action?: unknown }).action ?? '');
          dispatchWelcomeLickOnce(
            finalAction,
            firedWelcomeActions,
            () => client.sendSprinkleLick('welcome', data),
            'fast-forward-ext'
          );
        }).catch((err) => log.warn('Failed to fire fast-forward final lick', err));
        return true;
      }
      getExtOnboardingOrchestrator().handleConnectReady();
      return true;
    }
    if (action === 'connect-attempt') {
      const data = body?.data as Record<string, unknown> | undefined;
      if (data) {
        void getExtOnboardingOrchestrator()
          .handleConnectAttempt({
            provider: String(data.provider ?? ''),
            apiKey: String(data.apiKey ?? ''),
            baseUrl: typeof data.baseUrl === 'string' && data.baseUrl ? String(data.baseUrl) : null,
            deployment:
              typeof data.deployment === 'string' && data.deployment
                ? String(data.deployment)
                : null,
            apiVersion:
              typeof data.apiVersion === 'string' && data.apiVersion
                ? String(data.apiVersion)
                : null,
            model: data.model == null ? null : String(data.model),
          })
          .catch((err) => log.warn('handleConnectAttempt failed', err));
      }
      return true;
    }
    if (action === 'oauth-attempt') {
      const data = body?.data as Record<string, unknown> | undefined;
      if (data) {
        void getExtOnboardingOrchestrator()
          .handleOAuthAttempt({
            provider: String(data.provider ?? ''),
            baseUrl: typeof data.baseUrl === 'string' && data.baseUrl ? String(data.baseUrl) : null,
          })
          .catch((err) => log.warn('handleOAuthAttempt failed', err));
      }
      return true;
    }
    // `shortcut-migrate` only fires from the panel-mounted welcome
    // sprinkle; the inline-dip path can't reach it. Treat it as
    // intercepted so the dip path doesn't accidentally forward it
    // to the cone either.
    if (action === 'shortcut-migrate') {
      void localFs
        .writeFile('/shared/.welcomed', '1')
        .catch((err) => log.warn('Failed to persist welcome completion marker', err));
      // sprinkleManager.close happens in the SprinkleManager handler
      // below — only reachable from the panel-sprinkle path.
      return true;
    }
    return false;
  };

  // Inline sprinkle lick callback. The welcome dip is mounted as an
  // inline `<img>`-hydrated dip in chat history, so its licks reach
  // us through this path rather than the SprinkleManager. Run them
  // through the same welcome-flow interceptor before falling back
  // to the cone-bound `client.sendSprinkleLick`.
  layout.panels.chat.onDipLick = (action: string, data: unknown) => {
    const event: LickEvent = {
      type: 'sprinkle',
      sprinkleName: 'inline',
      targetScoop: undefined,
      timestamp: new Date().toISOString(),
      body: { action, data },
    };
    if (interceptWelcomeLickExt(event)) return;
    client.sendSprinkleLick('inline', { action, data });
  };

  // ── Sprinkle Manager (SHTML sprinkle panels) ────────────────────────
  const sprinkleManager = new SprinkleManager(
    localFs,
    async (event: LickEvent) => {
      // Route sprinkle licks to the offscreen orchestrator's cone
      if (event.type === 'sprinkle') {
        if (interceptWelcomeLickExt(event)) {
          // `shortcut-migrate` needs to close the welcome panel —
          // the helper marks it intercepted but doesn't have a
          // sprinkleManager reference. Do the close here.
          if ((event.body as Record<string, unknown> | null)?.action === 'shortcut-migrate') {
            sprinkleManager.close('welcome');
          }
          return;
        }
        // Handle request-mount from welcome sprinkle (sandbox can't call showDirectoryPicker).
        // Route through mount-popup.html — calling showDirectoryPicker directly from the
        // side panel context crashes the renderer when the user picks a TCC-protected
        // folder (Documents, Downloads, Desktop, home). The popup is a regular browser
        // window where TCC dialogs and Chrome's system-folder rejection render correctly.
        if (
          event.sprinkleName === 'welcome' &&
          (event.body as Record<string, unknown> | null)?.action === 'request-mount'
        ) {
          try {
            const result = await openMountPickerPopup();
            if (result.cancelled) {
              sprinkleManager.sendToSprinkle('welcome', { action: 'mount-cancelled' });
              return;
            }
            if (result.error) {
              log.warn('Mount picker popup failed', result.error);
              sprinkleManager.sendToSprinkle('welcome', { action: 'mount-cancelled' });
              return;
            }
            if (!result.handleInIdb || typeof result.idbKey !== 'string') {
              log.warn('Mount picker popup returned unexpected result', result);
              sprinkleManager.sendToSprinkle('welcome', { action: 'mount-cancelled' });
              return;
            }
            const handle = await loadAndClearPendingHandle(result.idbKey);
            if (!handle) {
              log.warn('Mount picker popup did not store a handle');
              sprinkleManager.sendToSprinkle('welcome', { action: 'mount-cancelled' });
              return;
            }
            await reactivateHandle(handle);
            await storePendingMount(handle);
            sprinkleManager.sendToSprinkle('welcome', {
              action: 'mount-complete',
              dirName: handle.name,
            });
          } catch (err: unknown) {
            log.warn('Mount picker failed', err);
            sprinkleManager.sendToSprinkle('welcome', { action: 'mount-cancelled' });
          }
          return; // Don't forward to orchestrator
        }
        client.sendSprinkleLick(event.sprinkleName!, event.body, event.targetScoop);
      }
    },
    {
      addSprinkle: (name, title, element, zone, options) =>
        layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined, options),
      removeSprinkle: (name) => layout.removeSprinkle(name),
    },
    () => {
      const cone = client.getScoops().find((s) => s.isCone);
      if (cone) {
        client.stopScoop(cone.jid);
      }
    },
    {
      // Extension side panel: auto-installed sprinkles must NOT pop
      // open over chat (covers the welcome flow mid-flight). The
      // rail icon pulses to invite the user to click when ready.
      autoOpenBehavior: 'attention',
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
  client.setSprinkleOpHandler((payload: unknown) => {
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
  layout.onSprinkleActivate = (name) => sprinkleManager.markActivated(name);
  layout.getAvailableSprinkles = () => {
    const opened = new Set(sprinkleManager.opened());
    return sprinkleManager
      .available()
      .filter((p) => !opened.has(p.name) && !INLINE_DIP_SPRINKLES.has(p.name))
      .map((p) => ({ name: p.name, title: p.title }));
  };
  layout.onOpenSprinkle = (name, zone) => sprinkleManager.open(name, zone);
  layout.resolveSprinkleIcon = (spec) => resolveSprinkleIconHtml(spec, localFs);
  layout.updateAddButtons();
  await sprinkleManager.restoreOpenSprinkles();

  // Auto-surface newly-added .shtml files in the rail. The panel's
  // `localFs` doesn't have the orchestrator's watcher (that lives in
  // offscreen), so attach a fresh one to catch panel-side writes
  // (e.g. skill drag-and-drop installs). Offscreen-side writes are
  // relayed separately from `offscreen.ts` via the sprinkle proxy.
  if (!localFs.getWatcher()) {
    const { FsWatcher } = await import('../fs/index.js');
    localFs.setWatcher(new FsWatcher());
  }
  const panelWatcher = localFs.getWatcher();
  if (panelWatcher) {
    sprinkleManager.setupWatcher(panelWatcher);
  }

  // Migrate legacy localStorage flag to VFS marker
  if (!(await localFs.exists('/shared/.welcomed')) && localStorage.getItem('slicc-welcomed')) {
    await localFs.writeFile('/shared/.welcomed', '1').catch(() => {});
    localStorage.removeItem('slicc-welcomed');
  }

  // Drive the first-run flow locally. The deterministic onboarding
  // orchestrator owns the welcome dip + intro lines until the user
  // configures a provider — handing it to the cone would fatal with
  // "No API key configured for provider …" before the wizard even
  // appears. The persistent dedup ledger guards against reload
  // double-fires (see DEDUPED_WELCOME_ACTIONS).
  if (!hasStoredTrayJoinUrl(window.localStorage)) {
    detectWelcomeFirstRun(localFs)
      .then((result) => {
        if (!result.isFirstRun) return;
        // If detection insists this is genuinely a fresh boot (no
        // `/shared/.welcomed` marker AND no welcome lick in chat
        // history), but our localStorage ledger has a stale
        // `first-run` entry from a previous install whose state was
        // wiped (clear-site-data, IndexedDB nuke, manual VFS reset),
        // suppressing here would leave the user with no welcome and
        // no deterministic onboarding path. Trust the install state
        // over the ledger and clear the stale entry. The ledger
        // still protects against intra-session double-fires (the
        // detection promise can resolve twice during a noisy boot),
        // because we re-add it below before handing off.
        if (firedWelcomeActions.has('first-run')) {
          log.info('Clearing stale welcome dedup entry — install state is fresh');
          firedWelcomeActions.delete('first-run');
          persistFiredWelcomeActions(firedWelcomeActions);
        }
        firedWelcomeActions.add('first-run');
        persistFiredWelcomeActions(firedWelcomeActions);
        getExtOnboardingOrchestrator().handleFirstRun();
      })
      .catch((err) => log.warn('Welcome detection failed', err));
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
// Standalone via kernel worker (opt-in, ?kernel-worker=1)
//
// The agent engine moves into a DedicatedWorker. The page keeps the UI,
// the file-browser local VFS, and the WebSocket-backed `CDPClient`; the
// worker runs Orchestrator + scoops + WasmShell pool + a worker-side
// `BrowserAPI` whose CDP commands are forwarded back to the page's
// `CDPClient` via `startPageCdpForwarder`.
//
// What's wired today:
//   - Layout (split panels)
//   - Local VFS for file-browser + memory panel + preview-vfs fallback
//   - `BrowserAPI` (page-side) → `startPageCdpForwarder` → worker
//   - `OffscreenClient` over MessageChannel as the orchestrator-shim
//   - Chat panel ⇄ `client.createAgentHandle()`
//   - `panels.scoops` / `panels.memory` ⇄ `setOrchestrator(client)`
//   - `selectScoop` flow on scoop chip click
//
// What's deferred (smoke-test will hit these as gaps):
//   - Wizard / OnboardingOrchestrator (welcome.shtml, connect-llm dip)
//   - Panel-side terminal shell (would need PanelCdpProxy or similar)
//   - Sprinkle UI rendering (sprinkle-renderer needs panel-side wiring)
//   - Cost provider via shell `cost` command (no panel→worker query yet)
//   - Skill-drop install
//   - Tray runtime sync (page ↔ worker bridge for tray join URL)
//   - publishAgentBridgeProxy (terminal `agent` shell command)
//
// `?kernel-worker=1` makes the choice explicit so smoke testing the new
// path can't accidentally regress the inline path that ships today.
// ---------------------------------------------------------------------------

async function mainStandaloneWorker(app: HTMLElement, isElectronOverlay: boolean): Promise<void> {
  log.info('starting standalone with kernel worker');

  const { spawnKernelWorker } = await import('../kernel/spawn.js');
  const { installPageStorageSync } = await import('../kernel/page-storage-sync.js');
  const { VirtualFS } = await import('../fs/index.js');
  const { BrowserAPI } = await import('../cdp/index.js');

  const layout = new Layout(app, isElectronOverlay);
  if (isElectronOverlay) {
    // Electron-overlay specifics: hide the tab-bar (Electron's chrome
    // has its own), set the initial tab from the URL hash, listen for
    // parent-frame `set-tab` messages, and bind ⌘; (Cmd-+-Semicolon)
    // to toggle the overlay window. Ported from the legacy inline
    // path so the worker mode handles overlay correctly when it's
    // the only standalone path.
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
  await layout.panels.chat.initSession('session-cone');
  log.info('Session initialized (kernel-worker mode)');

  // Local VFS for the file browser + memory panel + preview-vfs fallback.
  // Same IndexedDB as the worker's VFS, so writes from the agent are
  // visible in the file browser without round-tripping the wire.
  const localFs = await VirtualFS.create({ dbName: 'slicc-fs' });
  layout.panels.fileBrowser.setFs(localFs);

  // Recover the panel's view of mounts. The worker recovers its own
  // mounts inside `createKernelHost`; this is just the page-side
  // `localFs`'s mount table being repopulated on reload.
  void getAllMountEntries()
    .then(async (entries) => {
      if (entries.length === 0) return;
      const { needsRecovery } = await recoverMounts(entries, localFs, log);
      if (needsRecovery.length === 0) return;
      log.warn('Some mounts could not be recovered in the page VFS', {
        count: needsRecovery.length,
        paths: needsRecovery.map((r) => r.path),
      });
    })
    .catch((err) => log.warn('Failed to restore persisted mounts in page VFS', err));

  // Page-side preview-vfs fallback responder. The worker's responder is
  // the canonical one (lives inside `createKernelHost`); this fires only
  // when the worker hasn't booted yet or when the request resolves
  // against a panel-only mount.
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

  // Real CDP transport. The worker's `BrowserAPI` proxies CDP commands
  // back here through the kernel transport.
  const browser = new BrowserAPI();
  const realCdpTransport = browser.getTransport();

  let selectedScoop: RegisteredScoop | null = null;
  let client!: InstanceType<typeof OffscreenClient>;

  const selectScoop = async (scoop: RegisteredScoop): Promise<void> => {
    selectedScoop = scoop;
    client.selectedScoopJid = scoop.jid;
    layout.panels.scoops.setSelectedJid(scoop.jid);
    layout.panels.memory.setSelectedScoop(scoop.jid);
    layout.setScoopSwitcherSelected?.(scoop.jid);

    const contextId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
    const scoopName = scoop.isCone ? undefined : scoop.name;
    await layout.panels.chat.switchToContext(contextId, !scoop.isCone, scoopName);

    if (client.isProcessing(scoop.jid)) {
      layout.panels.chat.setProcessing(true);
    }
  };

  // Spawn the worker. `spawnKernelWorker` constructs the Worker via
  // Vite's `new URL` pattern, builds an `OffscreenClient` over a
  // `MessageChannel`, and starts the page-side CDP forwarder against
  // `realCdpTransport`. The init handshake transfers two MessagePorts
  // to the worker; the worker boots `createKernelHost` and posts
  // `kernel-worker-ready` over the kernel port.
  const { OffscreenClient } = await import('./offscreen-client.js');
  void OffscreenClient; // type import for the `client` variable above
  const host = spawnKernelWorker({
    realCdpTransport,
    callbacks: {
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
          void selectScoop(scoop);
        }
      },
      onScoopListUpdate: () => {
        layout.panels.scoops.refreshScoops();
        layout.refreshScoopSwitcher?.();
      },
      onIncomingMessage: (scoopJid, message) => {
        // For lick-channel messages destined to the selected scoop,
        // surface them in the chat. Persistence is handled by the
        // worker's bridge writing to IndexedDB; the chat panel reloads
        // on scoop switch.
        if (selectedScoop?.jid !== scoopJid) return;
        if (message.channel !== 'web' && isLickChannel(message.channel)) {
          layout.panels.chat.addLickMessage(
            message.id,
            message.content,
            message.channel,
            new Date(message.timestamp).getTime()
          );
        }
      },
      onReady: () => {
        log.info('Kernel worker ready, scoop count:', client.getScoops().length);
        const cone = client.getScoops().find((s) => s.isCone);
        if (cone && !selectedScoop) {
          void selectScoop(cone);
        }
      },
    },
  });
  client = host.client;

  // Wire panels to the orchestrator-shim provided by the client.
  layout.panels.scoops.setOrchestrator(client as unknown as Orchestrator);
  layout.panels.memory.setOrchestrator(client as unknown as Orchestrator);
  layout.setScoopSwitcherOrchestrator?.(client as unknown as Orchestrator);
  layout.onScoopSelect = selectScoop;

  // Wire chat agent handle. The handle's `sendMessage` posts a
  // `user-message` over the wire; the worker's bridge handles it.
  const agentHandle = client.createAgentHandle();
  layout.panels.chat.setAgent(agentHandle);
  layout.panels.chat.setAttachmentWriter(createAttachmentTmpWriter(localFs));

  // Wire delete callback — only meaningful if the underlying client
  // supports it. The orchestrator-shim's `deleteQueuedMessage` is a
  // no-op for now.
  layout.panels.chat.setDeleteQueuedMessageCallback((_messageId) => {
    log.warn('deleteQueuedMessage is a no-op in kernel-worker mode');
  });

  // Wait for the worker to finish boot. After this, request state so
  // the panel sees the cone the worker auto-created.
  try {
    await host.ready;
    log.info('Worker boot handshake complete');
  } catch (err) {
    log.error('Worker failed to signal ready', err);
    throw err;
  }
  client.requestState();

  // Sprinkle manager — runs on the page (DOM access required), with a
  // proxy on the worker's `globalThis.__slicc_sprinkleManager` so the
  // shell can reach it. The shell side of the bridge lives in
  // `kernel-worker.ts`; this side installs the dispatcher.
  const { SprinkleManager } = await import('./sprinkle-manager.js');
  const { installSprinkleManagerHandlerOverChannel } =
    await import('../scoops/sprinkle-bridge-channel.js');
  const sprinkleManager = new SprinkleManager(
    localFs,
    (event: LickEvent) => {
      if (event.type === 'sprinkle' && event.sprinkleName) {
        client.sendSprinkleLick(event.sprinkleName, event.body, event.targetScoop);
      }
    },
    {
      addSprinkle: (name, title, element, zone, options) =>
        layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined, options),
      removeSprinkle: (name) => layout.removeSprinkle(name),
    },
    () => {
      const cone = client.getScoops().find((s) => s.isCone);
      if (cone) client.stopScoop(cone.jid);
    }
  );
  (window as unknown as Record<string, unknown>).__slicc_sprinkleManager = sprinkleManager;
  const stopSprinkleHandler = installSprinkleManagerHandlerOverChannel(sprinkleManager);
  await sprinkleManager.refresh();
  layout.onSprinkleClose = (name) => sprinkleManager.close(name);
  await sprinkleManager.restoreOpenSprinkles().catch((err) => {
    log.warn('Failed to restore open sprinkles', err);
  });

  // Live page→worker localStorage sync. The worker's `localStorage`
  // is a Map-backed shim seeded at boot from
  // `KernelWorkerInitMsg.localStorageSeed`; subsequent page writes
  // (provider config, model selection, tray join URL, …) need to flow
  // through so the agent sees them without a worker restart.
  const stopStorageSync = installPageStorageSync({
    send: (msg) => client.sendRaw(msg),
  });

  // Publish a tool-ui dispatch hook so the panel-side
  // dip's button clicks route to the WORKER's `toolUIRegistry` over the
  // kernel transport, not the panel's empty registry. Without this,
  // every cone-driven dip (mount approval, confirm prompts, …) hangs
  // on user click because the agent's promise is registered in the
  // worker. `tool-ui-renderer.ts` checks for this hook and prefers it
  // over the local registry.
  (
    globalThis as typeof globalThis & {
      __slicc_tool_ui_send?: (requestId: string, action: string, data: unknown) => void;
    }
  ).__slicc_tool_ui_send = (requestId, action, data) => {
    client.sendRaw({ type: 'tool-ui-action', requestId, action, data });
  };

  // Mount the panel terminal as a `RemoteTerminalView`
  // backed by the worker's `TerminalSessionHost`. Keystrokes assemble
  // into committed lines locally; Enter dispatches each line via
  // `terminal-exec` to the worker. Mount must run AFTER `host.ready`
  // (the worker's `TerminalSessionHost` is instantiated at the tail
  // of `boot()`).
  const { RemoteTerminalView } = await import('../kernel/remote-terminal-view.js');
  const remoteTerminal = new RemoteTerminalView({ client, cwd: '/' });
  void layout.panels.terminal.mountRemoteShell(remoteTerminal).catch((err) => {
    log.error('Failed to mount remote terminal view', err);
  });

  // Cleanup on unload.
  window.addEventListener(
    'beforeunload',
    () => {
      stopStorageSync();
      stopSprinkleHandler();
      remoteTerminal.dispose();
      host.dispose();
    },
    { once: true }
  );

  // Same UI fixture / telemetry hooks as the inline path.
  if (isUIFixtureRequested()) {
    await loadUIFixtureIntoChat(layout.panels.chat);
  }
  initTelemetry().catch(() => {});

  log.info('Standalone kernel-worker UI ready');
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
  // and ensure it is controlling this page before we proceed. If the SW
  // was just installed for the first time, `navigator.serviceWorker.
  // controller` will be null even after activation — `clients.claim()`
  // attaches the page asynchronously. Without a controller, /preview/*
  // fetches fall through to the dev server and 404, which breaks dips
  // that load .shtml files (welcome dip, etc.). The standard fix is a
  // one-shot reload right after the first activation; we gate it on
  // sessionStorage to avoid loops.
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/preview-sw.js', { scope: '/preview/' });
      log.info('Preview SW registered');
      // CLI standalone only — extension mode bypasses CORS via
      // host_permissions and never needs the LLM proxy SW. Registering it
      // there would intercept side-panel fetches the extension expects to
      // reach the network directly.
      const isExtensionForSw = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
      if (!isExtensionForSw) {
        try {
          await navigator.serviceWorker.register('/llm-proxy-sw.js', { scope: '/' });
          log.info('LLM-proxy SW registered');
        } catch (err) {
          log.error('LLM-proxy SW registration failed — cross-origin LLM calls will hit CORS', err);
        }
      }
      if (!navigator.serviceWorker.controller) {
        // Wait briefly for clients.claim() to attach the page.
        await Promise.race([
          new Promise<void>((resolve) =>
            navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
              once: true,
            })
          ),
          new Promise<void>((resolve) => setTimeout(resolve, 1500)),
        ]);
      }
      if (!navigator.serviceWorker.controller && !sessionStorage.getItem('slicc-sw-reloaded')) {
        // Still uncontrolled — force one reload so both SWs can claim us.
        // This also guarantees the LLM proxy SW is active before the
        // first cross-origin provider request, otherwise the very first
        // fetch slips past it and hits CORS directly.
        sessionStorage.setItem('slicc-sw-reloaded', '1');
        log.info('Reloading once to gain SW control');
        location.reload();
        return;
      }
      sessionStorage.removeItem('slicc-sw-reloaded');
    } catch (err) {
      log.error('Preview SW registration failed — preview feature will not work', err);
    }
  }

  // Discover and register all built-in + external providers. Switched
  // from side-effect `import '../providers/index.js'` to explicit
  // async registration to break the providers/index ↔ provider-settings
  // module-cycle that the kernel worker hit in dev mode. See
  // `providers/index.ts:registerProviders` for context.
  await registerProviders();

  // Apply providers.json defaults before checking for API key
  applyProviderDefaults();

  // First-run no longer auto-opens the legacy "Add Account" dialog.
  // Provider configuration is owned by the deterministic onboarding flow
  // (welcome wizard → connect-llm dip → OnboardingOrchestrator). The user
  // can still open the legacy dialog later from the accounts/settings UI.
  const apiKey = getApiKey();
  const allowProviderlessTrayJoin = !apiKey && hasStoredTrayJoinUrl(window.localStorage);

  // Build the layout — tabbed in extension mode, split panels in standalone
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  const runtimeMode = resolveUiRuntimeMode(window.location.href, isExtension);

  // Extension mode: delegate to offscreen-backed UI
  if (runtimeMode === 'extension') {
    return mainExtension(app);
  }

  // Standalone — agent engine runs in a DedicatedWorker. The legacy
  // inline-orchestrator path was removed once user-facing parity
  // stabilized (panel terminal RPC, cone mount picker, process
  // model). If we ever need to roll back, restore the pre-removal
  // commit (see git log for "remove legacy inline-orchestrator
  // path").
  return mainStandaloneWorker(app, runtimeMode === 'electron-overlay');
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
