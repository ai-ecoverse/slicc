/**
 * SLICC sidecar, remote CDP, and permission-request panel-RPC handlers.
 */
import type { HidDevice } from '../../kernel/hid-device-registry.js';
import type {
  PanelRpcHandlers,
  PermissionRpcGrant,
  PermissionRpcKind,
} from '../../kernel/panel-rpc.js';
import type { SerialPort } from '../../kernel/serial-port-registry.js';
import type { UsbDevice } from '../../kernel/usb-device-registry.js';
import type {
  SidecarRegistryLike,
  StandalonePanelRpcHandlerOptions,
} from '../panel-rpc-handlers.js';
import { hidRegistry, serialRegistry, usbRegistry } from './device-handlers.js';

/**
 * `slicc` sidecar client ops — the mirror image of the `tray-exec` pair above.
 * Those drive followers of OUR tray; these drive a connection to SOMEONE ELSE'S
 * leader while this instance keeps leading its own.
 */
export function buildSliccSidecarHandlers(options: StandalonePanelRpcHandlerOptions) {
  // Per-run AbortControllers for in-flight verbs, keyed by the shell's
  // `runToken` so a `slicc-cancel` (Ctrl+C) can interrupt the matching run.
  // Scoped to this builder's closure, not module state, so two handler sets in
  // one test file don't share cancellation.
  const runAborters = new Map<string, AbortController>();

  /** The registry, or a diagnosable error naming why there isn't one. */
  const requireSidecar = (): SidecarRegistryLike => {
    if (!options.sliccSidecar) {
      throw new Error('slicc: sidecar attachments are not available in this environment');
    }
    return options.sliccSidecar;
  };

  /** Run a verb under a cancellable token, always releasing the token after. */
  const withRun = async <T>(
    runToken: string,
    run: (sidecar: SidecarRegistryLike, signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const sidecar = requireSidecar();
    const controller = new AbortController();
    runAborters.set(runToken, controller);
    try {
      return await run(sidecar, controller.signal);
    } finally {
      runAborters.delete(runToken);
    }
  };

  return {
    'slicc-attach': async ({ joinUrl, name, connectTimeoutMs }) =>
      await requireSidecar().attach({ joinUrl, name, connectTimeoutMs }),

    'slicc-detach': ({ name }) => ({ detached: requireSidecar().detach(name) }),

    'slicc-list': () => ({ attachments: requireSidecar().list() }),

    'slicc-prompt': async ({ name, text, runToken, steer, timeoutMs }) =>
      await withRun(
        runToken,
        async (sidecar, signal) => await sidecar.prompt(name, text, { steer, timeoutMs, signal })
      ),

    'slicc-exec': async ({ name, command, runToken, cwd, env, timeoutMs, stdin }) =>
      await withRun(
        runToken,
        async (sidecar, signal) =>
          await sidecar.exec(name, command, { cwd, env, timeoutMs, stdin, signal })
      ),

    'slicc-watch': async ({ name, runToken, durationMs, scoopJid, untilIdle }) =>
      await withRun(
        runToken,
        async (sidecar, signal) =>
          await sidecar.watch(name, { durationMs, scoopJid, untilIdle, signal })
      ),

    'slicc-cancel': ({ runToken }) => {
      runAborters.get(runToken)?.abort();
      return { ok: true };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

/** Federated remote-CDP relay (tray/cherry targets). */
export function buildRemoteCdpHandlers(options: StandalonePanelRpcHandlerOptions) {
  return {
    'list-remote-targets': async () => {
      if (!options.listRemoteTargets) return { targets: [] };
      const all = await options.listRemoteTargets();
      // Only return remote entries (composite targetId = "runtimeId:localId")
      const remote = all.filter((p) => p.targetId.includes(':'));
      return {
        targets: remote.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url })),
      };
    },

    'remote-cdp-send': async ({ runtimeId, localTargetId, method, params, sessionId, timeout }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.send({
        runtimeId,
        localTargetId,
        method,
        params,
        sessionId,
        timeout,
      });
    },

    'remote-cdp-subscribe': async ({ runtimeId, localTargetId, event }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.subscribe({ runtimeId, localTargetId, event });
    },

    'remote-cdp-unsubscribe': async ({ runtimeId, localTargetId, event }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.unsubscribe({ runtimeId, localTargetId, event });
    },

    'remote-cdp-detach': async ({ runtimeId, localTargetId }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.detach({ runtimeId, localTargetId });
    },

    'remote-open-tab': async ({ runtimeId, url }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.openTab({ runtimeId, url });
    },
  } satisfies Partial<PanelRpcHandlers>;
}

/**
 * Camera and microphone are the kinds whose origin grant the browser
 * persists, so an already-`'granted'` state lets `<slicc-permissions>` skip
 * its in-app dialog. Gesture-bound kinds (screenshare / USB / HID / serial /
 * filesystem) never skip. Explicit `payload.skipIfGranted` wins; otherwise
 * camera/mic-only payloads default to skip so ffmpeg / hear-style probes
 * don't re-prompt every invocation.
 */
function skipIfGrantedForPermissionRpc(kinds: PermissionRpcKind[], explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return kinds.length > 0 && kinds.every((kind) => kind === 'camera' || kind === 'microphone');
}

/**
 * `permission-request`: run the leader surface's multi-kind prompt,
 * register usb/hid/serial grants into the shared page-side registries,
 * stash filesystem grants via `storePendingHandle`, and return only
 * serializable references (registry handles / IDB keys / `ok:true`).
 * Rejects with a single error on cancel / unavailable / picker failure.
 */
export function buildPermissionRequestHandler(options: StandalonePanelRpcHandlerOptions) {
  return {
    'permission-request': async (payload) => {
      const surface = options.getPermissionsSurface?.() ?? null;
      if (!surface) {
        throw new Error('permission-request: permission surface unavailable');
      }
      const result = await surface.prompt({
        kinds: payload.kinds,
        description: payload.description,
        heading: payload.heading,
        grantLabel: payload.grantLabel,
        cancelLabel: payload.cancelLabel,
        skipIfGranted: skipIfGrantedForPermissionRpc(payload.kinds, payload.skipIfGranted),
      });
      if (result.status !== 'granted') {
        const detail = result.message ? `: ${result.message}` : '';
        throw new Error(`permission-request: ${result.reason ?? result.status}${detail}`);
      }
      const out: PermissionRpcGrant[] = [];
      for (const grant of result.grants) {
        switch (grant.kind) {
          case 'usb': {
            const handle = usbRegistry().register(grant.device as UsbDevice);
            out.push({ kind: 'usb', handle });
            break;
          }
          case 'hid': {
            // The HID prompt may yield multiple sibling interfaces;
            // register the first (the one the surface returned as the
            // primary `device`) to match the standalone `hid request`
            // shell-path behavior.
            const handle = hidRegistry().register(grant.device as HidDevice);
            out.push({ kind: 'hid', handle });
            break;
          }
          case 'serial': {
            const handle = serialRegistry().register(grant.port as SerialPort);
            out.push({ kind: 'serial', handle });
            break;
          }
          case 'filesystem': {
            const { storePendingHandle } = await import('../../fs/mount-picker-popup.js');
            const idbKey = `pendingMount:rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
            await storePendingHandle(idbKey, grant.handle);
            out.push({ kind: 'filesystem', idbKey, dirName: grant.handle.name });
            break;
          }
          case 'camera':
          case 'microphone':
          case 'screenshare': {
            // The MediaStream can't cross the bridge and the worker only
            // used `permission-request` to GATE a later capture — it opens
            // its own stream downstream. Stop this probe stream's tracks so
            // we don't leave a duplicate camera/mic/screen capture active
            // on the page after returning `ok`.
            for (const track of grant.stream.getTracks()) track.stop();
            out.push({ kind: grant.kind, ok: true });
            break;
          }
        }
      }
      return { grants: out };
    },
  } satisfies Partial<PanelRpcHandlers>;
}
