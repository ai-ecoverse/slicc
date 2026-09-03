import type { RegisteredScoop, ScoopTabState } from '../../scoops/types.js';
import { rootsOf } from '../../work-unit/policy.js';
import { modelIdFor, modelProviderFor, thinkingFor } from '../../work-unit/record.js';
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
      // The ownership edge (#1666) — the panel's only role input, since the
      // tray wire's derived `isCone` flag is not on this boundary (#2358).
      parentId: scoop.parentJid,
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
    const cone = rootsOf(registeredScoops)[0];
    return {
      type: 'state-snapshot',
      scoops,
      activeScoopJid: this.activeScoopJid ?? cone?.jid ?? null,
      trayRuntimeStatus,
    };
  }
}

/**
 * Project the unit's own model + thinking (#2310) onto the panel-facing
 * snapshot. Both now live on the RECORD; the snapshot keeps the historical
 * `config` shape so a panel from before this change keeps reading the model
 * id and brain level exactly where it always did.
 */
function projectConfig(scoop: RegisteredScoop): ScoopSnapshotConfig | undefined {
  const modelId = modelIdFor(scoop);
  const modelProviderId = modelProviderFor(scoop);
  const { level: thinkingLevel, effortOverride } = thinkingFor(scoop);
  if (
    modelId === undefined &&
    modelProviderId === undefined &&
    thinkingLevel === undefined &&
    effortOverride === undefined
  ) {
    return undefined;
  }
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(modelProviderId !== undefined ? { modelProviderId } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(effortOverride !== undefined ? { effortOverride } : {}),
  };
}
