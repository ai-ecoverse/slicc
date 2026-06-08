/**
 * `setup-extension-sprinkle.ts` — extension-mode SprinkleManager wiring
 * extracted verbatim from `mainExtension`. Constructs the manager,
 * registers the worker-relay sprinkle-op handler, installs rail and
 * picker callbacks, and refreshes/restores opened sprinkles.
 *
 * Standalone has its own variant (kernel-worker forwards sprinkle ops
 * over the kernel transport, not chrome.runtime).
 */

import type { VirtualFS } from '../../fs/index.js';
import {
  loadAndClearPendingHandle,
  openMountPickerPopup,
  reactivateHandle,
} from '../../fs/mount-picker-popup.js';
import { createRemoteSprinkleVfs } from '../../kernel/remote-sprinkle-vfs.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import { setDipExecHandler } from '../dip.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { resolveSprinkleIconHtml } from '../sprinkle-icon.js';
import { SprinkleManager } from '../sprinkle-manager.js';
import { storePendingMount } from './setup-pending-mount.js';
import { createSprinkleExecHandler } from './setup-sprinkle-exec.js';
import type { BootStageLogger } from './types.js';

export interface ExtensionSprinkleSetupDeps {
  layout: Layout;
  client: OffscreenClient;
  localFs: VirtualFS;
  /** Either a `RemoteWritableVfsClient` (OPFS leader) or the local
   *  `VirtualFS` (flag off; structurally satisfies `WritableVfsClient`). */
  writableFs: WritableVfsClient;
  useRpcVfs: boolean;
  inlineSprinkles: ReadonlySet<string>;
  /** Welcome-lick interceptor (returns true → don't forward to cone). */
  interceptWelcomeLick(event: LickEvent): boolean;
  log: BootStageLogger;
}

/**
 * Construct the extension-side SprinkleManager, wire up the relay
 * handler, install rail callbacks, refresh + restore opened sprinkles.
 * Returns the manager so leader-hooks setup can reuse the reference.
 */
export async function setupExtensionSprinkle(
  deps: ExtensionSprinkleSetupDeps
): Promise<SprinkleManager> {
  const { layout, client, localFs, writableFs, useRpcVfs, inlineSprinkles, log } = deps;
  const sprinkleFs = useRpcVfs
    ? createRemoteSprinkleVfs({ reader: writableFs, writer: writableFs })
    : localFs;

  const sprinkleManager = new SprinkleManager(
    sprinkleFs,
    async (event) => handleExtensionSprinkleLick(event, sprinkleManager, deps),
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
      autoOpenBehavior: 'attention',
      onAttachImage: (base64, name, mimeType) =>
        layout.panels.chat.addImageAttachment(base64, name, mimeType),
      inlineSprinkles,
      execHandler: createSprinkleExecHandler(client),
    }
  );

  (window as unknown as Record<string, unknown>).__slicc_sprinkleManager = sprinkleManager;
  // Trusted dips route `slicc.exec()` / `slicc.agent()` through the same
  // worker shell sprinkles use. Untrusted inline-chat dips never expose
  // these methods (see dip.ts), so this only ever serves trusted dips.
  setDipExecHandler(createSprinkleExecHandler(client));
  (window as unknown as Record<string, unknown>).__slicc_reloadSkills = () => {
    chrome.runtime.sendMessage({ source: 'panel', payload: { type: 'reload-skills' } });
    return Promise.resolve();
  };

  // Relay sprinkle ops from the offscreen orchestrator over the panel's
  // existing OffscreenClient transport.
  client.setSprinkleOpHandler((payload: unknown) => {
    const { id, op, name, data } = payload as {
      id: unknown;
      op: string;
      name: string;
      data: unknown;
    };
    void handleSprinkleOp(sprinkleManager, id, op, name, data);
  });

  await sprinkleManager.refresh();
  layout.onSprinkleClose = (name) => sprinkleManager.close(name);
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
  log.info('SprinkleManager initialized (extension mode)');
  return sprinkleManager;
}

async function handleExtensionSprinkleLick(
  event: LickEvent,
  sprinkleManager: SprinkleManager,
  deps: ExtensionSprinkleSetupDeps
): Promise<void> {
  if (event.type !== 'sprinkle') return;
  if (deps.interceptWelcomeLick(event)) {
    // `shortcut-migrate` needs to close the welcome panel — the helper
    // marks it intercepted but doesn't have a sprinkleManager reference.
    if ((event.body as Record<string, unknown> | null)?.action === 'shortcut-migrate') {
      sprinkleManager.close('welcome');
    }
    return;
  }
  // Handle request-mount from welcome sprinkle (sandbox can't call
  // showDirectoryPicker). Route through mount-popup.html — calling
  // showDirectoryPicker directly from the side panel context crashes
  // the renderer when the user picks a TCC-protected folder (Documents,
  // Downloads, Desktop, home).
  if (
    event.sprinkleName === 'welcome' &&
    (event.body as Record<string, unknown> | null)?.action === 'request-mount'
  ) {
    await runWelcomeMountPicker(sprinkleManager, deps.log);
    return;
  }
  deps.client.sendSprinkleLick(event.sprinkleName!, event.body, event.targetScoop);
}

async function runWelcomeMountPicker(
  sprinkleManager: SprinkleManager,
  log: BootStageLogger
): Promise<void> {
  const sendCancelled = () =>
    sprinkleManager.sendToSprinkle('welcome', { action: 'mount-cancelled' });
  try {
    const result = await openMountPickerPopup();
    if (result.cancelled) return sendCancelled();
    if (result.error) {
      log.warn('Mount picker popup failed', result.error);
      return sendCancelled();
    }
    if (!result.handleInIdb || typeof result.idbKey !== 'string') {
      log.warn('Mount picker popup returned unexpected result', result);
      return sendCancelled();
    }
    const handle = await loadAndClearPendingHandle(result.idbKey);
    if (!handle) {
      log.warn('Mount picker popup did not store a handle');
      return sendCancelled();
    }
    await reactivateHandle(handle);
    await storePendingMount(handle);
    sprinkleManager.sendToSprinkle('welcome', {
      action: 'mount-complete',
      dirName: handle.name,
    });
  } catch (err: unknown) {
    log.warn('Mount picker failed', err);
    sendCancelled();
  }
}

async function handleSprinkleOp(
  sprinkleManager: SprinkleManager,
  id: unknown,
  op: string,
  name: string,
  data: unknown
): Promise<void> {
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
}
