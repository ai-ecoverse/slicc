/**
 * `setup-standalone-panel-rpc.ts` — installs the page-side panel-RPC
 * handler so DOM-bound shell commands run by the kernel worker
 * (`screencapture` / `say` / `afplay` / clipboard / `open`, plus the
 * playwright app-origin lookup, plus the leader-tray `host reset` /
 * `host leave` / `cherry-emit` bridges) can reach the page realm.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:699–758).
 * `imgcat` is intentionally terminal-only and stays out of the
 * bridge — it's meant for the in-panel terminal, not the agent.
 */

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

/** JWT claim bag we read for account identity hashing. */
interface JwtIdentityClaims {
  email?: string;
  user_id?: string;
  sub?: string;
}

/** Extract a stable identity string from an account for hashing.
 * Prefers userName (set by OAuth flows), falls back to email/user_id from JWT access token. */
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
    } catch {
      /* not a JWT or missing claim */
    }
  }
  return null;
}

/** SHA-256(providerId:identity) truncated to 8 hex chars. Returns '00000000' for anonymous. */
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
  /** Lazy accessor — reads the live binding so post-install assignments are visible. */
  getLeader(): PageLeaderTrayHandle | null;
  performTrayLeaveLocally(opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult>;
  window: Window;
}

type ActiveLeaderSync = NonNullable<PageLeaderTrayHandle['currentLeaderSync']>;

/**
 * The leader's live session plus its controller token, or a thrown error named
 * for the command that asked.
 *
 * The controller token is the last path segment of the controller URL — the
 * page-side leader is the only holder, which is why every worker-side command
 * that talks to the tray HTTP API has to bridge through here.
 */
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

/**
 * The three biscotto panel-RPC handlers.
 *
 * A separate factory rather than three more entries inline: the handler map is
 * already at the per-function line cap, and these share one credential lookup.
 */
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
        // Spread rather than restated: every field the op declares reaches
        // the worker, including ones added later.
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

/**
 * The `ssh` bridge — commands run DOWN this instance's tray, on a follower that
 * lent us its machine. The outbound counterpart is {@link createSidecarBridge}.
 *
 * The WebRTC data channels live on the page, so the kernel-worker `ssh` command
 * reaches `LeaderSyncManager.execOnRemote` through here.
 */
function createRemoteExecBridge(getLeader: StandalonePanelRpcDeps['getLeader']) {
  // Per-run AbortControllers for in-flight execs, keyed by the shell's
  // `execToken` so a `tray-exec-signal` (Ctrl+C) can cancel the matching run.
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
      // The AbortController carries no signal name; `execOnRemote` maps any
      // abort to SIGINT on the follower, which is the Ctrl+C path.
      aborters.get(execToken)?.abort();
    },
  };
}

/**
 * The `slicc` sidecar bridge — outbound attachments to OTHER SLICC leaders,
 * held while this instance keeps leading its own tray.
 *
 * The registry is built lazily so a page that never runs `slicc` never pulls
 * `tray-sidecar.js` into its graph. Unlike the leader/follower handles in
 * `wc-tray.ts`, sidecars are page-lifetime only — nothing persists them, so a
 * reload deliberately starts with none.
 */
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
    // The sync ops can only report on a registry that already exists —
    // `detach` / `list` before any `attach` are correctly "nothing here", and
    // awaiting the import would change their signatures for no gain.
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
        // Persist (so a panel reload re-joins) then hand off to the
        // `slicc:tray-join` listener in `wc-tray.ts`, which stops any
        // current role and starts the follower. `storeTrayJoinUrl`
        // re-parses + writes both the join and worker storage keys.
        storeTrayJoinUrl(win.localStorage, joinUrl);
        win.dispatchEvent(new CustomEvent('slicc:tray-join', { detail: { joinUrl } }));
        return { joinUrl };
      },
      emitEvent: (channel, payload) => panelRpcEventEmitter.emit(channel, payload),
      emitCherrySliccEvent: (runtimeId, name, detail) =>
        getLeader()?.sync.emitCherrySliccEvent(runtimeId, name, detail) ?? false,
      execOnRemote: remoteExec.execOnRemote,
      signalRemoteExec: remoteExec.signalRemoteExec,
      sliccSidecar: createSidecarBridge(),
      ...biscottoHandlers(),
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
        // Get title from entryPath basename, or 'Preview' if empty
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
      // Worker-side `serve --list` bridges here so the kernel-worker
      // can list active previews via the page-side leader's
      // controllerToken and the worker HTTP API.
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
      // Lazy lookup — the leader surface may mount after the panel-RPC
      // handler is installed (the `<slicc-permissions>` install runs from
      // the WC shell's attach pass), so the resolver must read the live
      // registry binding rather than capture it at install time.
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
