import type { CommandContext } from 'just-bash';
import type { SyncFsToken } from './sync-fs-wire.js';

export interface SyncFsTokenEntry {
  fs: CommandContext['fs'];

  exec?: CommandContext['exec'];

  cwd: string;
}

const registry = new Map<string, SyncFsTokenEntry>();

const inFlightExecs = new Map<string, Set<AbortController>>();

export function mintSyncFsToken(entry: SyncFsTokenEntry): SyncFsToken {
  const token = crypto.randomUUID() as SyncFsToken;
  registry.set(token, entry);
  return token;
}

export function resolveSyncFsToken(token: string): SyncFsTokenEntry | null {
  return registry.get(token) ?? null;
}

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

export function revokeSyncFsToken(token: string): void {
  registry.delete(token);
  const live = inFlightExecs.get(token);
  if (!live) return;
  inFlightExecs.delete(token);
  for (const controller of live) {
    if (!controller.signal.aborted) controller.abort();
  }
}
