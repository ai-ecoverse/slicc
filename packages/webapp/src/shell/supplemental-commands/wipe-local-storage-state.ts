/**
 * `wipe-local-storage-state.ts` — the shared local-state wipe used by
 * both the `nuke` shell command (`nuke-command.ts`) and the pre-boot
 * recovery screen (`ui/main.ts`).
 *
 * Split out so the page-side recovery handler can import the wipe
 * WITHOUT dragging in `nuke-command.ts`'s `defineCommand` import — which
 * pulls the bundled `just-bash` browser entry (~800 kB of shell runtime)
 * into the page bundle. Like `nuke-channel.ts`, everything here is
 * intentionally shell-free: no `just-bash` import, no `Command` type, no
 * shell context.
 *
 * The wipe is the single source of truth for "reset local data": every
 * step is guarded/best-effort so a missing capability (older browser,
 * blocked storage, some test env) never throws or blocks the caller's
 * subsequent reload.
 */

/**
 * Wipe every scrap of local browser state SLICC owns: unregister the
 * service worker, delete every IndexedDB database, and remove every
 * OPFS root entry. Best-effort and never rejects — callers reload
 * afterwards regardless.
 *
 * Order matters: the service worker keeps its own IDB connections open
 * and would block `deleteDatabase`, so it is dropped FIRST. Then every
 * IDB delete is awaited BEFORE the caller reloads — a half-finished
 * delete that completes during the new page's `open()` aborts the
 * upgrade ("Version change transaction was aborted in upgradeneeded
 * event handler"), leaving the user stranded on a "Failed to start"
 * screen.
 *
 * `localStorage` clears are intentionally NOT done here: in worker /
 * offscreen contexts they'd write to a per-context shim or an isolated
 * MV3 storage and be lost. The `nuke` command forwards its key list to
 * the page-side listener instead (see `nuke-channel.ts`); the recovery
 * screen runs in the page and reloads immediately, so the boot flow
 * re-derives from the now-empty OPFS/IDB.
 */
export async function wipeLocalStorageState(): Promise<void> {
  // Drop the service worker first — it keeps its own IDB connections
  // open and will block deleteDatabase otherwise.
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    if (regs) await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
  } catch {
    /* ignore — best effort */
  }

  // Delete every IndexedDB database. Await each delete before returning
  // so the caller's reload boots from a clean slate (see doc comment).
  try {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs
        .filter((db): db is { name: string; version?: number } => !!db.name)
        .map(
          (db) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(db.name);
              // `onblocked` fires when another tab is holding a
              // connection — resolve anyway so we don't hang the
              // reload forever; the worst case is a single DB
              // surviving, which the user can fix with a second reset.
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            })
        )
    );
  } catch {
    /* indexedDB.databases unsupported on some browsers — fall through */
  }

  // Wipe the OPFS-backed VFS tree. Since the ZenFS/OPFS migration the
  // bulk of local state (workspace files, scoops, mounts) lives in
  // OPFS, not IndexedDB, so a reset that only wipes IDB would leave the
  // user's prior workspace on disk. Guard on `navigator.storage
  // .getDirectory` (mirrors `resolveVfsBackendFromEnv`) so contexts
  // without OPFS — older browsers, some test envs — fall through cleanly.
  try {
    const storage = (navigator as unknown as { storage?: StorageManager }).storage;
    if (typeof storage?.getDirectory === 'function') {
      const root = (await storage.getDirectory()) as unknown as {
        keys: () => AsyncIterableIterator<string>;
        removeEntry: (name: string, options?: { recursive: boolean }) => Promise<void>;
      };
      const names: string[] = [];
      for await (const name of root.keys()) names.push(name);
      await Promise.all(
        names.map((name) => root.removeEntry(name, { recursive: true }).catch(() => {}))
      );
    }
  } catch {
    /* OPFS unavailable / blocked — best effort, never block reload */
  }
}
