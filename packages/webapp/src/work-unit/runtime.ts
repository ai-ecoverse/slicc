import type { RegisteredScoop } from '../scoops/types.js';
import type {
  Unsubscribe,
  WorkUnitDescriptor,
  WorkUnitEventListener,
  WorkUnitId,
  WorkUnitInput,
  WorkUnitSnapshot,
} from './types.js';

export interface WorkUnitRuntime {
  readonly descriptor: WorkUnitDescriptor;

  send(input: WorkUnitInput): Promise<void>;

  subscribe(listener: WorkUnitEventListener): Unsubscribe;

  abort(reason?: string): Promise<void>;

  close(): Promise<void>;

  snapshot(): Promise<WorkUnitSnapshot>;
}

export interface WorkUnitHost {
  getScoop(jid: WorkUnitId): RegisteredScoop | undefined;

  ensureLiveUnit(jid: WorkUnitId): WorkUnitRuntime;
}
