/**
 * Workspace isolation modes for child work units (#2277, RFC phase 7).
 *
 * Child creation names a sharing policy instead of relying on the `/scoops/`
 * convention plus implicit `/shared`, mount, `visiblePaths` and
 * `writablePaths` behaviour.
 *
 * Implemented this PR: `private` and `shared-readonly`. `snapshot` (copy-on-
 * write) and `shared-live` are typed stubs — selecting them throws. Copy-on-
 * write snapshots are deferred (RFC open question 4).
 */

import type { WorkspaceIsolationMode } from './types.js';

/** Default child mode — today's scoop: parent workspace visible, own sandbox + `/shared/` writable, mounts readable. */
export const DEFAULT_CHILD_WORKSPACE_MODE = 'shared-readonly' satisfies WorkspaceIsolationMode;

/** Modes `RestrictedFS` actually enforces. */
export const IMPLEMENTED_WORKSPACE_MODES = ['private', 'shared-readonly'] as const;

/** Typed but not built — create / spawn / flags throw if selected. */
export const UNIMPLEMENTED_WORKSPACE_MODES = ['snapshot', 'shared-live'] as const;

export const WORKSPACE_ISOLATION_MODES = [
  ...IMPLEMENTED_WORKSPACE_MODES,
  ...UNIMPLEMENTED_WORKSPACE_MODES,
] as const;

export type ImplementedWorkspaceMode = (typeof IMPLEMENTED_WORKSPACE_MODES)[number];
export type UnimplementedWorkspaceMode = (typeof UNIMPLEMENTED_WORKSPACE_MODES)[number];

export function isWorkspaceIsolationMode(value: string): value is WorkspaceIsolationMode {
  return (WORKSPACE_ISOLATION_MODES as readonly string[]).includes(value);
}

export function isImplementedWorkspaceMode(value: string): value is ImplementedWorkspaceMode {
  return (IMPLEMENTED_WORKSPACE_MODES as readonly string[]).includes(value);
}

export function unimplementedWorkspaceModeError(mode: string): Error {
  return new Error(
    `Workspace isolation mode '${mode}' is not implemented. ` +
      `Use 'private' or 'shared-readonly'. ` +
      `Copy-on-write snapshots are deferred (RFC open question 4).`
  );
}

export type ParseWorkspaceModeResult =
  | { ok: true; mode: ImplementedWorkspaceMode }
  | { ok: false; error: string };

/**
 * Parse a caller-supplied mode. Omitted / empty → {@link DEFAULT_CHILD_WORKSPACE_MODE}
 * so existing scoop_scoop / `agent` callers keep today's sandbox.
 */
export function parseWorkspaceMode(raw: string | undefined): ParseWorkspaceModeResult {
  if (raw === undefined || raw === '') {
    return { ok: true, mode: DEFAULT_CHILD_WORKSPACE_MODE };
  }
  if (isImplementedWorkspaceMode(raw)) {
    return { ok: true, mode: raw };
  }
  if (raw === 'snapshot' || raw === 'shared-live') {
    return { ok: false, error: unimplementedWorkspaceModeError(raw).message };
  }
  return {
    ok: false,
    error:
      `Unknown workspace isolation mode '${raw}'. ` +
      `Use 'private' or 'shared-readonly' (snapshot and shared-live are not implemented).`,
  };
}

/** Resolve a mode or throw. Used by `WorkUnitManager.create`. */
export function resolveWorkspaceMode(raw: string | undefined): ImplementedWorkspaceMode {
  const parsed = parseWorkspaceMode(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.mode;
}

/**
 * Sharing rank for the child ⊆ parent invariant. A child may not pick a more
 * sharing mode than its parent.
 *
 * `private` < `shared-readonly` < `snapshot` < `shared-live`
 */
export function workspaceModeRank(mode: WorkspaceIsolationMode): number {
  switch (mode) {
    case 'private':
      return 0;
    case 'shared-readonly':
      return 1;
    case 'snapshot':
      return 2;
    case 'shared-live':
      return 3;
  }
}

/**
 * Whether RestrictedFS should treat every VFS mount as a readable prefix.
 * `private` turns this off so a mount cannot silently expand a child's
 * authority (#2277).
 */
export function includeMountsForMode(mode: WorkspaceIsolationMode): boolean {
  return mode !== 'private';
}
