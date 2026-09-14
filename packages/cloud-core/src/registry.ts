import type { ConeEntry } from './types.js';

export interface Registry {
  list(): Promise<ConeEntry[]>;

  findByNameOrId(query: string): Promise<ConeEntry | null>;

  append(entry: ConeEntry): Promise<void>;

  update(sandboxId: string, patch: Partial<ConeEntry>): Promise<void>;

  remove(sandboxId: string): Promise<void>;
}
