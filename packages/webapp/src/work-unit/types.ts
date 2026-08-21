/**
 * WorkUnit — the common runtime primitive behind the cone and every scoop
 * (#1666, Phase 1).
 *
 * Product vocabulary stays: a **cone** is the user's root agent, a **scoop**
 * is a delegated child. At the kernel level both are one `WorkUnit`:
 *
 * > one LLM conversation + one filesystem view + one shell/process group +
 * > one agent runtime + an explicit policy and lifecycle.
 *
 * The only structural difference is the ownership edge: a root has
 * `parentId === null`; a child names the unit that owns it. Everything else
 * (filesystem reach, approval authority, child management, completion
 * routing) is a {@link WorkUnitPolicy} / {@link CompletionPolicy} derived from
 * that edge — never an `isCone` branch.
 *
 * Phase 1 ships the vocabulary, a descriptor projection and an adapter over
 * the existing `ScoopContext` runtime. Nothing in here knows about the DOM,
 * deployment floats, the extension, or tray transports.
 */

import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';

/** Identity of a work unit. Today this IS the scoop `jid`. */
export type WorkUnitId = string;

/**
 * Lifecycle of one unit. Maps 1:1 from `ScoopTabState['status']` plus a
 * terminal `closed` the tab model never had (a dropped scoop simply vanished).
 *
 * ```
 * creating → ready ⇄ running
 *    any   → failed   (retryable: a fresh spawn returns to `creating`)
 *    any   → closed   (terminal)
 * ```
 */
export type WorkUnitStatus = 'creating' | 'ready' | 'running' | 'failed' | 'closed';

/** Presentation role. Derived from the parent edge, never stored. */
export type WorkUnitRole = 'primary' | 'child';

/**
 * What a unit may touch on the shared workspace. `full-workspace` is the
 * unrestricted `VirtualFS` the cone gets today; `restricted` is the
 * `RestrictedFS` view a scoop gets, parameterised by its `ScoopConfig` paths.
 */
export type FileSystemPolicy =
  | { kind: 'full-workspace' }
  | {
      kind: 'restricted';
      writablePaths: readonly string[];
      visiblePaths: readonly string[];
    };

/** Who settles a privileged request raised by this unit. */
export type ApprovalAuthority = 'user' | { parentId: WorkUnitId };

/**
 * Capability set of one unit. Child capabilities are a subset of the
 * parent's unless the user explicitly grants more (enforced by
 * {@link import('./policy.js').isPolicySubset}).
 */
export interface WorkUnitPolicy {
  filesystem: FileSystemPolicy;
  /** May spawn child units (`scoop_scoop`). */
  canCreateChildren: boolean;
  /** May feed / drop / mute / wait on children. */
  canManageChildren: boolean;
  /** May rewrite `/shared/CLAUDE.md` and append to the cone memory. */
  canWriteSharedMemory: boolean;
  /** May settle sudo requests raised by other units. */
  canResolveApprovals: boolean;
  approvalAuthority: ApprovalAuthority;
  /**
   * Default sudo disposition for the unit's own shell: a root auto-allows
   * against the user policy, a child must ask (`scoop-context.ts`
   * `buildSudoWiring`).
   */
  sudoDefaultDisposition: 'allow' | 'require-approval';
  /**
   * Whether the unit's shell may persist "Always" grants into the shared
   * `/etc/sudoers.d/granted`. Only a root may — a child grant lands scoped
   * through the parent-mediated path instead.
   */
  persistCommandGrants: boolean;
}

/**
 * What happens when a unit's turn settles.
 *
 * - `interactive` — a root: the user reads the reply, nobody is notified.
 * - `notify-parent` — the default child mode: the parent receives a
 *   `scoop-notify` message with the artifact path.
 * - `silent` — an ephemeral child whose caller drains the output through an
 *   observer (`notifyOnComplete === false` today).
 */
export type CompletionPolicy =
  | { mode: 'interactive' }
  | { mode: 'notify-parent' }
  | { mode: 'silent' };

/** Filesystem coordinates derived once from the unit's role and folder. */
export interface WorkUnitWorkspace {
  /** Working directory of the unit's shell and agent. */
  root: string;
  /** Per-unit `CLAUDE.md` memory file. */
  memoryPath: string;
  /** Private scratch directory (`/tmp` for a root, `/scoops/<folder>` for a child). */
  scratch: string;
}

/** Pure, serialisable description of one unit. */
export interface WorkUnitDescriptor {
  id: WorkUnitId;
  parentId: WorkUnitId | null;
  name: string;
  folder: string;
  status: WorkUnitStatus;
  display: {
    role: WorkUnitRole;
    /** Assistant label shown in the UI (`sliccy` for the cone). */
    label: string;
  };
  workspace: WorkUnitWorkspace;
  policy: WorkUnitPolicy;
  completion: CompletionPolicy;
}

/** Events a unit emits to subscribers. Mirrors `ScoopObserver` 1:1. */
export type WorkUnitEvent =
  | { type: 'status'; status: WorkUnitStatus }
  | { type: 'response'; text: string; isPartial: boolean }
  | { type: 'send-message'; text: string }
  | { type: 'error'; error: string };

export type WorkUnitEventListener = (event: WorkUnitEvent) => void;
export type Unsubscribe = () => void;

/** A prompt delivered to a unit. */
export interface WorkUnitInput {
  text: string;
  senderId?: string;
  senderName?: string;
  /** Steer the running turn instead of queueing behind it. */
  steer?: boolean;
}

/** Point-in-time view of a unit: its descriptor plus the settled history. */
export interface WorkUnitSnapshot {
  descriptor: WorkUnitDescriptor;
  /** Settled agent messages in Pi wire shape; empty when no runtime is live. */
  messages: readonly unknown[];
  /** 0–1 share of the context window in use (`ScoopContext.getContextFill`). */
  contextFill: number;
}

/** Map a `ScoopTabState` status onto the unit lifecycle. */
export function statusFromTab(status: ScoopTabState['status'] | undefined): WorkUnitStatus {
  switch (status) {
    case 'initializing':
      return 'creating';
    case 'processing':
      return 'running';
    case 'error':
      return 'failed';
    case 'ready':
      return 'ready';
    default:
      return 'creating';
  }
}

/** Options accepted by `WorkUnitManager.create`. */
export interface CreateWorkUnitOptions {
  /** `null` creates a root; a jid creates a child of that unit. */
  parentId: WorkUnitId | null;
  name: string;
  /** Sanitised storage folder; defaults to `name`. */
  folder?: string;
  /** Carried through to `RegisteredScoop.config` unchanged. */
  config?: RegisteredScoop['config'];
  /** `silent` completion (ephemeral callers draining via observer). */
  notifyOnComplete?: boolean;
  /** Caller-supplied id; defaults to the conventional `cone_…` / `scoop_…`. */
  id?: WorkUnitId;
}
