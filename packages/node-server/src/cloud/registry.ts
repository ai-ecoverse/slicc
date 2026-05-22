import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SubstrateId } from './substrate.js';

export interface CloudSessionEntry {
  substrate: SubstrateId;
  sandboxId: string;
  name?: string;
  createdAt: string;
  joinUrl: string;
  /** `Date.now()`-style timestamp of the last `--cloud` interaction with this entry. */
  lastSeen: string;
  state: 'running' | 'paused' | 'dead';
  /**
   * Last-known tray identity from `/tmp/slicc-join.json`. Set by `runStart`
   * after the initial cloud-status read; preserved by `runPause` (do NOT
   * overwrite this on pause — it is the comparison baseline that lets
   * `runResume` detect tray rebuilds). `runResume` overwrites it after a
   * successful refresh.
   */
  trayId?: string;
  /**
   * `updatedAt` from the last successful `/tmp/slicc-join.json` read.
   * `runResume` polls for an `updatedAt` strictly newer than this value, so
   * resume only declares success after the kick produced a fresh refresh.
   * Preserved across `runPause` for the same reason as `trayId`.
   */
  lastJoinUpdatedAt?: string;
}

interface RegistryFile {
  sessions: CloudSessionEntry[];
}

export class CloudSessionRegistry {
  constructor(private readonly filePath: string) {}

  static defaultPath(): string {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
    return path.join(home, '.slicc', 'cloud-sessions.json');
  }

  async list(): Promise<CloudSessionEntry[]> {
    const data = await this.read();
    return data.sessions;
  }

  async append(entry: CloudSessionEntry): Promise<void> {
    const data = await this.read();
    data.sessions = data.sessions.filter((s) => s.sandboxId !== entry.sandboxId);
    data.sessions.push(entry);
    await this.write(data);
  }

  async update(sandboxId: string, patch: Partial<CloudSessionEntry>): Promise<void> {
    const data = await this.read();
    const idx = data.sessions.findIndex((s) => s.sandboxId === sandboxId);
    if (idx === -1) return;
    data.sessions[idx] = { ...data.sessions[idx], ...patch, sandboxId };
    await this.write(data);
  }

  async remove(sandboxId: string): Promise<void> {
    const data = await this.read();
    data.sessions = data.sessions.filter((s) => s.sandboxId !== sandboxId);
    await this.write(data);
  }

  async findByNameOrId(query: string): Promise<CloudSessionEntry | null> {
    const data = await this.read();
    return (
      data.sessions.find((s) => s.sandboxId === query) ??
      data.sessions.find((s) => s.name === query) ??
      null
    );
  }

  private async read(): Promise<RegistryFile> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as RegistryFile;
      if (!parsed.sessions || !Array.isArray(parsed.sessions)) return { sessions: [] };
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [] };
      throw err;
    }
  }

  private async write(data: RegistryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }
}
