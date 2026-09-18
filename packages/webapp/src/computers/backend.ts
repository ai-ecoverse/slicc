import type {
  ComputerDescriptor,
  ComputerExecResult,
  ComputerFrame,
  ComputerInputEvent,
  ComputerScreenshotOpts,
} from '@slicc/shared-ts';

export type { ComputerScreenshotOpts };

export interface ComputerBackend {
  describe(): ComputerDescriptor;
  screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame>;
  text?(): Promise<string | null>;
  input(events: ComputerInputEvent[]): Promise<void>;
  exec?(command: string): Promise<ComputerExecResult>;

  subscribe?(fps: number, onFrame: (frame: ComputerFrame) => void, maxWidth?: number): () => void;
  close(): Promise<void>;
}
