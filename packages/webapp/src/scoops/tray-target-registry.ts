import type { RemoteTargetInfo, TrayTargetEntry } from './tray-sync-protocol.js';

export class TrayTargetRegistry {
  private readonly runtimes = new Map<string, RemoteTargetInfo[]>();
  private dirty = false;

  setTargets(runtimeId: string, targets: RemoteTargetInfo[]): void {
    this.runtimes.set(runtimeId, targets);
    this.dirty = true;
  }

  removeRuntime(runtimeId: string): void {
    if (this.runtimes.delete(runtimeId)) {
      this.dirty = true;
    }
  }

  getEntries(): TrayTargetEntry[] {
    this.dirty = false;
    const entries: TrayTargetEntry[] = [];
    for (const [runtimeId, targets] of this.runtimes) {
      for (const t of targets) {
        entries.push({
          targetId: `${runtimeId}:${t.targetId}`,
          localTargetId: t.targetId,
          runtimeId,
          title: t.title,
          url: t.url,
          isLocal: false,
          kind: t.kind ?? 'browser',
          capabilities: t.capabilities,
        });
      }
    }
    return entries;
  }

  hasChanged(): boolean {
    return this.dirty;
  }

  getRuntimeIds(): string[] {
    return [...this.runtimes.keys()];
  }
}
