import type { BrowserAPI } from '../../cdp/index.js';
import type { CompactionState, CompactionStateDetail } from '../../core/context-compaction.js';
import type { ToolProgressEvent } from '../../shell/progress/types.js';
import type { AppendConeMemoryMeta } from '../cone-memory-store.js';
import type { RegisteredScoop } from '../types.js';

export interface ScoopContextCallbacks {
  onResponse: (text: string, isPartial: boolean) => void;
  onResponseDone: () => void;
  onError: (error: string) => void;

  onFatalError?: (error: string) => void;
  onStatusChange: (status: 'initializing' | 'ready' | 'processing' | 'error') => void;

  onToolStart?: (toolName: string, toolInput: unknown, toolCallId?: string) => void;

  onToolEnd?: (toolName: string, result: string, isError: boolean, toolCallId?: string) => void;

  onToolUI?: (toolName: string, requestId: string, html: string) => void;

  onToolUIDone?: (requestId: string) => void;

  onToolProgress?: (toolName: string, progress: ToolProgressEvent, toolCallId?: string) => void;

  onSendMessage: (text: string, sender?: string) => void;

  getScoops: () => RegisteredScoop[];

  getScoopTabState?: (jid: string) => import('../types.js').ScoopTabState | undefined;

  onFeedScoop?: (scoopJid: string, prompt: string) => Promise<void>;

  onScoopScoop?: (scoop: Omit<RegisteredScoop, 'jid'>) => Promise<RegisteredScoop>;

  onDropScoop?: (scoopJid: string) => Promise<void>;

  onMuteScoops?: (jids: readonly string[]) => void;

  onUnmuteScoops?: (
    jids: readonly string[]
  ) => Promise<
    Array<{ jid: string; summary: string; timestamp: string; notificationPath: string | null }>
  >;

  onScheduleScoopWait?: (
    jids: readonly string[],
    timeoutMs?: number
  ) => { scheduled: string[]; unknown: string[] };

  getGlobalMemory: () => Promise<string>;

  setGlobalMemory?: (content: string) => Promise<void>;

  appendConeMemory?: (bullets: string, meta: AppendConeMemoryMeta) => Promise<void>;

  onCompactionStateChange?: (state: CompactionState, detail: CompactionStateDetail) => void;

  approveGuestToolCall?: (
    request: import('../../sudo/types.js').SudoRequest
  ) => Promise<import('../../sudo/types.js').SudoDecision>;
  onSudoRequest?: (
    request: import('../../sudo/types.js').SudoRequest
  ) => Promise<import('../../sudo/types.js').SudoDecision>;

  onSudoResolve?: (
    id: string,
    decision: import('../../sudo/types.js').SudoDecision
  ) => Promise<{
    settled: boolean;
    persisted: boolean;
    persistedPattern?: string;
    persistError?: string;
    scoopFolder?: string;
    kind?: import('../../sudo/types.js').SudoRequest['kind'];
  }>;

  onListSudoRequests?: () => Array<{
    id: string;
    scoopJid: string;
    request: import('../../sudo/types.js').SudoRequest;
  }>;

  getBrowserAPI: () => BrowserAPI;
}
