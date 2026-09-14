import type { WorkspaceIsolationMode } from './types.js';

export const DEFAULT_CHILD_WORKSPACE_MODE = 'shared-readonly' satisfies WorkspaceIsolationMode;

export const IMPLEMENTED_WORKSPACE_MODES = ['private', 'shared-readonly'] as const;

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

export function resolveWorkspaceMode(raw: string | undefined): ImplementedWorkspaceMode {
  const parsed = parseWorkspaceMode(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.mode;
}

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

export function includeMountsForMode(mode: WorkspaceIsolationMode): boolean {
  return mode !== 'private';
}
