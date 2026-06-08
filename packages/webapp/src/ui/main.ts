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
import './styles/image-preview.css';

/**
 * Main entry point for the Browser Coding Agent UI.
 *
 * Bootstraps the layout, checks for API key, initializes the
 * orchestrator with cone + scoops, and wires events to the Chat UI.
 * Always uses cone+orchestrator mode — no direct agent path.
 */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type {
  PanelMessageSender,
  PanelMessageSubscriber,
} from '../../../chrome-extension/src/bridge-transport.js';
import { isExtensionMessage } from '../../../chrome-extension/src/messages.js';
import type { CherryHostTransport } from '../cdp/cherry-host-transport.js';
import type { BrowserAPI } from '../cdp/index.js';
import { createLogger } from '../core/index.js';
import { SessionStore as AgentSessionStore } from '../core/session.js';
import type { VirtualFS } from '../fs/index.js';
import { LocalMountBackend } from '../fs/mount/backend-local.js';
import { newMountId } from '../fs/mount/mount-id.js';
import {
  loadAndClearPendingHandle,
  openMountPickerPopup,
  reactivateHandle,
} from '../fs/mount-picker-popup.js';
import { recoverMounts } from '../fs/mount-recovery.js';
import { getAllMountEntries } from '../fs/mount-table-store.js';
import { type PanelRpcPushMsg, panelRpcChannelName } from '../kernel/panel-rpc.js';
// Auto-discover and register all providers (built-in + external).
// IMPORTANT: This import must also appear in packages/chrome-extension/src/offscreen.ts
// — the extension agent engine runs in the offscreen document, not in this file.
import { registerProviders } from '../providers/index.js';
import { clearAllMessages as clearOrchestratorMessages } from '../scoops/db.js';
import type { Orchestrator } from '../scoops/index.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import {
  getLeaderTrayRuntimeStatus,
  IndexedDbLeaderTraySessionStore,
  subscribeToLeaderTrayRuntimeStatus,
} from '../scoops/tray-leader.js';
import type { TrayLeaveResult } from '../scoops/tray-leave.js';
import {
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  DEFAULT_STAGING_TRAY_WORKER_BASE_URL,
  fetchRuntimeConfig,
  hasStoredTrayJoinUrl,
  resolveTrayRuntimeConfig,
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../scoops/tray-runtime-config.js';
import type { RegisteredScoop } from '../scoops/types.js';
import {
  detectWelcomeFirstRun,
  hasOnboardingFinalLickInHistory,
} from '../scoops/welcome-detection.js';
import {
  setConnectedFollowersGetter,
  setTrayResetter,
} from '../shell/supplemental-commands/host-command.js';
import { installSkillFromDrop } from '../skills/install-from-drop.js';
import { createAttachmentTmpWriter } from './attachment-vfs.js';
import { enterDetachedActiveState } from './detached-active.js';
// Static-import dip helpers used by the onboarding orchestrator. dip.ts is
// already pulled into the main entry chunk via chat-panel.ts/tool-ui-renderer.ts
// — dynamic-importing it here only confused rollup's chunk graph (and triggered
// the INEFFECTIVE_DYNAMIC_IMPORT warning), occasionally surfacing as a runtime
// "o is not a function" error in the fs chunk because of the resulting
// circular module-evaluation order.
import { broadcastToDips } from './dip.js';
import { createExtensionLeaderHooks } from './extension-leader-hooks.js';
import { Layout } from './layout.js';
import { isLickChannel, type LickChannel } from './lick-channels.js';
import {
  runNewSessionFreeze,
  runNewSessionFreezeQuick,
  scheduleBackgroundEnrichment,
} from './new-session.js';
import { flushCredentialsToWorker, resolveDefaultModel } from './onboarding-helpers.js';
import type { PageFollowerTrayHandle } from './page-follower-tray.js';
import { CHERRY_RUNTIME_TAG, startPageFollowerTray } from './page-follower-tray.js';
import type { PageLeaderTrayHandle, StartPageLeaderTrayOptions } from './page-leader-tray.js';
import { startPageLeaderTray } from './page-leader-tray.js';
import {
  applyProviderDefaults,
  getApiKey,
  removeAccount,
  resolveCurrentModel,
  resolveModelById,
  saveOAuthAccount,
} from './provider-settings.js';
import { createRemoteCdpPageBridge } from './remote-cdp-page-bridge.js';
import { canonicalRuntimeId } from './runtime-identity.js';
import {
  getElectronOverlayInitialTab,
  isElectronOverlaySetTabMessage,
  resolveUiRuntimeMode,
  shouldUseRuntimeModeTrayDefaults,
  type UiRuntimeMode,
} from './runtime-mode.js';
import { frozenSessionPath, parseFrozenArchive } from './session-freezer.js';
import {
  findDroppedNonSkillTransferFiles,
  findDroppedSkillTransferFile,
  hasDroppedFiles,
} from './skill-drop.js';
import { resolveSprinkleIconHtml } from './sprinkle-icon.js';
import { SprinkleManager } from './sprinkle-manager.js';
import { initTelemetry } from './telemetry.js';
import { initTheme } from './theme.js';
import { initTooltips } from './tooltip.js';
import type { ChatMessage } from './types.js';

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
  setCompactionState?: (state: 'summarizing' | 'extracting-memory' | 'idle') => void;
}): Promise<void> {
  const [{ createChatFixture, FIXTURE_SESSION_ID, FIXTURE_SCOOP_NAME }] = await Promise.all([
    import('./chat-fixture.js'),
  ]);
  await chatPanel.switchToContext(FIXTURE_SESSION_ID, true, FIXTURE_SCOOP_NAME);
  chatPanel.loadMessages(createChatFixture());
  // Optional preview of the compaction ghost bubble for designers:
  //   ?ui-fixture=1&compacting=summarizing
  //   ?ui-fixture=1&compacting=extracting-memory
  // (Anything else leaves the bubble off.)
  const params = new URLSearchParams(window.location.search);
  const compacting = params.get('compacting');
  if (compacting === 'summarizing' || compacting === 'extracting-memory') {
    chatPanel.setCompactionState?.(compacting);
  }
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
  const { getSelectedModelId, getProviderConfig, getProviderModels } = await import(
    './provider-settings.js'
  );
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

async function mainExtension(app: HTMLElement, options?: { detached?: boolean }): Promise<void> {
  const isDetachedSelf = options?.detached === true;
  const { OffscreenClient } = await import('./offscreen-client.js');
  const { VirtualFS } = await import('../fs/index.js');
  const { publishAgentBridgeProxy } = await import('../scoops/agent-bridge.js');

  const layout = new Layout(app, !isDetachedSelf);
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
    const { registerSessionCostsProvider } = await import(
      '../shell/supplemental-commands/cost-command.js'
    );
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
    client.setSelectedScoopJid(scoop.jid);
    layout.panels.memory.setSelectedScoop(scoop.jid);
    layout.setScoopSwitcherSelected?.(scoop.jid);
    layout.panels.scoops.setSelectedJid(scoop.jid);

    // switchToContext loads messages from the shared browser-coding-agent IndexedDB
    // (written by the offscreen bridge). That snapshot can drift if the side panel
    // re-mounts mid-stream (chrome.runtime reconnect, panel close/open) — its
    // `persistSession` may overwrite the bridge's writes with a near-empty list.
    // Match the standalone-worker path and ask the offscreen for the canonical
    // history; the bridge replies via `scoop-messages-replaced` and the panel's
    // `onScoopMessagesReplaced` handler swaps it in atomically.
    const contextId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
    const scoopName = scoop.isCone ? undefined : scoop.name;
    await layout.panels.chat.switchToContext(contextId, !scoop.isCone, scoopName);
    client.requestScoopMessages(scoop.jid);

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
        client.setSelectedScoopJid(scoop.jid);
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
          client.setSelectedScoopJid(cone.jid);
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
    onCompactionStateChange: (scoopJid, state) => {
      // Only render the ghost bubble in the scoop the user is looking at —
      // a different scoop compacting in the background shouldn't poke the
      // foreground chat.
      if (selectedScoop?.jid !== scoopJid) return;
      layout.panels.chat.setCompactionState(state);
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

  // Detached popout: listen for the SW's broadcast that a detached tab
  // has claimed the lock. Side panels and non-detached index.html tabs
  // self-close; the detached tab itself ignores its own echo.
  chrome.runtime.onMessage.addListener((msg) => {
    // Return false (or void/undefined) on every path so Chrome does not
    // keep sendResponse alive. This listener never responds.
    if (!isExtensionMessage(msg)) return false;
    if (msg.source !== 'service-worker') return false;
    const payloadType = (msg.payload as { type?: string }).type;
    if (payloadType !== 'detached-active') return false;

    if (isDetachedSelf) return false; // I am the claimer; ignore my own broadcast.

    enterDetachedActiveState(client, layout);
    return false;
  });

  if (isDetachedSelf) {
    chrome.runtime
      .sendMessage({
        source: 'panel',
        payload: { type: 'detached-claim' },
      })
      .catch(() => {
        // SW not ready or no receivers — Chrome's normal cold-start condition.
        // The claim is also re-emitted on Ctrl-R / reload via mainExtension boot.
      });
  }

  if (!isDetachedSelf) {
    layout.setShowPopoutButton(true);
    layout.setPopoutClickHandler(() => {
      chrome.runtime
        .sendMessage({
          source: 'panel',
          payload: { type: 'detached-popout-request' },
        })
        .catch((err) => {
          // SW unreachable or message rejected. Re-enable the button so the
          // user can retry; surface the failure in the dev console.
          console.warn('[slicc] detached-popout-request failed', err);
          layout.resetPopoutButton();
        });
    });
  }

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
      const { fetchSecretEnvVars } = await import('../core/secret-env.js');
      const secretEnv = await fetchSecretEnvVars();
      const remoteTerminal = new RemoteTerminalView({
        client,
        cwd: '/',
        env: Object.keys(secretEnv).length > 0 ? secretEnv : undefined,
      });
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

  // Wire "New session" — freeze the cone's chat to /sessions/ via the
  // freezer (memory extraction + title), then delete ONLY the cone session
  // from IndexedDB. Scoops survive intentionally so the fresh cone inherits
  // the existing scoop roster.
  //   - `freeze !== false && freeze !== 'quick'` → full freeze (default
  //     short-click). Blocks reload while the LLM call runs.
  //   - `freeze === 'quick'`                    → quick freeze (double
  //     click). Writes a pending-enrichment archive and returns fast;
  //     `enrichPendingSessions` finishes the work on the next boot.
  //   - `freeze === false`                      → discard (long press).
  //     No archive entry is written.
  layout.onClearChat = async (opts) => {
    if (opts?.freeze === 'quick') {
      try {
        await runNewSessionFreezeQuick({ vfs: localFs });
      } catch (err) {
        log.warn('Quick freezer step failed (clearing anyway)', { error: String(err) });
      }
    } else if (opts?.freeze !== false) {
      try {
        await runNewSessionFreeze({ vfs: localFs });
      } catch (err) {
        log.warn('Freezer step failed (clearing anyway)', { error: String(err) });
      }
    } else {
      log.info('New session: freezer skipped (long-press)');
    }
    await layout.panels.chat.deleteSessionById('session-cone');
    // Bridge-side cone-only clear. Awaits the bridge's ack so we don't
    // reload while the offscreen agent context is still running.
    await client.clearAllMessages();
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
  const { OnboardingOrchestrator: OnboardingOrchestratorExt } = await import(
    '../scoops/onboarding-orchestrator.js'
  );
  const broadcastToDipsExt = broadcastToDips;
  const {
    getAvailableProviders: getAvailableProvidersExt,
    getProviderConfig: getProviderConfigExt,
    getProviderModels: getProviderModelsExt,
    addAccount: addAccountExt,
    setSelectedModelId: setSelectedModelIdExt,
    getAccounts: getAccountsExt,
    isModelHiddenFromPicker: isModelHiddenFromPickerExt,
    providerOffersLlmModels: providerOffersLlmModelsExt,
  } = await import('./provider-settings.js');
  const {
    createSprinkleDeviceCodePrompter: createSprinkleDeviceCodePrompterExt,
    resolveDeviceCodeDecision: resolveDeviceCodeDecisionExt,
  } = await import('../providers/device-code-bridge.js');
  const buildExtProviderCatalogue = () => {
    const ids = getAvailableProvidersExt().filter((id) => providerOffersLlmModelsExt(id));
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
        flushCredentialsToWorker(client);
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
          if (!cfg.isOAuth || (!cfg.onOAuthLogin && !cfg.onOAuthLoginIntercepted)) {
            return { ok: false, message: 'Provider does not support OAuth.' };
          }
          if (cfg.requiresBaseUrl && baseUrl) addAccountExt(providerId, '', baseUrl);
          // Dispatch on which OAuth hook the provider declared. Intercepted
          // OAuth (xAI Grok, public clients restricted to loopback redirects)
          // needs a CDP transport; loopback URI is captured via
          // `Fetch.requestPaused` without binding a real local port.
          if (cfg.onOAuthLoginIntercepted) {
            const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
              '../providers/oauth-service.js'
            );
            const launcher = await createInterceptingOAuthLauncherForCurrentRuntime();
            if (!launcher) {
              return {
                ok: false,
                message:
                  'Intercepted OAuth requires the controlled-browser transport — open SLICC in standalone or extension mode.',
              };
            }
            await cfg.onOAuthLoginIntercepted(launcher, () => undefined, {
              presentDeviceCode: createSprinkleDeviceCodePrompterExt({
                broadcastToDip: broadcastToDipsExt,
              }),
            });
          } else if (cfg.onOAuthLogin) {
            const { createOAuthLauncher } = await import('../providers/oauth-service.js');
            const launcher = createOAuthLauncher();
            await cfg.onOAuthLogin(launcher, () => undefined);
          }
          return {
            ok: true,
            model: resolveDefaultModel(
              providerId,
              cfg,
              getProviderModelsExt,
              isModelHiddenFromPickerExt
            ),
          };
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
      welcomeAction === 'device-code-decision' ||
      welcomeAction === 'shortcut-migrate';
    if (!isWelcomeFlowAction) return false;

    const body = event.body as Record<string, unknown> | null;
    const action = welcomeAction;

    if (action === 'device-code-decision') {
      // Sprinkle relayed the user's Cancel / Copy & Continue click —
      // resolve the pending DeviceCodePrompter so the provider's
      // device-flow login proceeds or aborts. Always intercept the
      // lick so it never reaches the cone.
      const decision = (body?.data as { decision?: unknown } | undefined)?.decision;
      resolveDeviceCodeDecisionExt(decision === 'cancel' ? 'cancel' : 'continue');
      return true;
    }
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
      minimizeSprinkle: (name) => layout.minimizeSprinkle(name),
      registerSprinkle: (name, title, opts) =>
        layout.registerSprinkle(
          name,
          title,
          opts?.icon,
          opts?.zone as 'primary' | 'drawer' | undefined
        ),
      unregisterSprinkle: (name) => layout.unregisterSprinkle(name),
      closeSprinkleContent: (name) => layout.closeSprinkleContent(name),
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
      onAttachImage: (base64, name, mimeType) =>
        layout.panels.chat.addImageAttachment(base64, name, mimeType),
      inlineSprinkles: INLINE_DIP_SPRINKLES,
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
  // Rail-icon clicks: the manager routes attention-mode promotions
  // and registered-but-closed opens through a single entry point so
  // launcher-style icons reuse the existing activation channel.
  layout.onSprinkleActivate = (name) => {
    void sprinkleManager.activate(name);
  };
  // Every sprinkle now lives in the rail from boot — the [+] picker
  // has nothing left to surface for sprinkles. Returning an empty
  // list keeps the picker shell available for other panel types.
  layout.getAvailableSprinkles = () => [];
  layout.onOpenSprinkle = (name, zone) => sprinkleManager.open(name, zone);
  layout.resolveSprinkleIcon = (spec) => resolveSprinkleIconHtml(spec, localFs);
  layout.updateAddButtons();
  await sprinkleManager.restoreOpenSprinkles();

  // ── Follower sprinkle sync (extension follower mode) ───────────────
  // When the extension acts as a tray follower, the offscreen document hosts
  // the `FollowerSyncManager` (it has signaling + WebRTC). DOM-bound sprinkle
  // rendering lives here in the side panel. The panel↔offscreen bridge in
  // `chrome-extension/src/follower-sprinkle-bridge.ts` carries the
  // `follower-sprinkles-list` / `follower-sprinkle-update` /
  // `follower-sprinkle-fetch` / `follower-sprinkle-fetch-result` /
  // `follower-sprinkle-lick` runtime envelopes between them (these wrap the
  // leader-facing wire messages `sprinkles.list` / `sprinkle.update` /
  // `sprinkle.content` / `sprinkle.fetch` / `sprinkle.lick`, which only the
  // offscreen sees on the WebRTC channel). The controller shares layout
  // callbacks with the local `SprinkleManager` above — leader-pushed
  // sprinkles surface in the same rail as local ones. If the offscreen is
  // not in follower mode, no `follower-sprinkles-list` envelopes arrive
  // and the controller stays idle; pending fetches reject via the proxy's
  // bounded `DEFAULT_FETCH_TIMEOUT_MS` so the controller doesn't pin the
  // `opening` set forever.
  const { PanelFollowerSprinkleProxy } = await import(
    '../../../chrome-extension/src/follower-sprinkle-bridge.js'
  );
  const { SprinkleFollowerController } = await import('./sprinkle-follower-controller.js');
  const followerSprinkleSender = {
    send(envelope: { source: 'panel'; payload: unknown }): void {
      chrome.runtime.sendMessage(envelope).catch((err: unknown) => {
        // "Receiving end does not exist" is expected when no offscreen is
        // awake (or the extension is not in follower mode). The proxy's
        // bounded fetch timeout will surface the failure to the controller.
        // Anything else (extension context invalidated, message size
        // exceeded, non-cloneable payloads) is logged so the failure is
        // observable in DevTools.
        const msg = err instanceof Error ? err.message : String(err);
        if (/receiving end does not exist/i.test(msg)) return;
        // `error` not `warn` — prod default log level is ERROR. The
        // documented failure modes are all real bugs requiring
        // investigation.
        log.error('Panel → offscreen sendMessage failed', { error: msg });
      });
    },
  };
  const followerSprinkleSubscriber = {
    onMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void {
      const listener = (msg: unknown): boolean => {
        if (!msg || typeof msg !== 'object' || !('source' in msg) || !('payload' in msg)) {
          return false;
        }
        handler(msg as { source: string; payload: unknown });
        return false;
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },
  };
  let followerSprinkleController: InstanceType<typeof SprinkleFollowerController> | null = null;
  const followerSprinkleProxy = new PanelFollowerSprinkleProxy(
    followerSprinkleSender,
    followerSprinkleSubscriber,
    {
      onSprinklesList: (sprinkles) => void followerSprinkleController?.updateAvailable(sprinkles),
      onSprinkleUpdate: (name, data) =>
        followerSprinkleController?.handleSprinkleUpdate(name, data),
    }
  );
  followerSprinkleController = new SprinkleFollowerController({
    sync: followerSprinkleProxy,
    addSprinkle: (name, title, element, zone, opts) =>
      layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined, opts),
    removeSprinkle: (name) => layout.removeSprinkle(name),
  });

  // ── Extension-leader-mode panel hooks ──────────────────────────────
  // Activation/deactivation is driven by offscreen via
  // `leader-mode-changed`; the helper (see `extension-leader-hooks.ts`)
  // holds the four panel-only push handlers and the install/remove
  // lifecycle. This block just stands up the production transports —
  // chrome.runtime in, chrome.runtime out — and hands them off.
  const leaderSyncSender: PanelMessageSender = {
    send(envelope) {
      chrome.runtime.sendMessage(envelope).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/receiving end does not exist/i.test(msg)) return;
        log.error('Panel → offscreen sendMessage failed (leader)', { error: msg });
      });
    },
  };
  const leaderSyncSubscriber: PanelMessageSubscriber = {
    onMessage(handler) {
      const listener = (msg: unknown): boolean => {
        if (!msg || typeof msg !== 'object' || !('source' in msg) || !('payload' in msg)) {
          return false;
        }
        handler(msg as { source: string; payload: unknown });
        return false;
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },
  };
  const leaderHooks = createExtensionLeaderHooks({
    sender: leaderSyncSender,
    subscriber: leaderSyncSubscriber,
    sprinkleManager,
    client,
    chat: layout.panels.chat,
    log,
  });
  // Dispose on unload — mirrors the `host.dispose()` pattern in
  // `offscreen.ts` (kernel host teardown on unload). Without this the
  // chrome.runtime listener leaks across HMR cycles, and any in-flight
  // resetTray timers float.
  window.addEventListener('beforeunload', () => leaderHooks.dispose(), { once: true });

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

  // Page-side handler for nuke-reload broadcasts. The offscreen shell
  // can't reload the side panel directly; nuke broadcasts a reload
  // request and the panel listens.
  const { installNukeReloadListener } = await import(
    '../shell/supplemental-commands/nuke-command.js'
  );
  installNukeReloadListener();

  // `?ui-fixture=1` — same design-time override as the CLI path, but run
  // last so the normal extension boot (state sync, scoop selection) has
  // populated the sidebar before we overwrite the chat view.
  if (isUIFixtureRequested()) {
    await loadUIFixtureIntoChat(layout.panels.chat);
  }

  // Initialize operational telemetry (fire-and-forget)
  initTelemetry().catch(() => {});

  // Background enrichment of pending-frozen sessions. Each impatient
  // double-click on the new-session button leaves a `pendingEnrichment`
  // entry in `/sessions/index.json` with a heuristic title; this pass
  // re-runs the LLM calls and rewrites the archive title + appends the
  // extracted memories to `/workspace/CLAUDE.md` (the cone-private memory
  // sink — `/shared/CLAUDE.md` is left untouched). Deferred behind
  // `requestIdleCallback` (or `setTimeout(0)` as a fallback) so a slow
  // enrichment never blocks first paint.
  scheduleBackgroundEnrichment(localFs);
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

async function mainStandaloneWorker(app: HTMLElement, runtimeMode: UiRuntimeMode): Promise<void> {
  const isElectronOverlay = runtimeMode === 'electron-overlay';
  log.info('starting standalone with kernel worker');

  const { spawnKernelWorker } = await import('../kernel/spawn.js');
  const { installPageStorageSync } = await import('../kernel/page-storage-sync.js');
  const { VirtualFS } = await import('../fs/index.js');
  const { BrowserAPI } = await import('../cdp/index.js');

  // Resolve the tray worker base URL from /api/runtime-config so consumers
  // like oauth-code-exchange's `getWorkerBaseUrl` read a value that matches
  // the float the user actually launched (staging under `--dev`, production
  // otherwise). Without this, a stale localStorage value from an older
  // session keeps surfacing — the prior inline standalone path did this
  // before it was removed in 07cdce16.
  const runtimeConfig = await fetchRuntimeConfig();
  const runtimeDefaultWorkerBaseUrl = shouldUseRuntimeModeTrayDefaults(
    isElectronOverlay ? 'electron-overlay' : 'standalone',
    runtimeConfig !== null
  )
    ? __DEV__
      ? DEFAULT_STAGING_TRAY_WORKER_BASE_URL
      : DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL
    : null;
  await resolveTrayRuntimeConfig({
    locationHref: window.location.href,
    storage: window.localStorage,
    envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
    defaultWorkerBaseUrl: runtimeDefaultWorkerBaseUrl,
    runtimeConfigFetcher: async () => runtimeConfig,
  });

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
  // back here through the kernel transport. We must connect the
  // underlying `CDPClient` proactively: the worker-side `BrowserAPI`
  // has its own `ensureConnected()` (which flips its `CdpTransportBridge`
  // state to 'connected' inside the worker, decoupled from the wire),
  // but every `cdp-cmd` envelope it forwards ultimately lands in
  // `startPageCdpForwarder` → `realTransport.send(...)`. If this
  // `CDPClient` is still in `disconnected` state at that moment, the
  // send throws "CDP client is not connected" and the agent sees
  // confusing errors for `playwright`, `open`, etc.
  let browser: BrowserAPI;
  let cherryJoinUrl: string | undefined;
  let cherryTransport: CherryHostTransport | undefined;
  if (runtimeMode === 'cherry') {
    const { setupCherryFollower } = await import('./main-cherry.js');
    const cherry = await setupCherryFollower();
    browser = cherry.browser;
    cherryJoinUrl = cherry.joinUrl;
    cherryTransport = cherry.transport;
  } else {
    browser = new BrowserAPI();
    try {
      await browser.connect();
    } catch (err) {
      log.warn(
        'Initial CDP connect failed; worker-forwarded commands will retry on demand',
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  const realCdpTransport = browser.getTransport();

  // Expose the page-side BrowserAPI so the OAuth intercept launcher
  // (active-transport.ts) can resolve a CDP transport from the main
  // thread — the kernel-worker publishes its own __slicc_browser in
  // host.ts, but the settings dialog and OAuth click handlers run on
  // the page realm where that global isn't visible.
  (globalThis as Record<string, unknown>).__slicc_browser = browser;

  let selectedScoop: RegisteredScoop | null = null;
  let client!: InstanceType<typeof OffscreenClient>;

  // Sync the brain icon to the active scoop's resolved model + persisted
  // thinking-level. Mirrors `syncThinkingButtonForExtensionScoop` in
  // `mainExtension`. The legacy inline standalone path had an equivalent
  // helper; it was lost in 07cdce16 ("remove legacy inline-orchestrator
  // standalone path") and never re-wired here, so the brain icon stayed
  // hidden in standalone-worker mode regardless of model capability.
  const syncThinkingButtonForScoop = (scoop: RegisteredScoop): void => {
    const modelId = scoop.config?.modelId;
    const model = modelId ? resolveModelById(modelId) : resolveCurrentModel();
    layout.panels.chat.setModelSupportsReasoning(
      !!model.reasoning,
      getSupportedThinkingLevels(model).includes('xhigh')
    );
    layout.panels.chat.setThinkingLevel(scoop.config?.thinkingLevel);
  };

  const selectScoop = async (scoop: RegisteredScoop): Promise<void> => {
    selectedScoop = scoop;
    client.setSelectedScoopJid(scoop.jid);
    layout.panels.scoops.setSelectedJid(scoop.jid);
    layout.panels.memory.setSelectedScoop(scoop.jid);
    layout.setScoopSwitcherSelected?.(scoop.jid);

    const contextId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
    const scoopName = scoop.isCone ? undefined : scoop.name;
    await layout.panels.chat.switchToContext(contextId, !scoop.isCone, scoopName);

    // Ask the worker for the canonical chat history. The worker is the
    // source of truth (it owns the live `AgentMessage[]`); the panel's
    // own `browser-coding-agent` IDB can drift if the panel re-mounts
    // mid-conversation (HMR, full reload). The reply lands as a
    // `scoop-messages-replaced` event handled below and replaces the
    // panel's view atomically.
    client.requestScoopMessages(scoop.jid);

    if (client.isProcessing(scoop.jid)) {
      layout.panels.chat.setProcessing(true);
    }

    syncThinkingButtonForScoop(scoop);
  };

  // Per-instance discriminator so same-origin RPC channels (sprinkle
  // bridge today; future BroadcastChannel users tomorrow) stay scoped
  // to one tab/worker pair. Generated once per page boot and forwarded
  // to the worker through `kernel-worker-init`. Two SLICC tabs on the
  // same origin would otherwise share a global channel name and end up
  // handling each other's sprinkle ops.
  const instanceId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `slicc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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
    instanceId,
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
      onScoopMessagesReplaced: (scoopJid, messages) => {
        if (selectedScoop?.jid !== scoopJid) return;
        // Replace the panel's view of the scoop with the worker's
        // canonical history. The worker's
        // `handleRequestScoopMessages` persists the rebuilt buffer
        // back to the shared `browser-coding-agent` IDB before
        // emitting (when it rebuilds from agent messages or hydrates
        // from the session-store fallback), so the next reload picks
        // up the same view. The buffered-only path skips the persist
        // because the buffer's content already came FROM the active
        // streaming pipeline, which keeps writing through
        // `persistScoop` on each agent event.
        layout.panels.chat.loadMessages(messages as unknown as ChatMessage[]);
      },
      onCompactionStateChange: (scoopJid, state) => {
        // Render the ghost bubble only in the scoop the user is viewing —
        // a background scoop's compaction shouldn't perturb the foreground.
        if (selectedScoop?.jid !== scoopJid) return;
        layout.panels.chat.setCompactionState(state);
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

  // Wire clear chat — must drive the IDB clears from the PAGE in
  // standalone, because the kernel worker is a DedicatedWorker that
  // `location.reload()` tears down moments after this handler returns —
  // possibly before its own `clear-chat` handler has finished persisting.
  // Mirrors what `orchestrator.clearAllMessages` does, minus the
  // in-memory bits that the soon-to-respawn worker doesn't carry across
  // the reload. Three same-origin IDBs to clear:
  //  - `slicc-groups.messages` — inter-scoop ChannelMessage history
  //  - `agent-sessions`        — per-scoop AgentMessage[] (the actual
  //                              conversation memory the LLM resumes from)
  //  - `browser-coding-agent`  — the panel's view cache
  // The extension path doesn't need this — its offscreen document
  // survives the side-panel reload, so its `clear-chat` handler has time
  // to complete.
  layout.onClearChat = async () => {
    await clearOrchestratorMessages().catch(() => {});
    await new AgentSessionStore().clearAll().catch(() => {});
    const scoops = client.getScoops();
    for (const scoop of scoops) {
      const sessionId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
      await layout.panels.chat.deleteSessionById(sessionId);
    }
    // Fire-and-forget; the page-side IDB writes above are what survive
    // the reload. This just keeps the worker's in-memory buffers tidy
    // in case the reload races us.
    client.clearAllMessages();
  };

  // Brain-icon wiring (mirrors `mainExtension`).
  // - `onModelChange`: persist the user's choice locally so the worker's
  //   storage shim sees the same `selected-model` it would after reload,
  //   ask the worker to refresh its resolved model, and re-sync the
  //   thinking button (different models support different levels).
  // - `onThinkingLevelChange`: persist the brain-icon cycle into the
  //   active scoop's `config.thinkingLevel` over the wire.
  // - `onModelsRefreshed`: provider-account add/remove can flip a model
  //   from unavailable→available (or vice versa); re-sync so the brain
  //   reflects the post-refresh capabilities.
  layout.onModelChange = (modelId) => {
    localStorage.setItem('selected-model', modelId);
    client.updateModel();
    if (selectedScoop) syncThinkingButtonForScoop(selectedScoop);
  };
  layout.onThinkingLevelChange = (level) => {
    if (!selectedScoop) return;
    client.setScoopThinkingLevel(selectedScoop.jid, level);
  };
  layout.onModelsRefreshed = () => {
    if (selectedScoop) syncThinkingButtonForScoop(selectedScoop);
  };

  // Wire local VFS to client so the memory panel (which surfaces
  // `/shared/CLAUDE.md` via `client.getGlobalMemory()` and the cone-
  // private `/workspace/CLAUDE.md` via the scoop FS) sees the actual
  // file system. Without this the panel reads empty in standalone-worker
  // mode — only the extension path was calling setLocalFS before.
  client.setLocalFS(localFs);

  // Wire "New session" — freeze the cone's chat to /sessions/ via the
  // freezer (memory extraction + title), then clear ONLY the cone
  // session via the kernel client. Scoops survive intentionally so the
  // fresh cone inherits the existing scoop roster.
  //   - `freeze !== false && freeze !== 'quick'` → full freeze (default
  //     short-click). Blocks reload while the LLM call runs.
  //   - `freeze === 'quick'`                    → quick freeze (double
  //     click). Writes a pending-enrichment archive and returns fast;
  //     `enrichPendingSessions` finishes the work on the next boot.
  //   - `freeze === false`                      → discard (long press).
  //     No archive entry is written.
  layout.onClearChat = async (opts) => {
    if (opts?.freeze === 'quick') {
      try {
        await runNewSessionFreezeQuick({ vfs: localFs });
      } catch (err) {
        log.warn('Quick freezer step failed (clearing anyway)', { error: String(err) });
      }
    } else if (opts?.freeze !== false) {
      try {
        await runNewSessionFreeze({ vfs: localFs });
      } catch (err) {
        log.warn('Freezer step failed (clearing anyway)', { error: String(err) });
      }
    } else {
      log.info('New session: freezer skipped (long-press)');
    }
    await layout.panels.chat.deleteSessionById('session-cone');
    await client.clearAllMessages();
  };

  // Frozen sessions sidebar (standalone only). The panel reads
  // /sessions/index.json from the page-side VFS that already shares
  // IndexedDB with the worker. Clicking an entry reads the archive
  // markdown, parses it back into messages, and displays it in the
  // chat panel read-only — matching the affordance of clicking a
  // live scoop (which also opens the chat view rather than a file).
  layout.panels.scoops.setVfs(localFs);
  layout.onFrozenSessionOpen = (entry) => {
    void (async () => {
      try {
        const raw = await localFs.readFile(frozenSessionPath(entry), { encoding: 'utf-8' });
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        const parsed = parseFrozenArchive(text);
        const title = parsed.title || entry.title;
        await layout.panels.chat.displayFrozenSession({
          contextId: `frozen:${entry.filename}`,
          messages: parsed.messages,
          title,
        });
        layout.setThreadHeaderName(`❄ ${title}`);
        layout.setActiveTab('chat');
      } catch (err) {
        log.warn('Failed to open frozen session', {
          filename: entry.filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };

  // Glow the New Session button as the live cone session grows past
  // half the active model's context window. Coarse chars/4 estimate
  // is enough — the goal is an affordance, not a billing meter.
  layout.panels.chat.onMessagesChanged = (estimatedTokens) => {
    let contextWindow = 200000;
    try {
      const model = resolveCurrentModel();
      contextWindow = model.contextWindow ?? contextWindow;
    } catch {
      /* no active model — keep the default and the gauge stays cold */
    }
    const ratio = estimatedTokens / contextWindow;
    layout.setNewSessionGlow(ratio);
  };

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

  // Install localStorage sync interceptor immediately — before any
  // onboarding or provider-settings writes can happen. Placing this
  // after `await host.ready` ensures the worker's bridge is ready to
  // receive messages; placing it here (not 300+ lines later) closes
  // the window where writes between the seed snapshot and the
  // interceptor install would be silently dropped.
  //
  // Also push a full snapshot of the current localStorage so any
  // writes that occurred after `collectLocalStorageSeed()` (called
  // inside `spawnKernelWorker`) but before this point are not lost.
  // This is idempotent: the worker's shim just overwrites each key
  // with the same or newer value.
  const stopStorageSync = installPageStorageSync({
    send: (msg) => client.sendRaw(msg),
  });
  // Skip keys that are unforwardable:
  //   - 'setItem'/'removeItem'/'clear' — junk written by a previous broken
  //     interceptor (Object.defineProperty on Storage instance)
  //   - keys containing NUL — installPageStorageSync drops them too; sending
  //     them here would create a diverged view in the worker's shim
  const STORAGE_SKIP = new Set(['setItem', 'removeItem', 'clear']);
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null && !STORAGE_SKIP.has(k) && !k.includes('\0')) {
      const v = localStorage.getItem(k);
      if (v !== null) {
        client.sendRaw({ type: 'local-storage-set', key: k, value: v });
      }
    }
  }

  // Sprinkle manager — runs on the page (DOM access required), with a
  // proxy on the worker's `globalThis.__slicc_sprinkleManager` so the
  // shell can reach it. The shell side of the bridge lives in
  // `kernel-worker.ts`; this side installs the dispatcher.
  const { SprinkleManager } = await import('./sprinkle-manager.js');
  const { installSprinkleManagerHandlerOverChannel } = await import(
    '../scoops/sprinkle-bridge-channel.js'
  );

  // ── Welcome / onboarding wiring (mirrors `mainExtension`) ──────────
  //
  // The deterministic welcome flow is driven by the on-page
  // `OnboardingOrchestrator`, NOT by the cone — the cone has no API
  // key configured at this point and any lick that reaches it would
  // fatal with "No API key configured for provider …". Both lick
  // entry points (the `SprinkleManager` panel-sprinkle handler and
  // chat-panel `onDipLick` for inline dips in chat history) need to
  // short-circuit welcome-flow actions and hand them to the
  // orchestrator instead. The lazy `getOnboardingOrchestrator()` is
  // constructed on first lick so it can capture `sprinkleManager`
  // (defined just below) by reference.
  const firedWelcomeActions = loadFiredWelcomeActions();
  const { OnboardingOrchestrator: OnboardingOrchestratorWorker } = await import(
    '../scoops/onboarding-orchestrator.js'
  );
  // Dynamic import (matches `mainExtension`) — keeps the static
  // import surface small and avoids dragging the full
  // provider-settings module into the early boot graph.
  const {
    addAccount,
    getAccounts,
    getAvailableProviders,
    getProviderConfig,
    getProviderModels,
    isModelHiddenFromPicker,
    setSelectedModelId,
    providerOffersLlmModels,
  } = await import('./provider-settings.js');
  const { createSprinkleDeviceCodePrompter, resolveDeviceCodeDecision } = await import(
    '../providers/device-code-bridge.js'
  );
  let workerOnboardingOrchestrator: InstanceType<typeof OnboardingOrchestratorWorker> | null = null;
  // `sprinkleManager` is assigned just below; closures reference the
  // binding, not the value, so the orchestrator's lazy construction
  // can safely use it once at-least-one welcome lick fires.

  let sprinkleManager!: InstanceType<typeof SprinkleManager>;
  const getOnboardingOrchestrator = () => {
    if (workerOnboardingOrchestrator) return workerOnboardingOrchestrator;
    workerOnboardingOrchestrator = new OnboardingOrchestratorWorker({
      fs: localFs,
      postSystemMessage: (line) => layout.panels.chat.addSystemMessage(line),
      postDipReference: (md) => layout.panels.chat.addSystemMessage(md),
      getProviderCatalogue: buildWorkerProviderCatalogue,
      saveAccount: (id, key, baseUrl, deployment, apiVersion) =>
        addAccount(id, key, baseUrl, deployment, apiVersion),
      setSelectedModel: (id) => setSelectedModelId(id),
      resolveModelLabel: (provider, modelId) => {
        try {
          const found = getProviderModels(provider).find((m) => m.id === modelId);
          return found?.name ?? null;
        } catch {
          return null;
        }
      },
      broadcastToDip: (payload) => broadcastToDips(payload),
      fireFinalLick: (data) => {
        flushCredentialsToWorker(client);
        const action = String((data as { action?: unknown })?.action ?? '');
        dispatchWelcomeLickOnce(
          action,
          firedWelcomeActions,
          () => client.sendSprinkleLick('welcome', data),
          'orchestrator-worker'
        );
      },
      launchOAuth: async (providerId, baseUrl) => {
        try {
          const cfg = getProviderConfig(providerId);
          if (!cfg.isOAuth || (!cfg.onOAuthLogin && !cfg.onOAuthLoginIntercepted)) {
            return { ok: false, message: 'Provider does not support OAuth.' };
          }
          if (cfg.requiresBaseUrl && baseUrl) addAccount(providerId, '', baseUrl);
          if (cfg.onOAuthLoginIntercepted) {
            const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
              '../providers/oauth-service.js'
            );
            const launcher = await createInterceptingOAuthLauncherForCurrentRuntime();
            if (!launcher) {
              return {
                ok: false,
                message:
                  'Intercepted OAuth requires the controlled-browser transport — open SLICC in standalone or extension mode.',
              };
            }
            await cfg.onOAuthLoginIntercepted(launcher, () => undefined, {
              presentDeviceCode: createSprinkleDeviceCodePrompter({
                broadcastToDip: (payload) => broadcastToDips(payload),
              }),
            });
          } else if (cfg.onOAuthLogin) {
            const { createOAuthLauncher } = await import('../providers/oauth-service.js');
            const launcher = createOAuthLauncher();
            await cfg.onOAuthLogin(launcher, () => undefined);
          }
          return {
            ok: true,
            model: resolveDefaultModel(providerId, cfg, getProviderModels, isModelHiddenFromPicker),
          };
        } catch (err) {
          return {
            ok: false,
            message: err instanceof Error ? err.message : 'OAuth login failed.',
          };
        }
      },
    });
    return workerOnboardingOrchestrator;
  };

  // Mirrors `interceptWelcomeLickExt` in `mainExtension`. Returns
  // `true` when the lick was handled locally (do NOT forward to the
  // cone). Source-of-truth comments on each branch live in the
  // extension copy — keep these in sync.
  const interceptWelcomeLick = (event: LickEvent): boolean => {
    if (event.type !== 'sprinkle') return false;
    const welcomeAction =
      event.sprinkleName === 'welcome' || event.sprinkleName === 'inline'
        ? ((event.body as Record<string, unknown> | null)?.action as string | undefined)
        : undefined;
    if (welcomeAction && DEDUPED_WELCOME_ACTIONS.has(welcomeAction)) {
      if (firedWelcomeActions.has(welcomeAction)) {
        log.debug('Suppressing duplicate welcome lick (worker)', { action: welcomeAction });
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
      welcomeAction === 'device-code-decision' ||
      welcomeAction === 'shortcut-migrate';
    if (!isWelcomeFlowAction) return false;

    const body = event.body as Record<string, unknown> | null;
    const action = welcomeAction;

    if (action === 'device-code-decision') {
      // See `mainExtension`'s mirror branch for the rationale — resolves
      // the pending DeviceCodePrompter so the github-copilot device flow
      // proceeds (Copy & Continue) or aborts (Cancel).
      const decision = (body?.data as { decision?: unknown } | undefined)?.decision;
      resolveDeviceCodeDecision(decision === 'cancel' ? 'cancel' : 'continue');
      return true;
    }
    if (action === 'first-run') {
      getOnboardingOrchestrator().handleFirstRun();
      return true;
    }
    if (action === 'onboarding-complete') {
      const orch = getOnboardingOrchestrator();
      const profile = (body?.data as Record<string, unknown> | undefined) ?? {};
      if ((profile as Record<string, unknown>).mountWorkspace) {
        applyPendingMount(localFs).catch((err) =>
          log.warn('Failed to mount workspace from onboarding', err)
        );
      }
      void orch
        .handleOnboardingComplete(profile as Record<string, unknown>)
        .catch((err) => log.warn('OnboardingOrchestrator failed', err));
      return true;
    }
    if (action === 'connect-ready') {
      // Reload short-circuit: if the user already configured a
      // provider in a previous session, fast-forward the dip.
      const accounts = getAccounts();
      if (accounts.length > 0) {
        const primary = accounts[0];
        const cfg = (() => {
          try {
            return getProviderConfig(primary.providerId);
          } catch {
            return null;
          }
        })();
        broadcastToDips({
          type: 'slicc-already-connected',
          provider: primary.providerId,
          note: cfg?.name ? `Already connected to ${cfg.name}.` : 'Already connected.',
        });
        void fireFastForwardFinalLick(localFs, primary.providerId, (data) => {
          const finalAction = String((data as { action?: unknown }).action ?? '');
          dispatchWelcomeLickOnce(
            finalAction,
            firedWelcomeActions,
            () => client.sendSprinkleLick('welcome', data),
            'fast-forward-worker'
          );
        }).catch((err) => log.warn('Failed to fire fast-forward final lick', err));
        return true;
      }
      getOnboardingOrchestrator().handleConnectReady();
      return true;
    }
    if (action === 'connect-attempt') {
      const data = body?.data as Record<string, unknown> | undefined;
      if (data) {
        void getOnboardingOrchestrator()
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
        void getOnboardingOrchestrator()
          .handleOAuthAttempt({
            provider: String(data.provider ?? ''),
            baseUrl: typeof data.baseUrl === 'string' && data.baseUrl ? String(data.baseUrl) : null,
          })
          .catch((err) => log.warn('handleOAuthAttempt failed', err));
      }
      return true;
    }
    if (action === 'shortcut-migrate') {
      void localFs
        .writeFile('/shared/.welcomed', '1')
        .catch((err) => log.warn('Failed to persist welcome completion marker', err));
      return true;
    }
    return false;
  };

  // Inline-dip lick callback. The welcome dip mounts as an inline
  // `<img>`-hydrated dip in chat history, so its licks reach us
  // through this path rather than the SprinkleManager.
  layout.panels.chat.onDipLick = (action: string, data: unknown) => {
    const event: LickEvent = {
      type: 'sprinkle',
      sprinkleName: 'inline',
      targetScoop: undefined,
      timestamp: new Date().toISOString(),
      body: { action, data },
    };
    if (interceptWelcomeLick(event)) return;
    // Follower mode: the dip lives in the leader's mirrored chat, so its
    // lick belongs to the leader's cone (sending it locally would record
    // a click against a conversation that doesn't contain the dip; on a
    // typical follower the local cone also has no provider login to handle
    // it). Mirrors how panel-rendered follower sprinkles forward via
    // SprinkleFollowerController → sync.sendSprinkleLick.
    // Predicate is `pageFollowerTray` (set on join, cleared only on permanent
    // leave) rather than `?.currentSync` (transiently null during WebRTC
    // reconnects) — we'd rather log+drop a dip click than reroute it back
    // to the model-less local cone.
    if (pageFollowerTray) {
      const sync = pageFollowerTray.currentSync;
      if (sync) {
        sync.sendSprinkleLick('inline', { action, data });
      } else {
        log.warn('Dip lick dropped: follower sync mid-reconnect', { action });
      }
      return;
    }
    client.sendSprinkleLick('inline', { action, data });
  };

  sprinkleManager = new SprinkleManager(
    localFs,
    async (event: LickEvent) => {
      if (event.type === 'sprinkle') {
        if (interceptWelcomeLick(event)) {
          // shortcut-migrate may need to close the welcome panel —
          // the helper marks it intercepted but doesn't have a
          // sprinkleManager reference. Do the close here.
          if ((event.body as Record<string, unknown> | null)?.action === 'shortcut-migrate') {
            sprinkleManager.close('welcome');
          }
          return;
        }
        if (event.sprinkleName) {
          client.sendSprinkleLick(event.sprinkleName, event.body, event.targetScoop);
        }
      }
    },
    {
      addSprinkle: (name, title, element, zone, options) =>
        layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined, options),
      removeSprinkle: (name) => layout.removeSprinkle(name),
      minimizeSprinkle: (name) => layout.minimizeSprinkle(name),
      registerSprinkle: (name, title, opts) =>
        layout.registerSprinkle(
          name,
          title,
          opts?.icon,
          opts?.zone as 'primary' | 'drawer' | undefined
        ),
      unregisterSprinkle: (name) => layout.unregisterSprinkle(name),
      closeSprinkleContent: (name) => layout.closeSprinkleContent(name),
    },
    () => {
      const cone = client.getScoops().find((s) => s.isCone);
      if (cone) client.stopScoop(cone.jid);
    },
    {
      onAttachImage: (base64, name, mimeType) =>
        layout.panels.chat.addImageAttachment(base64, name, mimeType),
      inlineSprinkles: INLINE_DIP_SPRINKLES,
    }
  );
  (window as unknown as Record<string, unknown>).__slicc_sprinkleManager = sprinkleManager;
  const stopSprinkleHandler = installSprinkleManagerHandlerOverChannel(sprinkleManager, {
    instanceId,
  });

  // Hoisted forward-declaration of the page-side tray handles. They
  // are populated by the tray init block below, but several earlier
  // wirings (panel-RPC `tray-reset` handler) need to close over them.
  // The closures read the current value at call time, so the
  // assignment happening later is fine.
  let pageLeaderTray: PageLeaderTrayHandle | null = null;
  let pageFollowerTray: PageFollowerTrayHandle | null = null;

  // Remote-CDP driving bridge (issue #848): the kernel worker's BrowserAPI
  // drives federated tray/cherry targets by tunneling CDP over panel-RPC
  // to this page-side bridge, which owns the real RemoteCDPTransport via
  // `pageLeaderTray.sync`. CDP events flow back as `remote-cdp-event`
  // pushes on a dedicated channel instance (same instance-scoped name).
  // This channel is intentionally page→worker push only: the worker's
  // `createPanelRpcClient` (a different realm) receives these, and the
  // page never consumes from it (a BroadcastChannel doesn't deliver to
  // the instance that posted).
  const remoteCdpPushChannel =
    typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(panelRpcChannelName(instanceId))
      : null;
  const remoteCdpBridge = createRemoteCdpPageBridge({
    getSync: () => pageLeaderTray?.sync ?? null,
    postEvent: (payload) => {
      const msg: PanelRpcPushMsg = { type: 'panel-rpc-push', op: 'remote-cdp-event', payload };
      remoteCdpPushChannel?.postMessage(msg);
    },
  });

  // Register a handler so the kernel worker's forward-lick messages
  // reach the live follower sync. The handler reads `pageFollowerTray`
  // lazily — at registration time the handle is null (not yet assigned),
  // but the handler body runs only after a follower connection goes live
  // and the worker starts emitting forward-lick events.
  client.setForwardLickHandler((event) => {
    const sync = pageFollowerTray?.currentSync;
    if (sync) sync.forwardLick(event);
    else log.warn('forward-lick dropped: no active follower sync');
  });

  /**
   * Build the full `StartPageLeaderTrayOptions` for the in-scope deps
   * (layout, client, sprinkleManager, browser, etc.). Used by the boot
   * block below AND by `performTrayLeave` during a follower → leader
   * (or inactive → leader) switch — extracted to avoid duplicating ~85
   * lines of option wiring across two call sites.
   *
   * Reads `pageLeaderTray` lazily in the broadcast callbacks because
   * the handle is assigned by the caller *after* this function returns
   * the options bag. Callers must `setLeader(newHandle)` immediately
   * after `startPageLeaderTray(options)` resolves.
   */
  const buildLeaderTrayOptions = (workerBaseUrl: string): StartPageLeaderTrayOptions => ({
    workerBaseUrl,
    getMessages: () => layout.panels.chat.getMessages(),
    getScoopJid: () => selectedScoop?.jid ?? 'cone',
    getScoops: () =>
      client.getScoops().map((s) => ({
        jid: s.jid,
        name: s.name,
        folder: s.folder,
        isCone: s.isCone,
        assistantLabel: s.assistantLabel,
        trigger: s.trigger,
      })),
    getSprinkles: () => {
      const opened = new Set(sprinkleManager.opened());
      return sprinkleManager.available().map((p) => ({
        name: p.name,
        title: p.title,
        path: p.path,
        open: opened.has(p.name),
        autoOpen: p.autoOpen,
      }));
    },
    readSprinkleContent: async (sprinkleName: string) => {
      const sprinkle = sprinkleManager.available().find((s) => s.name === sprinkleName);
      if (!sprinkle) return null;
      try {
        const raw = await localFs.readFile(sprinkle.path, { encoding: 'utf-8' });
        return typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
      } catch {
        return null;
      }
    },
    onSprinkleLick: (
      sprinkleName: string,
      body: unknown,
      targetScoop?: string,
      originLabel?: string
    ) => client.sendSprinkleLick(sprinkleName, body, targetScoop, originLabel),
    onForwardedLick: (event) => client.sendForwardedLick(event),
    onFollowerMessage: (text, messageId, attachments) => {
      layout.panels.chat.addUserMessage(text, attachments);
      agentHandle.sendMessage(text, messageId, attachments);
      pageLeaderTray?.sync.broadcastUserMessage(text, messageId, attachments);
    },
    onFollowerAbort: () => agentHandle.stop(),
    onFollowerCountChanged: (_count) => {
      const followerPeers = pageLeaderTray?.peers.getPeers() ?? [];
      window.localStorage.setItem(
        'slicc.leaderTrayFollowers',
        JSON.stringify(
          followerPeers.map((p) => ({
            runtimeId: canonicalRuntimeId(p.bootstrapId),
            runtime: p.runtime,
            connectedAt: p.connectedAt ?? undefined,
          }))
        )
      );
    },
    onRemoteTransportsCleaned: (runtimeId) => remoteCdpBridge.cleanupRuntime(runtimeId),
    sendWebhookEvent: (id, headers, body) => client.sendWebhookEvent(id, headers, body),
    onCherryHostEvent: (runtimeId, name, detail) =>
      client.sendCherryHostEvent(runtimeId, name, detail),
    onAgentEvent: (handler) => agentHandle.onEvent(handler),
    browserAPI: browser,
    browserTransport: realCdpTransport,
    vfs: localFs,
  });

  /**
   * Wire the leader-only hooks against the live handle. Called after
   * `startPageLeaderTray` resolves successfully (both at boot and on
   * `performTrayLeave` role-switch). The `null`-clearing counterpart
   * is `clearLeaderHooks` below.
   */
  const wireLeaderHooks = (handle: PageLeaderTrayHandle): void => {
    setConnectedFollowersGetter(() =>
      handle.peers.getPeers().map((p) => ({
        runtimeId: canonicalRuntimeId(p.bootstrapId),
        runtime: p.runtime,
        connectedAt: p.connectedAt ?? undefined,
      }))
    );
    setTrayResetter(() => handle.reset());
    sprinkleManager.setSendToSprinkleHook((name, data) =>
      handle.sync.broadcastSprinkleUpdate(name, data)
    );
    layout.panels.chat.setOnLocalUserMessage((text, messageId, attachments) =>
      handle.sync.broadcastUserMessage(text, messageId, attachments)
    );
  };

  const clearLeaderHooks = (): void => {
    setConnectedFollowersGetter(null);
    setTrayResetter(null);
    layout.panels.chat.setOnLocalUserMessage(undefined);
    sprinkleManager.setSendToSprinkleHook(undefined);
    remoteCdpBridge.disposeAll();
  };

  /**
   * Shared between the `slicc:tray-leave` window event listener (the
   * avatar popover dispatches this) and the panel-RPC `tray-leave` op
   * (the worker-side `host leave`). The implementation lives in
   * `ui/tray-leave-runtime.ts` so it can be unit tested against
   * synthetic deps.
   *
   * Captures `pageLeaderTray` / `pageFollowerTray` via getters/setters
   * so the closure reads the live binding at call time rather than
   * snapshotting a stale value at deps-construction time.
   */
  const performTrayLeaveLocally = async (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult> => {
    const { performTrayLeave } = await import('./tray-leave-runtime.js');
    return await performTrayLeave(
      { workerBaseUrl: opts.workerBaseUrl, requestId: opts.requestId },
      {
        getLeader: () => pageLeaderTray,
        setLeader: (h) => {
          pageLeaderTray = h;
        },
        getFollower: () => pageFollowerTray,
        setFollower: (h) => {
          pageFollowerTray = h as PageFollowerTrayHandle | null;
        },
        startLeader: (workerBaseUrl) => startPageLeaderTray(buildLeaderTrayOptions(workerBaseUrl)),
        clearLeaderHooks,
        wireLeaderHooks,
        storage: window.localStorage,
        log,
      }
    );
  };

  // Install the panel-RPC handler so DOM-bound shell commands run by
  // the kernel worker (screencapture / say / afplay / clipboard /
  // open, plus the playwright app-origin lookup) can reach the page.
  // `imgcat` is intentionally terminal-only and stays out of the
  // bridge — it's meant for the in-panel terminal, not the agent.
  //
  // `tray-reset` is the special case: the leader tray subsystem runs
  // on the page (`RTCDataChannel` non-transferability), so `host reset`
  // typed in the worker terminal has to bridge here to reach
  // `pageLeaderTray.reset()`. The callback reads the current value of
  // `pageLeaderTray` so it picks up assignments made after install.
  const { installPanelRpcHandler } = await import('../kernel/panel-rpc.js');
  const { createStandalonePanelRpcHandlers } = await import('./panel-rpc-handlers.js');
  const stopPanelRpcHandler = installPanelRpcHandler({
    instanceId,
    handlers: createStandalonePanelRpcHandlers({
      resetTray: async () => {
        if (!pageLeaderTray) {
          throw new Error('no active tray session to reset');
        }
        return await pageLeaderTray.reset();
      },
      // Worker-side `host leave` bridges through panel-RPC for the same
      // reason as `tray-reset`: the leader/follower tray handles own
      // non-transferable WebRTC resources and live on the page.
      leaveTray: async ({ workerBaseUrl, requestId }) =>
        await performTrayLeaveLocally({ workerBaseUrl, requestId }),
      // Worker-side `cherry-emit` bridges here so a cone → host
      // `slicc.event` reaches the page-side LeaderSyncManager. Reads the
      // live `pageLeaderTray` binding so it picks up a leader started
      // after install; returns false when no leader is active (the
      // command already gates on a connected cherry runtime).
      emitCherrySliccEvent: (runtimeId, name, detail) =>
        pageLeaderTray?.sync.emitCherrySliccEvent(runtimeId, name, detail) ?? false,
      // Worker-side `serve` bridges here so the kernel-worker `serve` command
      // can mint a preview URL via the page-side leader's controllerToken,
      // then broadcast preview.open through the page-side LeaderSyncManager.
      // Extension uses the in-realm `setPreviewMinter` hook instead.
      mintPreview: async ({ entryPath, servedRoot, bridge, noBridge }) => {
        const sync = pageLeaderTray?.currentLeaderSync;
        if (!sync) {
          throw new Error('serve: no active leader tray; cannot mint preview');
        }
        const status = getLeaderTrayRuntimeStatus();
        const session = status.session;
        if (!session) {
          throw new Error('serve: leader tray has no active session');
        }
        const controllerUrl = new URL(session.controllerUrl);
        const controllerToken = controllerUrl.pathname.split('/').pop() ?? '';
        const { CHERRY_RUNTIME_TAG } = await import('../scoops/tray-sync-protocol.js');
        const { mintPreviewViaWorker } = await import(
          '../shell/supplemental-commands/preview-mint-client.js'
        );
        // Cherry-attached followers default --bridge:true; --no-bridge always wins.
        const hasCherryFollower = sync
          .getConnectedFollowers()
          .some((f) => f.runtime === CHERRY_RUNTIME_TAG);
        const effectiveAllowLive = !noBridge && (bridge || hasCherryFollower);
        const { url } = await mintPreviewViaWorker({
          workerBaseUrl: session.workerBaseUrl,
          trayId: session.trayId,
          controllerToken,
          servedRoot,
          entryPath,
          allowLive: effectiveAllowLive,
        });
        sync.broadcastPreviewOpen(url);
        return { url, pushed: sync.getConnectedFollowers().length };
      },
      // Bridge remote (follower) browser targets to the worker-side
      // playwright-cli. The worker's BrowserAPI has no trayTargetProvider
      // so listAllTargets() falls back to local CDP only; this callback
      // fetches from the page-side BrowserAPI which is fully wired.
      listRemoteTargets: () => browser.listAllTargets(),
      remoteCdp: remoteCdpBridge,
    }),
  });
  // Tear down on session reload so the handler doesn't outlive its
  // page (the channel would still receive requests and try to call
  // into a torn-down DOM).
  window.addEventListener(
    'beforeunload',
    () => {
      stopPanelRpcHandler();
      remoteCdpBridge.disposeAll();
      remoteCdpPushChannel?.close();
    },
    { once: true }
  );

  await sprinkleManager.refresh();
  layout.onSprinkleClose = (name) => sprinkleManager.close(name);
  // Rail-icon clicks route to `activate`: promotes attention-mode
  // entries, opens registered-but-closed entries, no-ops otherwise.
  layout.onSprinkleActivate = (name) => {
    void sprinkleManager.activate(name);
  };
  layout.getAvailableSprinkles = () => [];
  layout.onOpenSprinkle = (name, zone) => sprinkleManager.open(name, zone);
  layout.resolveSprinkleIcon = (spec) => resolveSprinkleIconHtml(spec, localFs);
  layout.updateAddButtons();
  await sprinkleManager.restoreOpenSprinkles().catch((err) => {
    log.warn('Failed to restore open sprinkles', err);
  });

  // ─── Multi-browser sync (tray) page-side restoration ──────────────────────
  //
  // Re-instate the leader and follower tray subsystems that commit 07cdce16
  // deleted. Both halves live page-side (LeaderSyncManager and
  // FollowerSyncManager depend on page state that can't follow into the
  // kernel worker, and RTCDataChannel objects can't cross the boundary).
  // The only worker-side dependency — LickManager — is reached via the new
  // `lick-webhook-event` bridge message wired into client.sendWebhookEvent.
  //
  // Gated identically to pre-regression: a stored join URL means this
  // instance is a follower; otherwise a configured worker base URL means
  // it's a leader; if neither is set, the feature is dormant.
  //
  // See docs/superpowers/specs/2026-05-17-multi-browser-sync-page-side-restoration.md
  // (pageLeaderTray / pageFollowerTray are forward-declared above so the
  // panel-RPC handler can close over them.)
  {
    const storedJoinUrl = window.localStorage.getItem(TRAY_JOIN_STORAGE_KEY);
    const storedWorkerBaseUrl = window.localStorage.getItem(TRAY_WORKER_STORAGE_KEY);
    if (runtimeMode === 'hosted-leader') {
      // A persisted /data/profile (which survives e2b pause/resume) could carry
      // a stale TRAY_JOIN_STORAGE_KEY from a prior follower role. For hosted-leader
      // we ALWAYS start as leader; clear the join key so the existing branch
      // below cannot route us into the follower path on this or any subsequent boot.
      //
      // NOTE: not unit-tested. main.ts has no test scaffold today; building one
      // for this 3-line branch isn't worth the cost. The behavior is covered
      // indirectly by the live e2b harness (Phase 5.1) — a sandbox booted with
      // a stale TRAY_JOIN_STORAGE_KEY would join an unreachable follower and
      // /tmp/slicc-join.json would never appear, surfacing in the start poll
      // timeout. If a regression slips, the live harness catches it.
      window.localStorage.removeItem(TRAY_JOIN_STORAGE_KEY);

      // ALSO clear the persisted leader session from IndexedDB. After a
      // pause/resume + leader-restart kick, Chrome's Page.reload re-runs
      // main.ts, but IndexedDB survives. Without this clear, LeaderTrayManager
      // would reuse the stale session, the on-worker tray would be gone
      // (or its leaderKey expired), and either we'd silently sit on dead
      // credentials or attachWithRecovery would create a new tray but the
      // refresh path is fragile. Forcing a fresh tray on every hosted-leader
      // boot guarantees onLeaderReady fires with new credentials → POST
      // /api/cloud-status → laptop sees a fresh updatedAt and unblocks resume.
      await new IndexedDbLeaderTraySessionStore().clear();

      // resolveTrayRuntimeConfig already ran earlier in mainStandaloneWorker
      // (~main.ts:1708) — by the time we reach the tray block, it has fetched
      // /api/runtime-config (which node-server's --hosted mode populates from
      // SLICC_TRAY_WORKER_BASE_URL) and seeded TRAY_WORKER_STORAGE_KEY in
      // localStorage. Reuse that value rather than re-fetching.
      const workerBaseUrl = window.localStorage.getItem(TRAY_WORKER_STORAGE_KEY);
      if (!workerBaseUrl) {
        throw new Error(
          'hosted-leader: TRAY_WORKER_STORAGE_KEY not seeded — runtime-config resolution failed'
        );
      }

      pageLeaderTray = startPageLeaderTray({
        ...buildLeaderTrayOptions(workerBaseUrl),
        runtime: 'slicc-hosted-leader',
        kind: 'hosted',
        onLeaderReady: (session) => {
          // TODO: handle POST failures (currently best-effort; if the cloud orchestrator
          // never sees this, --cloud start times out with diagnostic from start.ts polling).
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
          }).catch((err) => {
            log.error('failed to POST /api/cloud-status', { error: String(err) });
          });
        },
      });
      wireLeaderHooks(pageLeaderTray);

      // Inject pre-acquired provider credentials AFTER the tray AND the first
      // follower has had time to establish WebRTC. Writing to localStorage
      // propagates to the kernel-worker's shim, which triggers a re-init that
      // breaks any in-flight WebRTC peer setup → followers stuck at
      // LEADER_CONNECTED.
      //
      // 5s after page boot covers the worst-case extension cold start; the
      // user can't realistically type a message in that window, so the agent
      // sees the Adobe account by its first lazy init.
      void (async () => {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const res = await fetch('/api/hosted-bootstrap');
          if (!res.ok) return;
          const boot = (await res.json()) as {
            model?: string;
            accounts?: import('@slicc/cloud-core/cone-config').Account[];
            adobeImsToken?: string;
          };
          const accounts =
            boot.accounts ??
            (boot.adobeImsToken
              ? [{ providerId: 'adobe', kind: 'oauth' as const, accessToken: boot.adobeImsToken }]
              : []);
          if (boot.model) localStorage.setItem('selected-model', boot.model);
          else if (!localStorage.getItem('selected-model'))
            localStorage.setItem('selected-model', 'adobe:claude-opus-4-6');
          const { applyHostedAccounts } = await import('./hosted-config-apply.js');
          const prevManaged = JSON.parse(
            localStorage.getItem('slicc_cloud_managed') ?? '[]'
          ) as string[];
          await applyHostedAccounts(accounts, {
            saveOAuthAccount,
            addAccount,
            removeAccount,
            currentProviderIds: () => getAccounts().map((a) => a.providerId),
            previouslyManaged: () => prevManaged,
          });
          localStorage.setItem(
            'slicc_cloud_managed',
            JSON.stringify(accounts.map((a) => a.providerId))
          );
          log.info('hosted-leader: cone config applied', { count: accounts.length });
        } catch (err) {
          log.warn('hosted-leader: bootstrap fetch failed; provider needs manual login', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    } else if (runtimeMode === 'cherry' && cherryJoinUrl) {
      pageFollowerTray = startPageFollowerTray({
        joinUrl: cherryJoinUrl,
        runtime: CHERRY_RUNTIME_TAG,
        onSnapshot: (messages) => layout.panels.chat.loadMessages(messages),
        onUserMessage: (text, _messageId, _scoopJid, attachments) =>
          layout.panels.chat.addUserMessage(text, attachments),
        onStatus: (status) => layout.panels.chat.setProcessing(status === 'processing'),
        // Outbound cone → host bridge: the leader's `cherry-emit` lands here as a
        // `cherry.slicc_event`; forward it to the host page's `onSliccEvent` hook
        // via the iframe transport. The iframe only ever lends its own single
        // host page, so no target needs to be disambiguated on this side.
        onCherrySliccEvent: (name, detail) => cherryTransport?.emitSliccEventToHost(name, detail),
        setChatAgent: (agent) => layout.panels.chat.setAgent(agent),
        browserAPI: browser,
        addSprinkle: (name, title, element, zone, options) =>
          layout.addSprinkle(
            name,
            title,
            element,
            zone as 'primary' | 'drawer' | undefined,
            options
          ),
        removeSprinkle: (name) => layout.removeSprinkle(name),
      });
      // Inbound host → cone bridge: the host page's `handle.emitHostEvent` posts
      // a `host.event` to the iframe transport; forward it to the leader as a
      // `cherry.host_event` so it surfaces as a `cherry` lick on the cone. Read
      // `currentSync` lazily so a reconnect (new sync instance) still routes.
      if (cherryTransport) {
        cherryTransport.onHostEvent = (name, detail) =>
          pageFollowerTray?.currentSync?.sendCherryHostEvent(name, detail);
      }
    } else if (storedJoinUrl) {
      pageFollowerTray = startPageFollowerTray({
        joinUrl: storedJoinUrl,
        onSnapshot: (messages) => layout.panels.chat.loadMessages(messages),
        onUserMessage: (text, _messageId, _scoopJid, attachments) =>
          layout.panels.chat.addUserMessage(text, attachments),
        onStatus: (status) => layout.panels.chat.setProcessing(status === 'processing'),
        setChatAgent: (agent) => layout.panels.chat.setAgent(agent),
        browserAPI: browser,
        onForwardingToggle: (enabled) => client.sendSetFollowerForwarding(enabled),
        // Follower-side sprinkle rendering: the leader broadcasts `sprinkles.list`,
        // and the `SprinkleFollowerController` (inside `startPageFollowerTray`)
        // mirrors the open-state by fetching `.shtml` content over the data
        // channel and rendering through the same layout callbacks the local
        // `SprinkleManager` uses for its own local sprinkles. Name collisions
        // with locally-discovered sprinkles are possible but rare — the
        // follower is typically running against an empty/disconnected VFS for
        // sprinkle discovery purposes.
        addSprinkle: (name, title, element, zone, options) =>
          layout.addSprinkle(
            name,
            title,
            element,
            zone as 'primary' | 'drawer' | undefined,
            options
          ),
        removeSprinkle: (name) => layout.removeSprinkle(name),
      });
    } else if (storedWorkerBaseUrl) {
      // Build options + wire hooks via the same helpers `performTrayLeave`
      // uses on a role switch — keeps boot and switch locked to a single
      // set of callbacks so they can't drift out of step.
      pageLeaderTray = startPageLeaderTray(buildLeaderTrayOptions(storedWorkerBaseUrl));
      wireLeaderHooks(pageLeaderTray);
    }
  }

  // Propagate page-side leader status into the worker's localStorage shim so
  // `host` in the terminal (running in the kernel worker) can read the live
  // state. `installPageStorageSync` forwards page-side localStorage writes to
  // the worker via `local-storage-set` messages that update its Map-backed shim.
  subscribeToLeaderTrayRuntimeStatus((status) => {
    window.localStorage.setItem('slicc.leaderTrayStatus', JSON.stringify(status));
  });
  window.localStorage.setItem(
    'slicc.leaderTrayStatus',
    JSON.stringify(getLeaderTrayRuntimeStatus())
  );

  // Runtime tray-join: the settings dialog dispatches this event when the
  // user pastes a join URL and clicks "Connect". Wire a listener so the
  // follower tray starts immediately without requiring a page reload.
  // (The extension path uses chrome.runtime.sendMessage → `refresh-tray-runtime`
  // instead; this is the standalone equivalent.)
  window.addEventListener('slicc:tray-join', (rawEvent: Event) => {
    const event = rawEvent as CustomEvent<{ joinUrl: string; requestId?: string }>;
    const joinUrl = event.detail?.joinUrl;
    // Echo the dispatcher's requestId (when present) on any failure
    // event so the dispatcher's listener can filter — double-Connect
    // attempts otherwise bleed errors between their respective UX
    // surfaces. Legacy callers without requestId still work (the
    // dispatcher's filter accepts undefined).
    const requestId = event.detail?.requestId;
    if (!joinUrl) {
      // `error`, not `warn` — the only emitters are SLICC's own UI
      // surfaces, so a missing `joinUrl` is a dispatcher contract
      // violation. Prod log level is ERROR, so anything less is
      // suppressed and the bug goes invisible.
      log.error('slicc:tray-join fired without joinUrl — UI dispatcher contract violation');
      return;
    }

    // Null the leader ref BEFORE calling `.stop()` so any reentrant
    // code path triggered during teardown (cached getter consumers
    // like `getConnectedFollowers`, microtasks already scheduled
    // against the leader's sync, follower-stop side-effects) sees the
    // post-teardown state rather than a still-pointed-but-destroying
    // leader. Each `.stop()` and `startPageFollowerTray` then gets
    // its own try block so a throw at one step doesn't skip the
    // teardown of later steps.
    const leaderToStop = pageLeaderTray;
    pageLeaderTray = null;
    setConnectedFollowersGetter(null);
    setTrayResetter(null);
    layout.panels.chat.setOnLocalUserMessage(undefined);
    sprinkleManager.setSendToSprinkleHook(undefined);
    const previousFollower = pageFollowerTray;
    pageFollowerTray = null;

    try {
      leaderToStop?.stop();
    } catch (err) {
      // `error`, not `warn` — `LeaderTrayHandle.stop()` is not
      // internally guarded, so a throw mid-sequence (e.g. `sync.stop()`
      // failing during a follower send) leaves the inner sub-stops
      // un-run. The user could end up with a zombie WebSocket /
      // RTCPeerConnection / ping timer. Prod log gate is ERROR so
      // `warn` would silently absorb this leak.
      log.error('Leader stop threw during tray-join switch — runtime resources may have leaked', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      previousFollower?.stop();
    } catch (err) {
      log.error(
        'Previous follower stop threw during tray-join switch — runtime resources may have leaked',
        {
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }

    try {
      // Mirror the boot-path follower options exactly — especially
      // `addSprinkle` / `removeSprinkle`. `startPageFollowerTray`
      // silently no-ops follower sprinkle rendering when those are
      // omitted (`page-follower-tray.ts` gates the controller on their
      // presence), so a hot-join would otherwise give chat sync but
      // no sprinkle sync until the next page reload.
      pageFollowerTray = startPageFollowerTray({
        joinUrl,
        onSnapshot: (messages) => layout.panels.chat.loadMessages(messages),
        onUserMessage: (text, _messageId, _scoopJid, attachments) =>
          layout.panels.chat.addUserMessage(text, attachments),
        onStatus: (status) => layout.panels.chat.setProcessing(status === 'processing'),
        setChatAgent: (agent) => layout.panels.chat.setAgent(agent),
        browserAPI: browser,
        onForwardingToggle: (enabled) => client.sendSetFollowerForwarding(enabled),
        addSprinkle: (name, title, element, zone, options) =>
          layout.addSprinkle(
            name,
            title,
            element,
            zone as 'primary' | 'drawer' | undefined,
            options
          ),
        removeSprinkle: (name) => layout.removeSprinkle(name),
      });
    } catch (err) {
      // Half-state: leader stopped, follower never started, chat agent
      // not swapped. The next chat send would route to the local cone
      // instead of the (non-existent) remote leader — possibly leaking
      // a message intended for the remote runtime. We can't recover
      // automatically (would have to re-read TRAY_WORKER_STORAGE_KEY
      // and rebuild the leader, duplicating boot logic), so the user
      // path is a page reload — but we MUST surface the failure to
      // UI listeners so the settings dialog (or any other dispatcher)
      // can render a toast / banner.
      log.error(
        'slicc:tray-join handler failed — runtime is in a half-state, page reload required',
        {
          joinUrl,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      try {
        window.dispatchEvent(
          new CustomEvent('slicc:tray-join-failed', {
            detail: {
              joinUrl,
              error: err instanceof Error ? err.message : String(err),
              requestId,
            },
          })
        );
      } catch (dispatchErr) {
        // A synchronous listener throw is absorbed by DOM dispatch,
        // but `new CustomEvent(...)` itself can throw if `detail` is
        // non-cloneable (theoretical — strings are cloneable today,
        // but a future refactor that drops an Error object in
        // `detail` would trip this). Logging here ensures the
        // original failure is at least recorded.
        log.error('slicc:tray-join-failed dispatch itself threw', {
          dispatchError: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
        });
      }
    }
  });

  // Runtime tray-leave: symmetric counterpart to `slicc:tray-join`. The
  // avatar popover dispatches this when the user wants to drop out of
  // the tray (or switch to leader role on a supplied worker URL).
  // Shares `performTrayLeaveLocally` with the panel-RPC `tray-leave`
  // op so the shell `host leave` command and the UI button drive the
  // same teardown sequence.
  //
  // `performTrayLeave` (in `tray-leave-runtime.ts`) logs internally on
  // both the stop-throw and start-throw paths; this catch covers the
  // remaining rare throws (e.g., a programmer error in the closure
  // wiring above) so an unhandled rejection doesn't surface in
  // production telemetry.
  window.addEventListener('slicc:tray-leave', (rawEvent: Event) => {
    const event = rawEvent as CustomEvent<{
      workerBaseUrl?: string | null;
      requestId?: string;
    }>;
    const workerBaseUrl = event.detail?.workerBaseUrl ?? null;
    const requestId = event.detail?.requestId;
    void performTrayLeaveLocally({ workerBaseUrl, requestId }).catch((err) => {
      log.error('slicc:tray-leave handler failed', {
        workerBaseUrl,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  // Tear down on page unload so the WebSocket and any open data channels
  // close cleanly. Best-effort — beforeunload is not guaranteed to fire
  // on every navigation, but the tray worker's session TTL handles the
  // gap if it doesn't.
  window.addEventListener(
    'beforeunload',
    () => {
      pageLeaderTray?.stop();
      pageFollowerTray?.stop();
    },
    { once: true }
  );

  // First-run detection. Mirrors the extension's logic at the bottom
  // of `mainExtension`: only fire when `/shared/.welcomed` is absent
  // AND the cone's persisted chat has no prior welcome lick. Trust
  // the install state over the persisted ledger so a stale entry
  // from a previous install doesn't suppress the welcome on a fresh
  // boot (e.g. after `nuke 1234`, where `slicc:welcome-flow-fired`
  // is cleared by the page-side reload listener but the in-memory
  // copy of `firedWelcomeActions` already loaded earlier in this
  // function might still hold "first-run" from a legacy session).
  if (!hasStoredTrayJoinUrl(window.localStorage)) {
    detectWelcomeFirstRun(localFs)
      .then((result) => {
        if (!result.isFirstRun) return;
        if (firedWelcomeActions.has('first-run')) {
          log.info('Clearing stale welcome dedup entry — install state is fresh');
          firedWelcomeActions.delete('first-run');
          persistFiredWelcomeActions(firedWelcomeActions);
        }
        firedWelcomeActions.add('first-run');
        persistFiredWelcomeActions(firedWelcomeActions);
        getOnboardingOrchestrator().handleFirstRun();
      })
      .catch((err) => log.warn('Welcome detection failed', err));
  }

  // Worker-side provider catalogue (same shape as `buildExtProviderCatalogue`).
  function buildWorkerProviderCatalogue() {
    const ids = getAvailableProviders().filter((id) => providerOffersLlmModels(id));
    const providers = ids
      .map((id) => {
        const cfg = getProviderConfig(id);
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
        models[id] = getProviderModels(id)
          .filter((m) => !isModelHiddenFromPicker(m.id))
          .map((m) => ({ id: m.id, name: m.name }));
      } catch {
        models[id] = [];
      }
    }
    return { providers, models };
  }

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
  const { fetchSecretEnvVars: fetchSecretEnvVarsForPanel } = await import('../core/secret-env.js');
  const panelSecretEnv = await fetchSecretEnvVarsForPanel();
  const remoteTerminal = new RemoteTerminalView({
    client,
    cwd: '/',
    env: Object.keys(panelSecretEnv).length > 0 ? panelSecretEnv : undefined,
  });
  void layout.panels.terminal.mountRemoteShell(remoteTerminal).catch((err) => {
    log.error('Failed to mount remote terminal view', err);
  });

  // Page-side handler for nuke-reload broadcasts. The shell now lives
  // in the kernel worker where `location.reload()` is a no-op, so the
  // nuke command broadcasts a reload request and the page listens.
  const { installNukeReloadListener } = await import(
    '../shell/supplemental-commands/nuke-command.js'
  );
  const stopNukeListener = installNukeReloadListener();

  // Cleanup on unload.
  window.addEventListener(
    'beforeunload',
    () => {
      stopStorageSync();
      stopSprinkleHandler();
      stopNukeListener();
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

  // Background enrichment of pending-frozen sessions (see the extension
  // path for rationale). Fire-and-forget after the boot-critical wiring
  // is in place so a slow enrichment never blocks first paint.
  scheduleBackgroundEnrichment(localFs);

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
  if (typeof chrome !== 'undefined' && chrome?.runtime?.id) return;

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

  // Connect mode (?connect=1) is served by the cloudflare worker, which has NO
  // /api/fetch-proxy — so the llm-proxy SW (scope '/') would 404 every
  // cross-origin fetch (e.g. GitHub OAuth). It must not control this page.
  // Unregister any SW left from a prior full-app visit on this origin and reload
  // once to detach, then proceed SW-free. Detected inline so it gates before the
  // registration below; mirrors resolveUiRuntimeMode's `connect=1` check.
  const isConnectModeForSw = (() => {
    try {
      return new URL(window.location.href).searchParams.get('connect') === '1';
    } catch {
      return false;
    }
  })();
  if ('serviceWorker' in navigator && isConnectModeForSw) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
      if (
        navigator.serviceWorker.controller &&
        !sessionStorage.getItem('slicc-connect-sw-cleared')
      ) {
        sessionStorage.setItem('slicc-connect-sw-cleared', '1');
        log.info('connect mode: detaching from service worker (no proxy on worker origin)');
        location.reload();
        return;
      }
      sessionStorage.removeItem('slicc-connect-sw-cleared');
    } catch (err) {
      log.error('connect-mode SW cleanup failed', err);
    }
  }

  // Register preview service worker (serves VFS content at /preview/*)
  // and ensure it is controlling this page before we proceed. If the SW
  // was just installed for the first time, `navigator.serviceWorker.
  // controller` will be null even after activation — `clients.claim()`
  // attaches the page asynchronously. Without a controller, /preview/*
  // fetches fall through to the dev server and 404, which breaks dips
  // that load .shtml files (welcome dip, etc.). The standard fix is a
  // one-shot reload right after the first activation; we gate it on
  // sessionStorage to avoid loops. Skipped in connect mode (handled above —
  // the worker origin has no /api/fetch-proxy, so no SW should control it).
  if ('serviceWorker' in navigator && !isConnectModeForSw) {
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

  // Bootstrap OAuth replicas — re-pushes OAuth tokens to the proxy/SW
  // replica on init AND silently renews any expired token via the provider's
  // onSilentRenew hook (page context: window available for IMS iframe).
  // Awaited so the kernel-worker starts with fresh tokens — otherwise scoops
  // race the renewal and hit "session expired". Bounded by a soft timeout
  // so a hung IMS popup doesn't deadlock the UI.
  const { bootstrapOAuthReplicas } = await import('./oauth-bootstrap.js');
  await Promise.race([
    bootstrapOAuthReplicas().catch((err) => {
      log.error('OAuth bootstrap failed', err);
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);

  // First-run no longer auto-opens the legacy "Add Account" dialog.
  // Provider configuration is owned by the deterministic onboarding flow
  // (welcome wizard → connect-llm dip → OnboardingOrchestrator). The user
  // can still open the legacy dialog later from the accounts/settings UI.
  const apiKey = getApiKey();
  const _allowProviderlessTrayJoin = !apiKey && hasStoredTrayJoinUrl(window.localStorage);

  // Resolve UI runtime mode from chrome.runtime.id and URL query.
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  const runtimeMode = resolveUiRuntimeMode(window.location.href, isExtension);

  // Connect mode (?connect=1): slim provider-login + accounts + model-picker UI.
  // Used by /cloud dashboard for shared localStorage account provisioning.
  if (runtimeMode === 'connect') {
    (globalThis as Record<string, unknown>).__slicc_connect_mode = true;
    const { mountConnectSurface } = await import('./connect-surface.js');
    await mountConnectSurface(app);
    return;
  }

  // Detached extension tab (?detached=1): standalone-density Layout with
  // the offscreen agent. See docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md
  if (runtimeMode === 'extension-detached') {
    return mainExtension(app, { detached: true });
  }

  // Side panel or non-detached index.html tab.
  if (runtimeMode === 'extension') {
    return mainExtension(app);
  }

  // Standalone — agent engine runs in a DedicatedWorker. The legacy
  // inline-orchestrator path was removed once user-facing parity
  // stabilized (panel terminal RPC, cone mount picker, process
  // model). If we ever need to roll back, restore the pre-removal
  // commit (see git log for "remove legacy inline-orchestrator
  // path").
  return mainStandaloneWorker(app, runtimeMode);
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
