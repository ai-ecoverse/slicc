/**
 * Kernel-side adapter contract for a registered computer.
 *
 * Implementations live next to their host (`adapters/v86.ts` in the worker,
 * `adapters/tab.ts` page-side + bridged, `sliccy:computer` in a jsh realm).
 * The registry talks only this surface.
 */

import type {
  ComputerDescriptor,
  ComputerExecResult,
  ComputerFrame,
  ComputerInputEvent,
  ComputerScreenshotOpts as SharedComputerScreenshotOpts,
} from '@slicc/shared-ts';

export interface ComputerScreenshotOpts extends SharedComputerScreenshotOpts {
  /** Skip a live push-stream cache and capture now. */
  pull?: boolean;
}

export interface ComputerBackend {
  describe(): ComputerDescriptor;
  screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame>;
  text?(): Promise<string | null>;
  input(events: ComputerInputEvent[]): Promise<void>;
  exec?(command: string): Promise<ComputerExecResult>;
  /**
   * Optional push source. The registry polls `screenshot` at `fps` when
   * absent. Push sources may be sparse: consumers keep the last frame and
   * stall only on a real timeout; `screenshot` returns that last frame
   * while a stream is live. `pull: true` skips the cache. `maxWidth` is a
   * hint; the host still downscales frames that arrive wider than the
   * watch cap.
   */
  subscribe?(fps: number, onFrame: (frame: ComputerFrame) => void, maxWidth?: number): () => void;
  close(): Promise<void>;
}
