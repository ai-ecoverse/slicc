/**
 * Per-realm capability tokens for the synchronous bridges (fs + exec).
 *
 * A realm's sync bridge (sync XHR → controlling SW → kernel-worker responder)
 * must resolve reads/writes/commands against the CALLING realm's own handles —
 * the same `ctx.fs` / `ctx.exec` the async `vfs` / `exec` RPCs use, which for a
 * scoop is a `RestrictedFS` wrapped by the sudo-fs `Proxy` and a command-guarded
 * shell. An origin-scoped SW route cannot know which realm issued a request, so
 * each realm is minted an unguessable token (bound to `{ fs, exec, cwd }`) at
 * `attachRealmHost` time and carries it on every sync request; the kernel-worker
 * responder maps the token back to that realm's `ctx` before dispatching. The
 * token is revoked when the realm is disposed so a dead realm's scope can never
 * be reused or forged by another realm.
 *
 * ONE token covers both channels rather than two independently-granted ones:
 * the two capabilities have the same mint site, the same lifetime, and the same
 * revocation, and a realm that can drive `ctx.exec` can already reach the whole
 * filesystem through the shell — so splitting them would add a second secret to
 * protect without narrowing what a leak grants.
 *
 * The registry is a module-level map in the kernel worker (where realm hosts
 * live and where the responder runs). It never crosses the worker boundary —
 * only the opaque token string travels to the SW and back.
 */

import type { CommandContext } from 'just-bash';
import type { SyncFsToken } from './sync-fs-wire.js';

export interface SyncFsTokenEntry {
  /** The realm's gated filesystem handle (RestrictedFS + sudo-fs for scoops). */
  fs: CommandContext['fs'];
  /**
   * The realm's gated shell handle, backing the synchronous `exec` channel.
   * Absent when the runtime provides no shell (`ctx.exec` is optional) — the
   * dispatch then fails closed with `ENOSYS`.
   */
  exec?: CommandContext['exec'];
  /** The realm's working directory — relative sync paths and execs resolve against it. */
  cwd: string;
}

const registry = new Map<string, SyncFsTokenEntry>();

/**
 * In-flight synchronous execs per token. A sync exec runs entirely inside one
 * `dispatchSyncExec` call, so — unlike `exec.start` — it has no `spawnId` the
 * realm host could track. Without this, killing a realm that is blocked in
 * `execSync` (SIGINT / SIGTERM / SIGKILL) reports the realm as exited while the
 * already-started `ctx.exec` keeps running, and producing side effects, for the
 * rest of its budget. {@link revokeSyncFsToken} aborts them on realm dispose.
 */
const inFlightExecs = new Map<string, Set<AbortController>>();

/** Mint an unguessable token bound to a realm's fs + exec handles and cwd. */
export function mintSyncFsToken(entry: SyncFsTokenEntry): SyncFsToken {
  // The one place a raw random string becomes a capability token. The registry
  // map + resolve/revoke stay keyed by plain `string` (the wire delivers the
  // token back as an opaque header value), so no cast is needed on lookup.
  const token = crypto.randomUUID() as SyncFsToken;
  registry.set(token, entry);
  return token;
}

/** Resolve a token to its realm entry, or `null` if unknown / revoked. */
export function resolveSyncFsToken(token: string): SyncFsTokenEntry | null {
  return registry.get(token) ?? null;
}

/**
 * Register an in-flight synchronous exec against its realm's token. Returns the
 * disposer the dispatcher must call once the command settles; a token already
 * revoked (the realm died between resolve and dispatch) aborts immediately so a
 * late command cannot outlive its realm.
 */
export function trackSyncExec(token: string, controller: AbortController): () => void {
  if (!registry.has(token)) {
    controller.abort();
    return () => {};
  }
  let set = inFlightExecs.get(token);
  if (!set) {
    set = new Set();
    inFlightExecs.set(token, set);
  }
  set.add(controller);
  return () => {
    const live = inFlightExecs.get(token);
    if (!live) return;
    live.delete(controller);
    if (live.size === 0) inFlightExecs.delete(token);
  };
}

/**
 * Revoke on realm dispose so a dead realm's token can never be reused, and
 * abort anything it still has running — see {@link inFlightExecs}.
 */
export function revokeSyncFsToken(token: string): void {
  registry.delete(token);
  const live = inFlightExecs.get(token);
  if (!live) return;
  inFlightExecs.delete(token);
  for (const controller of live) {
    if (!controller.signal.aborted) controller.abort();
  }
}
