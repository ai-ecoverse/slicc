import {
  CURRENT_SCOOP_CONFIG_VERSION,
  type RegisteredScoop,
  type ScoopConfig,
} from '../scoops/types.js';
import { conversationKeyFor, workspaceIdFor } from './conversation/key.js';
import type { ConversationIdentity } from './conversation/store.js';
import { defaultChildPathsForMode, workspaceFor } from './descriptor.js';
import { assertChildPolicyAllowed, childrenOf, rootsOf } from './policy.js';
import { chatSessionIdFor, normalizeScoopRecord } from './record.js';
import type { WorkUnitHost, WorkUnitRuntime } from './runtime.js';
import type {
  CloseWorkUnitOptions,
  CreateWorkUnitOptions,
  JoinOptions,
  JoinResult,
  OnParentClose,
  WorkUnitDescriptor,
  WorkUnitId,
} from './types.js';
import { DEFAULT_CHILD_WORKSPACE_MODE, resolveWorkspaceMode } from './workspace-mode.js';

export interface CompletionWaitResult {
  jid: WorkUnitId;
  summary: string | null;
  timedOut: boolean;
}

export interface WorkUnitManagerHost extends WorkUnitHost {
  getScoops(): RegisteredScoop[];
  registerScoop(scoop: RegisteredScoop): Promise<void>;

  persistScoop(scoop: RegisteredScoop): Promise<void>;

  reinitLiveUnit(id: WorkUnitId): Promise<void>;

  rekeyConversation?(fromKey: string, identity: ConversationIdentity): Promise<void>;

  waitForScoops(jids: readonly WorkUnitId[], timeoutMs?: number): Promise<CompletionWaitResult[]>;
}

export function buildWorkUnitRecord(
  options: CreateWorkUnitOptions,
  now: () => number = Date.now
): RegisteredScoop {
  const root = options.parentId === null;
  const folder = options.folder ?? options.name;
  const config = root ? options.config : childConfigForCreate(options, folder);
  const base: RegisteredScoop = {
    jid: options.id ?? (root ? `cone_${now()}` : `scoop_${folder}_${now()}`),
    name: options.name,
    folder,
    requiresTrigger: !root,
    assistantLabel: root ? 'sliccy' : folder,
    addedAt: new Date(now()).toISOString(),
    parentJid: options.parentId,
    ...(config ? { config, configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION } : {}),
    ...(options.notifyOnComplete === false ? { notifyOnComplete: false } : {}),
    ...(!root && options.onParentClose === 'detach' ? { onParentClose: 'detach' as const } : {}),
  };
  if (!root) base.trigger = `@${folder}`;
  return base;
}

function childConfigForCreate(options: CreateWorkUnitOptions, folder: string): ScoopConfig {
  const mode = resolveWorkspaceMode(options.workspace?.mode ?? options.config?.workspaceMode);
  const ownerRoot = options.workspace?.from ?? '/workspace';
  const defaults = defaultChildPathsForMode(
    mode,
    folder,
    { root: ownerRoot },
    options.workspace?.from
  );
  const existing = options.config;
  return {
    ...existing,
    workspaceMode: mode,
    visiblePaths:
      existing?.visiblePaths !== undefined ? existing.visiblePaths : defaults.visiblePaths,
    writablePaths:
      existing?.writablePaths !== undefined ? existing.writablePaths : defaults.writablePaths,
  };
}

function withOwnerWorkspace(
  options: CreateWorkUnitOptions,
  host: WorkUnitManagerHost
): CreateWorkUnitOptions {
  if (options.parentId === null) return options;
  if (options.workspace?.from !== undefined) return options;
  const parent = host.getScoop(options.parentId);
  if (!parent) return options;
  return {
    ...options,
    workspace: {
      mode:
        options.workspace?.mode ?? options.config?.workspaceMode ?? DEFAULT_CHILD_WORKSPACE_MODE,
      from: workspaceFor(parent).root,
    },
  };
}

export class WorkUnitManager {
  constructor(private readonly host: WorkUnitManagerHost) {}

  async create(options: CreateWorkUnitOptions): Promise<WorkUnitDescriptor> {
    if (options.parentId === null && options.workspace?.mode !== undefined) {
      resolveWorkspaceMode(options.workspace.mode);
    }
    const record = buildWorkUnitRecord(withOwnerWorkspace(options, this.host));
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

  async createMany(options: CreateWorkUnitOptions[]): Promise<WorkUnitDescriptor[]> {
    if (options.length === 0) return [];
    assertCreateManyOptions(
      options,
      (id) => this.host.getScoop(id),
      () => this.host.getScoops()
    );
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

  async join(ids: readonly WorkUnitId[], options?: JoinOptions): Promise<JoinResult[]> {
    const results = await this.host.waitForScoops(ids, options?.timeoutMs);
    return results.map((r) => ({ id: r.jid, summary: r.summary, timedOut: r.timedOut }));
  }

  list(): WorkUnitDescriptor[] {
    return this.host.getScoops().map((scoop) => this.get(scoop.jid)!.descriptor);
  }

  get(id: WorkUnitId): WorkUnitRuntime | null {
    if (!this.host.getScoop(id)) return null;
    return this.host.ensureLiveUnit(id);
  }

  getParent(id: WorkUnitId): WorkUnitRuntime | null {
    const parentId = this.host.getScoop(id)?.parentJid;
    return parentId ? this.get(parentId) : null;
  }

  getChildren(id: WorkUnitId): WorkUnitRuntime[] {
    return childrenOf(this.host.getScoops(), id)
      .map((scoop) => this.get(scoop.jid))
      .filter((runtime): runtime is WorkUnitRuntime => runtime !== null);
  }

  roots(): WorkUnitRuntime[] {
    return rootsOf(this.host.getScoops())
      .map((scoop) => this.get(scoop.jid))
      .filter((runtime): runtime is WorkUnitRuntime => runtime !== null);
  }

  resolveDefaultRoot(): WorkUnitRuntime | null {
    return this.roots()[0] ?? null;
  }

  rootOf(id: WorkUnitId): WorkUnitRuntime | null {
    const seen = new Set<WorkUnitId>();
    let current = this.host.getScoop(id);
    while (current && current.parentJid !== null) {
      if (seen.has(current.jid)) return null;
      seen.add(current.jid);
      current = this.host.getScoop(current.parentJid);
    }
    return current ? this.get(current.jid) : null;
  }

  abort(id: WorkUnitId, reason?: string): Promise<void> {
    const runtime = this.get(id);
    return runtime ? runtime.abort(reason) : Promise.resolve();
  }

  async promote(id: WorkUnitId): Promise<WorkUnitDescriptor> {
    const scoop = this.host.getScoop(id);
    if (!scoop) throw new Error(`Work unit not found: ${id}`);
    if (scoop.parentJid === null) return this.get(id)!.descriptor;

    const fromConversationKey = conversationKeyFor(scoop);
    const previous = snapshotOwnership(scoop, scoop.parentJid);
    scoop.parentJid = null;
    normalizeScoopRecord(scoop);
    try {
      await this.host.persistScoop(scoop);
    } catch (err) {
      restoreOwnership(scoop, previous);
      throw err;
    }

    await this.host.rekeyConversation?.(fromConversationKey, {
      key: conversationKeyFor(scoop),
      workUnitId: scoop.jid,
      workspaceId: workspaceIdFor(scoop),
      folder: scoop.folder,
      legacyKeys: {
        agentSessionId: scoop.jid,
        chatSessionId: chatSessionIdFor(scoop),
      },
    });
    await this.host.reinitLiveUnit(id);
    return this.get(id)!.descriptor;
  }

  detach(id: WorkUnitId): Promise<WorkUnitDescriptor> {
    return this.promote(id);
  }

  async close(id: WorkUnitId, options?: CloseWorkUnitOptions): Promise<void> {
    const runtime = this.get(id);
    if (!runtime) return;

    const children = this.getChildren(id);
    for (const child of children) {
      if (descendantClose(child, options) === 'detach') {
        await this.promote(child.descriptor.id);
      } else {
        await this.close(child.descriptor.id, options);
      }
    }
    await runtime.close();
  }
}

function descendantClose(child: WorkUnitRuntime, options?: CloseWorkUnitOptions): OnParentClose {
  return options?.descendants ?? child.descriptor.onParentClose;
}

interface OwnershipSnapshot {
  parentJid: string;
  trigger: RegisteredScoop['trigger'];
  requiresTrigger: boolean;
  approvesGuestRequests: RegisteredScoop['approvesGuestRequests'];
  onParentClose: RegisteredScoop['onParentClose'];
}

function snapshotOwnership(scoop: RegisteredScoop, parentJid: string): OwnershipSnapshot {
  return {
    parentJid,
    trigger: scoop.trigger,
    requiresTrigger: scoop.requiresTrigger,
    approvesGuestRequests: scoop.approvesGuestRequests,
    onParentClose: scoop.onParentClose,
  };
}

function restoreOwnership(scoop: RegisteredScoop, previous: OwnershipSnapshot): void {
  scoop.parentJid = previous.parentJid;
  scoop.trigger = previous.trigger;
  scoop.requiresTrigger = previous.requiresTrigger;
  scoop.approvesGuestRequests = previous.approvesGuestRequests;
  scoop.onParentClose = previous.onParentClose;
}

function stampCreateManyIds(options: CreateWorkUnitOptions[]): CreateWorkUnitOptions[] {
  let t = Date.now();
  return options.map((opts) => {
    if (opts.id) return opts;
    const folder = opts.folder ?? opts.name;
    const id = opts.parentId === null ? `cone_${t++}` : `scoop_${folder}_${t++}`;
    return { ...opts, id };
  });
}

function assertIdAvailable(
  id: WorkUnitId,
  getScoop: (id: WorkUnitId) => RegisteredScoop | undefined
): void {
  if (getScoop(id)) {
    throw new Error(`Work unit already exists: ${id}`);
  }
}

function assertCreateManyOptions(
  options: readonly CreateWorkUnitOptions[],
  getScoop: (id: WorkUnitId) => RegisteredScoop | undefined,
  getScoops: () => readonly RegisteredScoop[]
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
  assertCreateManyFolders(options, getScoops);
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

function assertCreateManyFolders(
  options: readonly CreateWorkUnitOptions[],
  getScoops: () => readonly RegisteredScoop[]
): void {
  const taken = new Set(getScoops().map((s) => s.folder));
  const batchFolders = new Set<string>();
  for (const opts of options) {
    const folder = opts.folder ?? opts.name;
    if (batchFolders.has(folder) || taken.has(folder)) {
      throw new Error(`Duplicate work unit folder in createMany: ${folder}`);
    }
    batchFolders.add(folder);
  }
}

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
