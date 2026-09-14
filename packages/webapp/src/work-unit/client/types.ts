import type { WorkUnitModel } from '../../scoops/types.js';
import type { TurnGuestGate } from '../../sudo/types.js';
import type { Unsubscribe, WorkUnitId, WorkUnitRole } from '../types.js';

export type { Unsubscribe, WorkUnitId, WorkUnitRole } from '../types.js';

export type WorkUnitPresentationState = 'initializing' | 'idle' | 'working' | 'broken';

export type WorkUnitPhase = 'thinking' | 'tool';

export interface WorkUnitSummary {
  id: WorkUnitId;

  parentId: WorkUnitId | null | undefined;

  role: WorkUnitRole;
  name: string;
  folder: string;

  assistantLabel: string;
  state: WorkUnitPresentationState;

  phase?: WorkUnitPhase;

  awaiting?: boolean;

  fill: number;

  turns?: number;

  model?: WorkUnitModel;
  trigger?: string;

  addedAt?: string;
}

export interface WorkUnitChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface WorkUnitSnapshot {
  summary?: WorkUnitSummary;
  messages: readonly WorkUnitChatMessage[];

  queuedIds?: readonly string[];
}

export interface WorkUnitClientInput {
  text: string;

  messageId?: string;

  steer?: boolean;
  attachments?: readonly unknown[];

  guestGate?: TurnGuestGate;
}

export type WorkUnitClientEvent =
  | { type: 'status'; state: WorkUnitPresentationState }
  | { type: 'snapshot'; snapshot: WorkUnitSnapshot }
  | { type: 'message'; message: WorkUnitChatMessage };

export type WorkUnitSignal = 'stop';

export interface WorkUnitClient {
  list(): Promise<readonly WorkUnitSummary[]>;

  currentUnits(): readonly WorkUnitSummary[];

  subscribeList(listener: (units: readonly WorkUnitSummary[]) => void): Unsubscribe;

  snapshot(id: WorkUnitId): Promise<WorkUnitSnapshot>;

  send(id: WorkUnitId, input: WorkUnitClientInput): Promise<void>;

  setModel(id: WorkUnitId, model: WorkUnitModel): Promise<boolean | undefined>;

  subscribe(id: WorkUnitId, listener: (event: WorkUnitClientEvent) => void): Unsubscribe;

  signal(id: WorkUnitId, signal: WorkUnitSignal): Promise<void>;
}
