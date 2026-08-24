/**
 * `WorkUnitManager` — hierarchy-aware facade over the orchestrator's scoop
 * registry (#1666, Phase 1).
 *
 * It answers the questions the RFC says nobody can answer today — "who is
 * my parent?", "which units do I own?", "which root should an unaddressed
 * event go to?" — from the explicit `parentJid` edge instead of a global
 * role lookup. Creation and teardown delegate to the existing
 * register/unregister paths.
 */

import { CURRENT_SCOOP_CONFIG_VERSION, type RegisteredScoop } from '../scoops/types.js';
import { childrenOf, rootsOf } from './policy.js';
import type { WorkUnitHost, WorkUnitRuntime } from './runtime.js';
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

  /**
   * Runtime view of one unit, or `null` when unknown. Every registered
   * record has exactly one owning `LiveWorkUnit`, created on first reach —
   * the runtime is deliberately NOT cached here, so a unit the host has
   * dropped (e.g. `destroyScoopTab` without unregister) is replaced rather
   * than kept alive as a closed shell.
   */
  get(id: WorkUnitId): WorkUnitRuntime | null {
    if (!this.host.getScoop(id)) return null;
    return this.host.ensureLiveUnit(id);
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
   * the oldest root. Replaces the global cone lookup; a later phase makes
   * this the UI-selected root.
   */
  resolveDefaultRoot(): WorkUnitRuntime | null {
    return this.roots()[0] ?? null;
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
  }
}
