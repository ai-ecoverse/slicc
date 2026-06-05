/**
 * Page-side remote-CDP bridge. Owns, per composite target
 * (`runtimeId:localTargetId`), the real `RemoteCDPTransport` (obtained
 * from the page-side `LeaderSyncManager`) plus ref-counted event
 * forwarders. Worker-side `PanelRpcCdpTransport`s tunnel their CDP I/O
 * here over panel-RPC; CDP events flow back as `remote-cdp-event`
 * pushes.
 *
 * Created in `main.ts` (standalone) and exercised through the
 * `remote-cdp-*` / `remote-open-tab` panel-RPC handlers. See issue #848
 * and `docs/superpowers/specs/2026-06-03-standalone-remote-cdp-bridge-design.md`.
 */

import type { CDPTransport } from '../cdp/transport.js';
import type { CDPEventListener } from '../cdp/types.js';

export type { RemoteCdpEventPayload } from '../kernel/panel-rpc.js';

import type { RemoteCdpEventPayload } from '../kernel/panel-rpc.js';

/**
 * The slice of the page-side `LeaderSyncManager` (a `TrayTargetProvider`)
 * this bridge needs. `LeaderSyncManager` satisfies it structurally.
 */
export interface RemoteCdpSyncProvider {
  createRemoteTransport(runtimeId: string, localTargetId: string): CDPTransport;
  removeRemoteTransport?(runtimeId: string, localTargetId: string): void;
  openRemoteTab?(runtimeId: string, url: string): Promise<string>;
}

export interface RemoteCdpPageBridge {
  send(p: {
    runtimeId: string;
    localTargetId: string;
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
    timeout?: number;
  }): Promise<Record<string, unknown>>;
  subscribe(p: { runtimeId: string; localTargetId: string; event: string }): Promise<{
    ok: true;
  }>;
  unsubscribe(p: { runtimeId: string; localTargetId: string; event: string }): Promise<{
    ok: true;
  }>;
  detach(p: { runtimeId: string; localTargetId: string }): Promise<{ ok: true }>;
  openTab(p: { runtimeId: string; url: string }): Promise<{ targetId: string }>;
  /** Drop sessions for a runtime that disconnected out of band. */
  cleanupRuntime(runtimeId: string): void;
  /** Dispose every session (page/session reload, tray-leave, leader stop). */
  disposeAll(): void;
}

interface Session {
  runtimeId: string;
  localTargetId: string;
  transport: CDPTransport;
  /** event → { forwarder, refcount } */
  forwarders: Map<string, { listener: CDPEventListener; count: number }>;
}

export function createRemoteCdpPageBridge(opts: {
  getSync: () => RemoteCdpSyncProvider | null;
  postEvent: (payload: RemoteCdpEventPayload) => void;
}): RemoteCdpPageBridge {
  const sessions = new Map<string, Session>();
  const keyOf = (runtimeId: string, localTargetId: string): string =>
    `${runtimeId}:${localTargetId}`;

  const getOrCreate = (runtimeId: string, localTargetId: string): Session => {
    const key = keyOf(runtimeId, localTargetId);
    let session = sessions.get(key);
    if (!session) {
      const sync = opts.getSync();
      if (!sync) throw new Error('remote-cdp: leader tray not started');
      session = {
        runtimeId,
        localTargetId,
        transport: sync.createRemoteTransport(runtimeId, localTargetId),
        forwarders: new Map(),
      };
      sessions.set(key, session);
    }
    return session;
  };

  const disposeSession = (key: string): void => {
    const session = sessions.get(key);
    if (!session) return;
    for (const [event, fwd] of session.forwarders) {
      session.transport.off(event, fwd.listener);
    }
    session.forwarders.clear();
    const sync = opts.getSync();
    if (sync?.removeRemoteTransport) {
      sync.removeRemoteTransport(session.runtimeId, session.localTargetId);
    } else {
      session.transport.disconnect();
    }
    sessions.delete(key);
  };

  return {
    async send({ runtimeId, localTargetId, method, params, sessionId, timeout }) {
      const session = getOrCreate(runtimeId, localTargetId);
      return session.transport.send(method, params, sessionId, timeout);
    },

    async subscribe({ runtimeId, localTargetId, event }) {
      const session = getOrCreate(runtimeId, localTargetId);
      const existing = session.forwarders.get(event);
      if (existing) {
        existing.count += 1;
        return { ok: true };
      }
      const listener: CDPEventListener = (params) =>
        opts.postEvent({ runtimeId, localTargetId, method: event, params });
      session.transport.on(event, listener);
      session.forwarders.set(event, { listener, count: 1 });
      return { ok: true };
    },

    async unsubscribe({ runtimeId, localTargetId, event }) {
      const session = sessions.get(keyOf(runtimeId, localTargetId));
      const fwd = session?.forwarders.get(event);
      if (!session || !fwd) return { ok: true };
      fwd.count -= 1;
      if (fwd.count <= 0) {
        session.transport.off(event, fwd.listener);
        session.forwarders.delete(event);
      }
      return { ok: true };
    },

    async detach({ runtimeId, localTargetId }) {
      disposeSession(keyOf(runtimeId, localTargetId));
      return { ok: true };
    },

    async openTab({ runtimeId, url }) {
      const sync = opts.getSync();
      if (!sync?.openRemoteTab) {
        throw new Error('remote-cdp: openRemoteTab not available');
      }
      return { targetId: await sync.openRemoteTab(runtimeId, url) };
    },

    cleanupRuntime(runtimeId) {
      const prefix = `${runtimeId}:`;
      for (const key of [...sessions.keys()]) {
        if (key.startsWith(prefix)) disposeSession(key);
      }
    },

    disposeAll() {
      for (const key of [...sessions.keys()]) disposeSession(key);
    },
  };
}
