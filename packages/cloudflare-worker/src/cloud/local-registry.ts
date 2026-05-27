import type { ConeEntry, Registry } from '@slicc/cloud-core';

interface PersistedState {
  // Matches FileRegistry's schema for forensic consistency.
  sessions: ConeEntry[];
}

interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export class LocalRegistry implements Registry {
  constructor(private readonly storage: StorageLike) {}

  private async readAll(): Promise<ConeEntry[]> {
    return (await this.storage.get<PersistedState>('state'))?.sessions ?? [];
  }
  private async writeAll(sessions: ConeEntry[]): Promise<void> {
    await this.storage.put('state', { sessions });
  }

  async list(): Promise<ConeEntry[]> {
    return this.readAll();
  }
  async findByNameOrId(query: string): Promise<ConeEntry | null> {
    const all = await this.readAll();
    return all.find((c) => c.sandboxId === query || c.name === query) ?? null;
  }
  async append(entry: ConeEntry): Promise<void> {
    const all = await this.readAll();
    const i = all.findIndex((c) => c.sandboxId === entry.sandboxId);
    if (i >= 0) all[i] = { ...all[i]!, ...entry };
    else all.push(entry);
    await this.writeAll(all);
  }
  async update(sandboxId: string, patch: Partial<ConeEntry>): Promise<void> {
    const all = await this.readAll();
    const i = all.findIndex((c) => c.sandboxId === sandboxId);
    if (i < 0) throw new Error(`entry not found: ${sandboxId}`);
    all[i] = { ...all[i]!, ...patch };
    await this.writeAll(all);
  }
  async remove(sandboxId: string): Promise<void> {
    const all = await this.readAll();
    await this.writeAll(all.filter((c) => c.sandboxId !== sandboxId));
  }
}
