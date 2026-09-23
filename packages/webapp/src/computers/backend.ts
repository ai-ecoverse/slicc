import type {
  ComputerDescriptor,
  ComputerExecResult,
  ComputerFrame,
  ComputerInputEvent,
  ComputerScreenshotOpts as SharedComputerScreenshotOpts,
} from '@slicc/shared-ts';

export interface ComputerScreenshotOpts extends SharedComputerScreenshotOpts {
  pull?: boolean;
}

export interface ComputerBackend {
  describe(): ComputerDescriptor;
  screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame>;
  text?(): Promise<string | null>;
  input(events: ComputerInputEvent[]): Promise<void>;
  exec?(command: string): Promise<ComputerExecResult>;

  subscribe?(fps: number, onFrame: (frame: ComputerFrame) => void, maxWidth?: number): () => void;

  readonly screenshotServesStream?: boolean;
  close(): Promise<void>;
}
