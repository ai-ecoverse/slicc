import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';

export type WorkUnitId = string;

export type WorkUnitStatus = 'creating' | 'ready' | 'running' | 'failed' | 'closed';

export type WorkUnitRole = 'primary' | 'child';

export type WorkspaceIsolationMode = 'private' | 'shared-readonly' | 'snapshot' | 'shared-live';

export interface WorkspaceHandle {
  workspaceId: string;
  root: string;
  access: WorkspaceIsolationMode;
}

export type FileSystemPolicy =
  | { kind: 'full-workspace' }
  | {
      kind: 'restricted';

      mode: WorkspaceIsolationMode;
      writablePaths: readonly string[];
      visiblePaths: readonly string[];
    };

export type ApprovalAuthority = 'user' | { parentId: WorkUnitId };

export interface WorkUnitPolicy {
  filesystem: FileSystemPolicy;

  allowedCommands?: readonly string[];

  canCreateChildren: boolean;

  canManageChildren: boolean;

  canWriteSharedMemory: boolean;

  canResolveApprovals: boolean;
  approvalAuthority: ApprovalAuthority;

  sudoDefaultDisposition: 'allow' | 'require-approval';

  persistCommandGrants: boolean;
}

export type CompletionPolicy =
  | { mode: 'interactive' }
  | { mode: 'notify-parent' }
  | { mode: 'silent' };

export type OnParentClose = 'cascade' | 'detach';

export interface WorkUnitWorkspace {
  root: string;

  memoryPath: string;

  scratch: string;
}

export interface WorkUnitDescriptor {
  id: WorkUnitId;
  parentId: WorkUnitId | null;
  name: string;
  folder: string;
  status: WorkUnitStatus;
  display: {
    role: WorkUnitRole;

    label: string;
  };
  workspace: WorkUnitWorkspace;

  workspaceHandle: WorkspaceHandle;
  policy: WorkUnitPolicy;
  completion: CompletionPolicy;

  onParentClose: OnParentClose;
}

export type WorkUnitEvent =
  | { type: 'status'; status: WorkUnitStatus }
  | { type: 'response'; text: string; isPartial: boolean }
  | { type: 'send-message'; text: string }
  | { type: 'error'; error: string };

export type WorkUnitEventListener = (event: WorkUnitEvent) => void;
export type Unsubscribe = () => void;

export interface WorkUnitInput {
  text: string;
  senderId?: string;
  senderName?: string;

  steer?: boolean;
}

export interface WorkUnitSnapshot {
  descriptor: WorkUnitDescriptor;

  messages: readonly unknown[];

  contextFill: number;
}

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

export interface CreateWorkUnitOptions {
  parentId: WorkUnitId | null;
  name: string;

  folder?: string;

  config?: RegisteredScoop['config'];

  notifyOnComplete?: boolean;

  id?: WorkUnitId;

  workspace?: {
    mode: WorkspaceIsolationMode;

    from?: string;
  };

  onParentClose?: OnParentClose;
}

export interface CloseWorkUnitOptions {
  descendants?: OnParentClose;
}

export interface JoinOptions {
  timeoutMs?: number;
}

export interface JoinResult {
  id: WorkUnitId;
  summary: string | null;
  timedOut: boolean;
}
