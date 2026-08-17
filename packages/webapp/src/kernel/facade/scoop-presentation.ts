import type { RegisteredScoop, ScoopTabState } from '../../scoops/types.js';
import type {
  ScoopListMsg,
  ScoopSnapshotConfig,
  StateSnapshotMsg,
  TrayRuntimeStatusMsg,
} from '../messages.js';

export type ScoopSnapshot = ScoopListMsg['scoops'][number];

/** Owns panel-facing scoop selection/status state and its wire projections. */
export class ScoopPresentation {
  private readonly statuses = new Map<string, ScoopTabState['status']>();
  private activeScoopJid: string | null = null;

  setStatus(scoopJid: string, status: ScoopTabState['status']): void {
    this.statuses.set(scoopJid, status);
  }

  clearStatus(scoopJid: string): void {
    this.statuses.delete(scoopJid);
  }

  setActiveScoopJid(scoopJid: string | null): void {
    this.activeScoopJid = scoopJid;
  }

  getActiveScoopJid(): string | null {
    return this.activeScoopJid;
  }

  projectScoop(scoop: RegisteredScoop): ScoopSnapshot {
    const config = projectConfig(scoop);
    return {
      jid: scoop.jid,
      name: scoop.name,
      folder: scoop.folder,
      isCone: scoop.isCone,
      assistantLabel: scoop.assistantLabel,
      status: this.statuses.get(scoop.jid) ?? 'ready',
      ...(config ? { config } : {}),
    };
  }

  projectScoops(scoops: readonly RegisteredScoop[]): ScoopListMsg['scoops'] {
    return scoops.map((scoop) => this.projectScoop(scoop));
  }

  buildStateSnapshot(
    registeredScoops: readonly RegisteredScoop[],
    trayRuntimeStatus: Pick<TrayRuntimeStatusMsg, 'leader' | 'follower'>
  ): StateSnapshotMsg {
    const scoops = this.projectScoops(registeredScoops);
    const cone = scoops.find((scoop) => scoop.isCone);
    return {
      type: 'state-snapshot',
      scoops,
      activeScoopJid: this.activeScoopJid ?? cone?.jid ?? null,
      trayRuntimeStatus,
    };
  }
}

function projectConfig(scoop: RegisteredScoop): ScoopSnapshotConfig | undefined {
  if (!scoop.config) return undefined;
  const { modelId, thinkingLevel } = scoop.config;
  if (modelId === undefined && thinkingLevel === undefined) return undefined;
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
}
