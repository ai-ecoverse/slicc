/**
 * Per-realm capability tokens for the synchronous-fs bridge.
 *
 * A realm's sync fs bridge (sync XHR → controlling SW → kernel-worker
 * responder) must resolve reads/writes against the CALLING realm's own
 * filesystem handle — the same `ctx.fs` the async `vfs` RPC uses, which for a
 * scoop is a `RestrictedFS` wrapped by the sudo-fs `Proxy`. An origin-scoped
 * SW route cannot know which realm issued a request, so each realm is minted
 * an unguessable token (bound to `{ fs, cwd }`) at `attachRealmHost` time and
 * carries it on every sync-fs request; the kernel-worker responder maps the
 * token back to that realm's `ctx` before dispatching. The token is revoked
 * when the realm is disposed so a dead realm's scope can never be reused or
 * forged by another realm.
 *
 * The registry is a module-level map in the kernel worker (where realm hosts
 * live and where the responder runs). It never crosses the worker boundary —
 * only the opaque token string travels to the SW and back.
 */

import type { CommandContext } from 'just-bash';

export interface SyncFsTokenEntry {
  /** The realm's gated filesystem handle (RestrictedFS + sudo-fs for scoops). */
  fs: CommandContext['fs'];
  /** The realm's working directory — relative sync-fs paths resolve against it. */
  cwd: string;
}

const registry = new Map<string, SyncFsTokenEntry>();

/** Mint an unguessable token bound to a realm's fs handle + cwd. */
export function mintSyncFsToken(entry: SyncFsTokenEntry): string {
  const token = crypto.randomUUID();
  registry.set(token, entry);
  return token;
}

/** Resolve a token to its realm entry, or `null` if unknown / revoked. */
export function resolveSyncFsToken(token: string): SyncFsTokenEntry | null {
  return registry.get(token) ?? null;
}

/** Revoke on realm dispose so a dead realm's token can never be reused. */
export function revokeSyncFsToken(token: string): void {
  registry.delete(token);
}
