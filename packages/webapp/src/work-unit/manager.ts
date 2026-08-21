/**
 * `WorkUnitManager` — hierarchy-aware facade over the orchestrator's scoop
 * registry (#1666, Phase 1).
 *
 * It answers the questions the RFC says nobody can answer today — "who is
 * my parent?", "which units do I own?", "which root should an unaddressed
 * event go to?" — from the explicit `parentJid` edge instead of a global
 * `scoops.find(s => s.isCone)`. Creation and teardown delegate to the
 * existing register/unregister paths so Phase 1 changes no behaviour.
 */

import { CURRENT_SCOOP_CONFIG_VERSION, type RegisteredScoop } from '../scoops/types.js';
import { pickDefaultRoot } from './default-root.js';
import { childrenOf, rootsOf } from './policy.js';
import { ScoopContextWorkUnit, type WorkUnitHost, type WorkUnitRuntime } from './runtime.js';
import type { CreateWorkUnitOptions, WorkUnitDescriptor, WorkUnitId } from './types.js';

/** What the manager needs beyond a {@link WorkUnitHost}. */
export interface WorkUnitManagerHost extends WorkUnitHost {
  getScoops(): RegisteredScoop[];
  registerScoop(scoop: RegisteredScoop): Promise<void>;
}

/** Build the `RegisteredScoop` record for a new unit. Exported for tests. */
export function buildWorkUnitRecord(
  options: CreateWorkUnitOptions,
  now: () => number = Date.now
): RegisteredScoop {
  const root = options.parentId === null;
  const folder = options.folder ?? options.name;
  const base: RegisteredScoop = {
    jid: options.id ?? (root ? `cone_${now()}` : `scoop_${folder}_${now()}`),
    name: options.name,
    folder,
    isCone: root,
    type: root ? 'cone' : 'scoop',
    requiresTrigger: !root,
    assistantLabel: root ? 'sliccy' : folder,
    addedAt: new Date(now()).toISOString(),
    parentJid: options.parentId,
    ...(options.config
      ? { config: options.config, configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION }
      : {}),
    ...(options.notifyOnComplete === false ? { notifyOnComplete: false } : {}),
  };
  if (!root) base.trigger = `@${folder}`;
  return base;
}

export class WorkUnitManager {
  private readonly runtimes = new Map<WorkUnitId, WorkUnitRuntime>();

  constructor(private readonly host: WorkUnitManagerHost) {}

  /** Register a unit. A child's parent must exist. */
  async create(options: CreateWorkUnitOptions): Promise<WorkUnitDescriptor> {
    if (options.parentId !== null && !this.host.getScoop(options.parentId)) {
      throw new Error(`Parent work unit not found: ${options.parentId}`);
    }
    const record = buildWorkUnitRecord(options);
    await this.host.registerScoop(record);
    return this.get(record.jid)!.descriptor;
  }

  /** Descriptors of every registered unit. */
  list(): WorkUnitDescriptor[] {
    return this.host.getScoops().map((scoop) => this.get(scoop.jid)!.descriptor);
  }

  /** Runtime view of one unit, or `null` when unknown. */
  get(id: WorkUnitId): WorkUnitRuntime | null {
    if (!this.host.getScoop(id)) {
      this.runtimes.delete(id);
      return null;
    }
    // Prefer the owning live runtime; fall back to the read-through adapter
    // for a record whose runtime has not been spawned yet. The live unit is
    // deliberately NOT cached: once the host drops it (e.g. `destroyScoopTab`
    // without unregister) a fresh adapter must take over, not a closed unit.
    const live = this.host.getLiveUnit?.(id);
    if (live) return live;
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = new ScoopContextWorkUnit(id, this.host);
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  /** The unit that owns `id`, or `null` for a root / unknown id. */
  getParent(id: WorkUnitId): WorkUnitRuntime | null {
    const parentId = this.host.getScoop(id)?.parentJid;
    return parentId ? this.get(parentId) : null;
  }

  /** Units owned directly by `id`. */
  getChildren(id: WorkUnitId): WorkUnitRuntime[] {
    return childrenOf(this.host.getScoops(), id)
      .map((scoop) => this.get(scoop.jid))
      .filter((runtime): runtime is WorkUnitRuntime => runtime !== null);
  }

  /** Root units, oldest first. */
  roots(): WorkUnitRuntime[] {
    return rootsOf(this.host.getScoops())
      .map((scoop) => this.get(scoop.jid))
      .filter((runtime): runtime is WorkUnitRuntime => runtime !== null);
  }

  /**
   * The root an unaddressed event (lick, sprinkle, webhook) should reach:
   * the user's "Make default" pick from the Cones rail while that root is
   * still registered, else the primary cone, else the oldest root (#2273).
   */
  resolveDefaultRoot(): WorkUnitRuntime | null {
    const record = pickDefaultRoot(this.host.getScoops());
    return record ? this.get(record.jid) : null;
  }

  /** Owning root of `id` (itself when `id` is a root), or `null` when unknown. */
  rootOf(id: WorkUnitId): WorkUnitRuntime | null {
    const seen = new Set<WorkUnitId>();
    let current = this.host.getScoop(id);
    while (current && current.parentJid !== null) {
      if (seen.has(current.jid)) return null; // defensive: cycle in persisted data
      seen.add(current.jid);
      current = this.host.getScoop(current.parentJid);
    }
    return current ? this.get(current.jid) : null;
  }

  abort(id: WorkUnitId, reason?: string): Promise<void> {
    const runtime = this.get(id);
    return runtime ? runtime.abort(reason) : Promise.resolve();
  }

  /**
   * Close a unit and, first, everything it owns. A parent never outlives its
   * children's teardown, and closing root A never touches root B's subtree.
   */
  async close(id: WorkUnitId): Promise<void> {
    const runtime = this.get(id);
    if (!runtime) return;
    for (const child of this.getChildren(id)) {
      await this.close(child.descriptor.id);
    }
    await runtime.close();
    this.runtimes.delete(id);
  }
}
