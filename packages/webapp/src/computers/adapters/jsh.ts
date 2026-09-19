import type {
  ComputerDescriptor,
  ComputerExecResult,
  ComputerFrame,
  ComputerInputEvent,
} from '@slicc/shared-ts';
import type { ComputerBackend, ComputerScreenshotOpts } from '../backend.js';

export const JSH_FRAME_TIMEOUT_MS = 5_000;

export type JshComputerCall = (
  op: 'screenshot' | 'text' | 'input' | 'exec' | 'subscribe' | 'unsubscribe',
  args: unknown[]
) => Promise<unknown>;

export class JshComputerBackend implements ComputerBackend {
  readonly subscribe?: (
    fps: number,
    onFrame: (frame: ComputerFrame) => void,
    maxWidth?: number
  ) => () => void;
  private lastFrame: ComputerFrame | null = null;
  private readonly sinks = new Set<(frame: ComputerFrame) => void>();
  private readonly waiters = new Set<(frame: ComputerFrame) => void>();
  private subscribed = false;

  constructor(
    private descriptor: ComputerDescriptor,
    private readonly call: JshComputerCall,
    private readonly frameTimeoutMs = JSH_FRAME_TIMEOUT_MS
  ) {
    if (descriptor.capabilities.frames === 'push') {
      this.subscribe = (fps, onFrame, maxWidth) => this.bindSubscribe(fps, onFrame, maxWidth);
    }
  }

  describe(): ComputerDescriptor {
    return this.descriptor;
  }

  patch(partial: Partial<ComputerDescriptor>): void {
    this.descriptor = { ...this.descriptor, ...partial };
  }

  pushFrame(frame: ComputerFrame): void {
    this.lastFrame = frame;
    for (const sink of [...this.sinks]) sink(frame);
    for (const waiter of [...this.waiters]) waiter(frame);
    this.waiters.clear();
  }

  private bindSubscribe(
    fps: number,
    onFrame: (frame: ComputerFrame) => void,
    maxWidth?: number
  ): () => void {
    this.sinks.add(onFrame);
    if (this.lastFrame) onFrame(this.lastFrame);
    if (!this.subscribed) {
      this.subscribed = true;
      void this.call('subscribe', maxWidth ? [fps, maxWidth] : [fps]).catch(() => {
        this.subscribed = false;
      });
    }
    return () => {
      this.sinks.delete(onFrame);
      if (this.sinks.size === 0 && this.subscribed) {
        this.subscribed = false;
        void this.call('unsubscribe', []).catch(() => {});
      }
    };
  }

  async screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame> {
    if (this.subscribed && !opts.pull) {
      if (this.lastFrame) return this.lastFrame;
      return this.waitForCachedFrame();
    }
    return (await this.call('screenshot', [
      { format: opts.format, maxWidth: opts.maxWidth, signal: opts.signal },
    ])) as ComputerFrame;
  }

  async text(): Promise<string | null> {
    const result = await this.call('text', []);
    return typeof result === 'string' ? result : null;
  }

  async input(events: ComputerInputEvent[]): Promise<void> {
    await this.call('input', [events]);
  }

  async exec(command: string): Promise<ComputerExecResult> {
    return (await this.call('exec', [command])) as ComputerExecResult;
  }

  async close(): Promise<void> {
    this.sinks.clear();
    this.waiters.clear();
    if (!this.subscribed) return;
    this.subscribed = false;
    void this.call('unsubscribe', []).catch(() => {});
  }

  private waitForCachedFrame(): Promise<ComputerFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(onFrame);
        reject(new Error('computer frame timed out'));
      }, this.frameTimeoutMs);
      const onFrame = (frame: ComputerFrame): void => {
        clearTimeout(timer);
        this.waiters.delete(onFrame);
        resolve(frame);
      };
      this.waiters.add(onFrame);
    });
  }
}
