import type { ConeEntry, Registry } from '@slicc/cloud-core';

interface PersistedState {
  // Matches FileRegistry's schema for forensic consistency.
  sessions: ConeEntry[];
}

interface StorageTransactionLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface StorageLike extends StorageTransactionLike {
  transaction<T>(closure: (txn: StorageTransactionLike) => Promise<T>): Promise<T>;
}

export class LocalRegistry implements Registry {
  constructor(private readonly storage: StorageLike) {}

  private async readAll(storage: StorageTransactionLike = this.storage): Promise<ConeEntry[]> {
    return (await storage.get<PersistedState>('state'))?.sessions ?? [];
  }

  private async mutate(mutator: (sessions: ConeEntry[]) => ConeEntry[]): Promise<void> {
    await this.storage.transaction(async (txn) => {
      const sessions = await this.readAll(txn);
      await txn.put('state', { sessions: mutator(sessions) });
    });
  }

  async list(): Promise<ConeEntry[]> {
    return this.readAll();
  }
  async findByNameOrId(query: string): Promise<ConeEntry | null> {
    const all = await this.readAll();
    return all.find((c) => c.sandboxId === query || c.name === query) ?? null;
  }
  async append(entry: ConeEntry): Promise<void> {
    await this.mutate((all) => {
      const i = all.findIndex((c) => c.sandboxId === entry.sandboxId);
      if (i >= 0) all[i] = { ...all[i]!, ...entry };
      else all.push(entry);
      return all;
    });
  }
  async update(sandboxId: string, patch: Partial<ConeEntry>): Promise<void> {
    await this.mutate((all) => {
      const i = all.findIndex((c) => c.sandboxId === sandboxId);
      if (i < 0) throw new Error(`entry not found: ${sandboxId}`);
      all[i] = { ...all[i]!, ...patch };
      return all;
    });
  }
  async remove(sandboxId: string): Promise<void> {
    await this.mutate((all) => all.filter((c) => c.sandboxId !== sandboxId));
  }
}
