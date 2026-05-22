import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SubstrateId } from './substrate.js';

export interface CloudSessionEntry {
  substrate: SubstrateId;
  sandboxId: string;
  name?: string;
  createdAt: string;
  joinUrl: string;
  /** ISO 8601 timestamp (e.g., '2026-05-22T16:00:00.000Z'). Updated on every list/resume tick. */
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

function isCloudSessionEntry(x: unknown): x is CloudSessionEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.substrate === 'string' &&
    typeof e.sandboxId === 'string' &&
    typeof e.createdAt === 'string' &&
    typeof e.joinUrl === 'string' &&
    typeof e.lastSeen === 'string' &&
    typeof e.state === 'string' &&
    (e.state === 'running' || e.state === 'paused' || e.state === 'dead')
  );
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
    const sessions: CloudSessionEntry[] = [];
    for (const c of candidates) {
      if (isCloudSessionEntry(c)) sessions.push(c);
      else console.warn('skipping malformed cloud-sessions entry', c);
    }
    return { sessions };
  }

  private async write(data: RegistryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }
}
