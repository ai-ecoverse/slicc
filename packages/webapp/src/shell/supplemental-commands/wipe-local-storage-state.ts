export async function wipeLocalStorageState(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    if (regs) await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
  } catch {}

  try {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs
        .filter((db): db is { name: string; version?: number } => !!db.name)
        .map(
          (db) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(db.name);

              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            })
        )
    );
  } catch {}

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
  } catch {}
}
