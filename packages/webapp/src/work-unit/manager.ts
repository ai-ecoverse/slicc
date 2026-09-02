/**
 * `WorkUnitManager` — hierarchy-aware facade over the orchestrator's scoop
 * registry (#1666, Phase 1; `createMany` / `join` in Phase 8a / #2278).
 *
 * It answers the questions the RFC says nobody can answer today — "who is
 * my parent?", "which units do I own?", "which root should an unaddressed
 * event go to?" — from the explicit `parentJid` edge instead of a global
 * role lookup. Creation and teardown delegate to the existing
 * register/unregister paths. `join` is a thin map over the scoop-wait
 * completion bus — it must not grow a second waiter table.
 */

import { CURRENT_SCOOP_CONFIG_VERSION, type RegisteredScoop } from '../scoops/types.js';
import { assertChildPolicyAllowed, childrenOf, rootsOf } from './policy.js';
import type { WorkUnitHost, WorkUnitRuntime } from './runtime.js';
import type {
  CreateWorkUnitOptions,
  JoinOptions,
  JoinResult,
  WorkUnitDescriptor,
  WorkUnitId,
} from './types.js';

/** One row of the scoop-wait bus. Structurally the completion-service `WaitResult`. */
export interface CompletionWaitResult {
  jid: WorkUnitId;
  summary: string | null;
  timedOut: boolean;
}

/** What the manager needs beyond a {@link WorkUnitHost}. */
export interface WorkUnitManagerHost extends WorkUnitHost {
  getScoops(): RegisteredScoop[];
  registerScoop(scoop: RegisteredScoop): Promise<void>;
  /**
   * Wait until each unit's current work settles, up to an optional timeout.
   * This IS `ScoopCompletionService.waitForScoops` — `join` must not grow a
   * second wait bus. Unknown ids come back as `timedOut` immediately.
   */
  waitForScoops(jids: readonly WorkUnitId[], timeoutMs?: number): Promise<CompletionWaitResult[]>;
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

  /**
   * Register a unit. A child's parent must exist and the child policy ⊆ it.
   * An explicit (or generated) id that is already in the registry is rejected —
   * `registerScoop` would otherwise overwrite via `Map.set`.
   */
  async create(options: CreateWorkUnitOptions): Promise<WorkUnitDescriptor> {
    const record = buildWorkUnitRecord(options);
    assertIdAvailable(record.jid, (id) => this.host.getScoop(id));
    if (options.parentId !== null) {
      const parent = this.host.getScoop(options.parentId);
      if (!parent) {
        throw new Error(`Parent work unit not found: ${options.parentId}`);
      }
      assertChildPolicyAllowed(record, parent);
    }
    await this.host.registerScoop(record);
    return this.get(record.jid)!.descriptor;
  }

  /**
   * Register many units. Fail closed: a missing parent, a duplicate explicit
   * `id`, an id already in the registry, or a cycle in the batch throws
   * before anything is registered. Intra-batch edges (`parentId` matching
   * another option's explicit `id`) are applied parent-before-child; the
   * returned array matches `options` order. A `registerScoop` failure rolls
   * back every unit already created in this call (`close`), so the registry
   * is left as it was.
   */
  async createMany(options: CreateWorkUnitOptions[]): Promise<WorkUnitDescriptor[]> {
    if (options.length === 0) return [];
    assertCreateManyOptions(options, (id) => this.host.getScoop(id));
    const stamped = stampCreateManyIds(options);
    for (const opts of stamped) {
      if (opts.id) assertIdAvailable(opts.id, (id) => this.host.getScoop(id));
    }
    const ordered = orderCreateMany(stamped);
    const created: WorkUnitId[] = [];
    const byOption = new Map<CreateWorkUnitOptions, WorkUnitDescriptor>();
    try {
      for (const opts of ordered) {
        const descriptor = await this.create(opts);
        created.push(descriptor.id);
        byOption.set(opts, descriptor);
      }
    } catch (err) {
      for (let i = created.length - 1; i >= 0; i--) {
        await this.close(created[i]).catch(() => undefined);
      }
      throw err;
    }
    return stamped.map((opts) => byOption.get(opts)!);
  }

  /**
   * Wait until each unit settles or `options.timeoutMs` fires. Thin map over
   * {@link WorkUnitManagerHost.waitForScoops} — the scoop-wait completion
   * bus `scoop_wait` already uses. Product tools stay aliases; this is the
   * blocking supervisor form. Unknown ids are `timedOut` immediately.
   */
  async join(ids: readonly WorkUnitId[], options?: JoinOptions): Promise<JoinResult[]> {
    const results = await this.host.waitForScoops(ids, options?.timeoutMs);
    return results.map((r) => ({ id: r.jid, summary: r.summary, timedOut: r.timedOut }));
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

/**
 * Assign unique ids up front so two roots created in the same millisecond
 * do not collide on `cone_${Date.now()}` and overwrite each other. Caller-
 * supplied ids are left alone.
 */
function stampCreateManyIds(options: CreateWorkUnitOptions[]): CreateWorkUnitOptions[] {
  let t = Date.now();
  return options.map((opts) => {
    if (opts.id) return opts;
    const folder = opts.folder ?? opts.name;
    const id = opts.parentId === null ? `cone_${t++}` : `scoop_${folder}_${t++}`;
    return { ...opts, id };
  });
}

/** Fail closed: `registerScoop` overwrites a live record via `Map.set`. */
function assertIdAvailable(
  id: WorkUnitId,
  getScoop: (id: WorkUnitId) => RegisteredScoop | undefined
): void {
  if (getScoop(id)) {
    throw new Error(`Work unit already exists: ${id}`);
  }
}

/**
 * Fail closed before any register: duplicate explicit ids, an id already in
 * the registry, and every `parentId` must already exist or be an explicit
 * `id` elsewhere in the batch.
 */
function assertCreateManyOptions(
  options: readonly CreateWorkUnitOptions[],
  getScoop: (id: WorkUnitId) => RegisteredScoop | undefined
): void {
  const batchIds = new Set<WorkUnitId>();
  for (const opts of options) {
    if (!opts.id) continue;
    if (batchIds.has(opts.id)) {
      throw new Error(`Duplicate work unit id in createMany: ${opts.id}`);
    }
    assertIdAvailable(opts.id, getScoop);
    batchIds.add(opts.id);
  }
  const missing: WorkUnitId[] = [];
  const seenMissing = new Set<WorkUnitId>();
  for (const opts of options) {
    if (opts.parentId === null) continue;
    if (getScoop(opts.parentId) || batchIds.has(opts.parentId)) continue;
    if (seenMissing.has(opts.parentId)) continue;
    seenMissing.add(opts.parentId);
    missing.push(opts.parentId);
  }
  if (missing.length > 0) {
    throw new Error(`Parent work unit not found: ${missing.join(', ')}`);
  }
}

/**
 * Parent-before-child permutation of a `createMany` batch. Intra-batch
 * edges are `parentId` matching another option's explicit `id`. A cycle
 * throws; callers that already ran {@link assertCreateManyOptions} still
 * need this so a loop cannot register a prefix.
 */
function orderCreateMany(options: readonly CreateWorkUnitOptions[]): CreateWorkUnitOptions[] {
  const n = options.length;
  if (n <= 1) return options.slice();

  const idToIndex = new Map<WorkUnitId, number>();
  for (let i = 0; i < n; i++) {
    const id = options[i].id;
    if (id) idToIndex.set(id, i);
  }

  const indegree = new Array<number>(n).fill(0);
  const children: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const parentId = options[i].parentId;
    if (parentId === null) continue;
    const parentIndex = idToIndex.get(parentId);
    if (parentIndex === undefined) continue;
    children[parentIndex].push(i);
    indegree[i] += 1;
  }

  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (indegree[i] === 0) queue.push(i);
  }
  const ordered: CreateWorkUnitOptions[] = [];
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    ordered.push(options[i]);
    for (const child of children[i]) {
      indegree[child] -= 1;
      if (indegree[child] === 0) queue.push(child);
    }
  }
  if (ordered.length !== n) {
    throw new Error('createMany cycle: parentId edges in this batch form a cycle');
  }
  return ordered;
}
