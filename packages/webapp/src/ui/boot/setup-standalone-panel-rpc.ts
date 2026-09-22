import type { BrowserAPI } from '../../cdp/index.js';
import { getAccounts } from '../../providers/account-store.js';
import type { LeaderTraySession } from '../../scoops/tray-leader.js';
import type { TrayLeaveResult } from '../../scoops/tray-leave.js';
import { storeTrayJoinUrl } from '../../scoops/tray-runtime-config.js';
import type { SidecarRegistry } from '../../scoops/tray-sidecar.js';
import type { PageLeaderTrayHandle } from '../page-leader-tray.js';
import type {
  SidecarRegistryLike,
  StandalonePanelRpcHandlerOptions,
} from '../panel-rpc-handlers.js';

import type { RemoteCdpPageBridge } from '../remote-cdp-page-bridge.js';

interface JwtIdentityClaims {
  email?: string;
  user_id?: string;
  sub?: string;
}

function accountIdentity(account: {
  providerId: string;
  userName?: string;
  accessToken?: string;
}): string | null {
  if (account.userName) return `${account.providerId}:${account.userName}`;
  if (account.accessToken) {
    try {
      const payload = JSON.parse(
        atob(account.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
      ) as JwtIdentityClaims;
      const id = payload.email ?? payload.user_id ?? payload.sub;
      if (id) return `${account.providerId}:${id}`;
    } catch {}
  }
  return null;
}

async function computeUserHash(): Promise<string> {
  try {
    const accounts = getAccounts();
    const candidates = accounts.filter((a) => !a.loggedOut);
    const account =
      ['adobe', 'github'].map((id) => candidates.find((a) => a.providerId === id)).find(Boolean) ??
      candidates[0];
    const identity = account ? accountIdentity(account) : null;
    if (!identity) return '00000000';
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
    return Array.from(new Uint8Array(bytes, 0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '00000000';
  }
}

export interface StandalonePanelRpcDeps {
  instanceId: string;
  browser: BrowserAPI;
  remoteCdpBridge: RemoteCdpPageBridge;
  remoteCdpPushChannel: BroadcastChannel | null;

  getLeader(): PageLeaderTrayHandle | null;
  performTrayLeaveLocally(opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult>;
  window: Window;
}

type ActiveLeaderSync = NonNullable<PageLeaderTrayHandle['currentLeaderSync']>;

async function requireLeaderSession(
  commandName: string
): Promise<{ session: LeaderTraySession; controllerToken: string }> {
  const { getLeaderTrayRuntimeStatus } = await import('../../scoops/tray-leader.js');
  const session = getLeaderTrayRuntimeStatus().session;
  if (!session) throw new Error(`${commandName}: leader tray has no active session`);
  const controllerToken = new URL(session.controllerUrl).pathname.split('/').pop() ?? '';
  if (!controllerToken) {
    throw new Error(`${commandName}: leader tray session carries no controller token`);
  }
  return { session, controllerToken };
}

function biscottoHandlers(): Pick<
  StandalonePanelRpcHandlerOptions,
  'mintBiscotto' | 'revokeBiscotto' | 'listBiscotti'
> {
  return {
    mintBiscotto: async (payload) => {
      const { session, controllerToken } = await requireLeaderSession('biscotto');
      const { mintBiscottoViaWorker } = await import(
        '../../shell/supplemental-commands/biscotto-mint-client.js'
      );
      return mintBiscottoViaWorker({
        workerBaseUrl: session.workerBaseUrl,
        trayId: session.trayId,
        controllerToken,

        ...payload,
      });
    },
    revokeBiscotto: async ({ id }) => {
      const { session, controllerToken } = await requireLeaderSession('biscotto revoke');
      const { revokeBiscottoViaWorker } = await import(
        '../../shell/supplemental-commands/biscotto-mint-client.js'
      );
      return revokeBiscottoViaWorker({
        workerBaseUrl: session.workerBaseUrl,
        trayId: session.trayId,
        controllerToken,
        id,
      });
    },
    listBiscotti: async () => {
      const { session, controllerToken } = await requireLeaderSession('biscotti');
      const { listBiscottiViaWorker } = await import(
        '../../shell/supplemental-commands/biscotto-mint-client.js'
      );
      return listBiscottiViaWorker({
        workerBaseUrl: session.workerBaseUrl,
        trayId: session.trayId,
        controllerToken,
      });
    },
  };
}

function requirePreviewSync(
  getLeader: StandalonePanelRpcDeps['getLeader'],
  flag: '--logs' | '--truncate'
): ActiveLeaderSync {
  const sync = getLeader()?.currentLeaderSync;
  if (!sync) throw new Error(`serve ${flag}: no active leader tray`);
  return sync;
}

function getPreviewRecords(sync: ActiveLeaderSync, previewToken?: string) {
  return { lifecycleRecords: [...sync.getPreviewLifecycleRecords(previewToken)] };
}

function truncatePreviewRecords(sync: ActiveLeaderSync, previewToken?: string) {
  return {
    cleared: sync.clearPreviewLifecycleRecords(previewToken),
    rearmed: sync.rearmPreviewAnnouncements(previewToken),
  };
}

function createComputerNativeBridge(getLeader: StandalonePanelRpcDeps['getLeader']) {
  return async (
    payload: Parameters<NonNullable<StandalonePanelRpcHandlerOptions['computerNative']>>[0]
  ) => {
    const sync = getLeader()?.currentLeaderSync;
    if (!sync) throw new Error('computer native: no active leader tray');
    if (payload.action === 'capture') {
      const frame = await sync.captureNativeComputer(payload.runtimeId, {
        fps: payload.fps,
        maxWidth: payload.maxWidth,
        display: payload.display,
        watch: payload.watch,
      });
      return { ok: true as const, ...frame };
    }
    if (payload.action === 'input') {
      await sync.inputNativeComputer(payload.runtimeId, payload.events ?? [], {
        display: payload.display,
      });
      return { ok: true as const };
    }
    sync.unwatchNativeComputer(payload.runtimeId);
    return { ok: true as const };
  };
}

function createRemoteExecBridge(getLeader: StandalonePanelRpcDeps['getLeader']) {
  const aborters = new Map<string, AbortController>();
  return {
    execOnRemote: async (payload: {
      runtimeId: string;
      command: string;
      cwd?: string;
      env?: Record<string, string>;
      execToken: string;
      timeoutMs?: number;
      stdin?: string;
    }) => {
      const sync = getLeader()?.currentLeaderSync;
      if (!sync) throw new Error('ssh: no active leader tray');
      const controller = new AbortController();
      aborters.set(payload.execToken, controller);
      try {
        return await sync.execOnRemote(payload.runtimeId, payload.command, {
          cwd: payload.cwd,
          env: payload.env,
          stdin: payload.stdin,
          signal: controller.signal,
          timeoutMs: payload.timeoutMs,
        });
      } finally {
        aborters.delete(payload.execToken);
      }
    },
    signalRemoteExec: ({ execToken }: { execToken: string }) => {
      aborters.get(execToken)?.abort();
    },
  };
}

function createSidecarBridge(): SidecarRegistryLike {
  let registry: SidecarRegistry | null = null;
  const ensure = async (): Promise<SidecarRegistry> => {
    if (!registry) {
      const { SidecarRegistry: Registry } = await import('../../scoops/tray-sidecar.js');
      registry = new Registry();
    }
    return registry;
  };
  return {
    attach: async (opts) => await (await ensure()).attach(opts),

    detach: (name) => registry?.detach(name) ?? false,
    list: () => registry?.list() ?? [],
    prompt: async (name, text, options) => await (await ensure()).prompt(name, text, options),
    exec: async (name, command, options) => await (await ensure()).exec(name, command, options),
    watch: async (name, options) => await (await ensure()).watch(name, options),
  };
}

export async function setupStandalonePanelRpc(deps: StandalonePanelRpcDeps): Promise<void> {
  const {
    instanceId,
    browser,
    remoteCdpBridge,
    remoteCdpPushChannel,
    getLeader,
    performTrayLeaveLocally,
    window: win,
  } = deps;

  const { installPanelRpcHandler, createPanelRpcEventEmitter } = await import(
    '../../kernel/panel-rpc.js'
  );
  const { createStandalonePanelRpcHandlers } = await import('../panel-rpc-handlers.js');
  const { getLeaderPermissionsSurface } = await import('../wc/wc-permissions-registry.js');
  const panelRpcEventEmitter = createPanelRpcEventEmitter({ instanceId });

  const remoteExec = createRemoteExecBridge(getLeader);
  const stopPanelRpcHandler = installPanelRpcHandler({
    instanceId,
    handlers: createStandalonePanelRpcHandlers({
      resetTray: async () => {
        const leader = getLeader();
        if (!leader) {
          throw new Error('no active tray session to reset');
        }
        return await leader.reset();
      },
      leaveTray: async ({ workerBaseUrl, requestId }) =>
        await performTrayLeaveLocally({ workerBaseUrl, requestId }),
      joinTray: ({ joinUrl }) => {
        storeTrayJoinUrl(win.localStorage, joinUrl);
        win.dispatchEvent(new CustomEvent('slicc:tray-join', { detail: { joinUrl } }));
        return { joinUrl };
      },
      emitEvent: (channel, payload) => panelRpcEventEmitter.emit(channel, payload),
      emitCherrySliccEvent: (runtimeId, name, detail) =>
        getLeader()?.sync.emitCherrySliccEvent(runtimeId, name, detail) ?? false,
      execOnRemote: remoteExec.execOnRemote,
      signalRemoteExec: remoteExec.signalRemoteExec,
      computerNative: createComputerNativeBridge(getLeader),
      sliccSidecar: createSidecarBridge(),
      ...biscottoHandlers(),
      rotateWebhook: async () => {
        const leader = getLeader()?.leader;
        if (!leader) throw new Error('webhook rotate: no active leader tray');
        return leader.rotateWebhook();
      },
      revokeWebhook: async (webhookId) => {
        const leader = getLeader()?.leader;
        if (!leader) {
          const { assertNoStableWebhookHome } = await import('../../scoops/tray-leader.js');
          await assertNoStableWebhookHome(win.localStorage);
          return;
        }
        await leader.revokeWebhook(webhookId);
      },
      mintPreview: async (opts) => {
        const sync = getLeader()?.currentLeaderSync;
        if (!sync) throw new Error('serve: no active leader tray; cannot mint preview');
        const { getLeaderTrayRuntimeStatus } = await import('../../scoops/tray-leader.js');
        const session = getLeaderTrayRuntimeStatus().session;
        if (!session) throw new Error('serve: leader tray has no active session');
        const controllerToken = new URL(session.controllerUrl).pathname.split('/').pop() ?? '';
        const { CHERRY_RUNTIME_TAG } = await import('../../scoops/tray-sync-protocol.js');
        const { mintPreviewViaWorker } = await import(
          '../../shell/supplemental-commands/preview-mint-client.js'
        );
        const hasCherryFollower = sync
          .getConnectedFollowers()
          .some((f) => f.runtime === CHERRY_RUNTIME_TAG);
        const effectiveAllowLive = !opts.noBridge && (opts.bridge || hasCherryFollower);
        const effectiveBridge = !opts.noBridge && opts.bridge;
        const userHash = await computeUserHash();
        const { url, previewToken } = await mintPreviewViaWorker({
          workerBaseUrl: session.workerBaseUrl,
          trayId: session.trayId,
          controllerToken,
          servedRoot: opts.servedRoot,
          entryPath: opts.entryPath,
          allowLive: effectiveAllowLive,
          bridge: effectiveBridge,
          maxTabs: opts.maxTabs,
          webhookId: opts.webhookId,
          userHash,
          quiet: opts.quiet ?? false,
          ttlMs: opts.ttlMs,
          snapshotFiles: opts.snapshotFiles,
        });

        const title = opts.entryPath ? (opts.entryPath.split('/').pop() ?? 'Preview') : 'Preview';
        sync.registerMintedPreview(previewToken, { url, title, quiet: opts.quiet ?? false });
        sync.broadcastPreviewOpen(url);
        return { url, pushed: sync.getConnectedFollowers().length, previewToken };
      },
      revokePreview: async ({ previewToken }) => {
        const sync = getLeader()?.currentLeaderSync;
        if (!sync) throw new Error('serve --stop: no active leader tray; cannot revoke preview');
        const { getLeaderTrayRuntimeStatus } = await import('../../scoops/tray-leader.js');
        const session = getLeaderTrayRuntimeStatus().session;
        if (!session) throw new Error('serve --stop: leader tray has no active session');
        const controllerToken = new URL(session.controllerUrl).pathname.split('/').pop() ?? '';
        const { revokePreviewViaWorker } = await import(
          '../../shell/supplemental-commands/preview-mint-client.js'
        );
        const result = await revokePreviewViaWorker({
          workerBaseUrl: session.workerBaseUrl,
          trayId: session.trayId,
          controllerToken,
          previewToken,
        });
        sync.dropMintedPreview(previewToken);
        return result;
      },

      listPreviews: async () => {
        const { getLeaderTrayRuntimeStatus } = await import('../../scoops/tray-leader.js');
        const session = getLeaderTrayRuntimeStatus().session;
        if (!session) throw new Error('serve: leader tray has no active session');
        const controllerToken = new URL(session.controllerUrl).pathname.split('/').pop() ?? '';
        const { listPreviewsViaWorker } = await import(
          '../../shell/supplemental-commands/preview-mint-client.js'
        );
        return await listPreviewsViaWorker({
          workerBaseUrl: session.workerBaseUrl,
          trayId: session.trayId,
          controllerToken,
        });
      },
      getPreviewLifecycleRecords: (previewToken) =>
        getPreviewRecords(requirePreviewSync(getLeader, '--logs'), previewToken),
      truncatePreviewLifecycleRecords: (previewToken) =>
        truncatePreviewRecords(requirePreviewSync(getLeader, '--truncate'), previewToken),
      listRemoteTargets: () => browser.listAllTargets(),
      remoteCdp: remoteCdpBridge,

      getPermissionsSurface: () => getLeaderPermissionsSurface(),
      shouldDelegateOAuth: () => getLeader()?.sync.shouldDelegateOAuthLogin() === true,
      delegateOAuthLogin: async (url) => {
        const sync = getLeader()?.sync;
        if (!sync?.shouldDelegateOAuthLogin()) return { delegated: false as const };
        const result = await sync.delegateOAuthLogin(url);
        return { delegated: true as const, ...result };
      },
    }),
  });
  win.addEventListener(
    'beforeunload',
    () => {
      stopPanelRpcHandler();
      panelRpcEventEmitter.dispose();
      remoteCdpBridge.disposeAll();
      remoteCdpPushChannel?.close();
    },
    { once: true }
  );
}
