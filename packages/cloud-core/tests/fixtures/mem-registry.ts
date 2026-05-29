import type { ConeEntry, Registry } from '../../src/index.js';

export class MemRegistry implements Registry {
  entries: ConeEntry[] = [];

  async list(): Promise<ConeEntry[]> {
    return [...this.entries];
  }

  async findByNameOrId(query: string): Promise<ConeEntry | null> {
    return this.entries.find((e) => e.sandboxId === query || e.name === query) ?? null;
  }

  async append(entry: ConeEntry): Promise<void> {
    const i = this.entries.findIndex((e) => e.sandboxId === entry.sandboxId);
    if (i >= 0) this.entries[i] = { ...this.entries[i]!, ...entry };
    else this.entries.push(entry);
  }

  async update(sandboxId: string, patch: Partial<ConeEntry>): Promise<void> {
    const i = this.entries.findIndex((e) => e.sandboxId === sandboxId);
    if (i < 0) throw new Error(`entry not found: ${sandboxId}`);
    this.entries[i] = { ...this.entries[i]!, ...patch };
  }

  async remove(sandboxId: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.sandboxId !== sandboxId);
  }
}
