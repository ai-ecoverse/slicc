import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConeEntry, Registry } from '@slicc/cloud-core';

interface RegistryFile {
  sessions: ConeEntry[];
}

function isConeEntry(x: unknown): x is ConeEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.substrate === 'string' &&
    typeof e.sandboxId === 'string' &&
    typeof e.createdAt === 'string' &&
    typeof e.joinUrl === 'string' &&
    typeof e.lastSeen === 'string' &&
    typeof e.state === 'string' &&
    (e.state === 'running' || e.state === 'paused' || e.state === 'dead' || e.state === 'reserved')
  );
}

export class FileRegistry implements Registry {
  constructor(private readonly filePath: string) {}

  static defaultPath(): string {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
    return path.join(home, '.slicc', 'cloud-sessions.json');
  }

  async list(): Promise<ConeEntry[]> {
    const data = await this.read();
    return data.sessions;
  }

  async append(entry: ConeEntry): Promise<void> {
    const data = await this.read();
    // UPSERT semantics: filter out existing sandboxId, then push the new entry
    data.sessions = data.sessions.filter((s) => s.sandboxId !== entry.sandboxId);
    data.sessions.push(entry);
    await this.write(data);
  }

  async update(sandboxId: string, patch: Partial<ConeEntry>): Promise<void> {
    const data = await this.read();
    const idx = data.sessions.findIndex((s) => s.sandboxId === sandboxId);
    if (idx === -1) {
      throw new Error(`entry not found: ${sandboxId}`);
    }
    data.sessions[idx] = { ...data.sessions[idx], ...patch, sandboxId };
    await this.write(data);
  }

  async remove(sandboxId: string): Promise<void> {
    const data = await this.read();
    data.sessions = data.sessions.filter((s) => s.sandboxId !== sandboxId);
    await this.write(data);
  }

  async findByNameOrId(query: string): Promise<ConeEntry | null> {
    const data = await this.read();
    return (
      data.sessions.find((s) => s.sandboxId === query) ??
      data.sessions.find((s) => s.name === query) ??
      null
    );
  }

  private async read(): Promise<RegistryFile> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.filePath, 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [] };
      throw err;
    }
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !Array.isArray((raw as { sessions?: unknown }).sessions)
    ) {
      console.warn('cloud-sessions.json is malformed; treating as empty', this.filePath);
      return { sessions: [] };
    }
    const candidates = (raw as { sessions: unknown[] }).sessions;
    const sessions: ConeEntry[] = [];
    for (const c of candidates) {
      if (isConeEntry(c)) sessions.push(c);
      else console.warn('skipping malformed cloud-sessions entry', c);
    }
    return { sessions };
  }

  private async write(data: RegistryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }
}
