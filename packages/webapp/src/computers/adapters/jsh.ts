/**
 * jsh-hosted computer backend. The realm owns screenshot/input; the
 * kernel registry holds this proxy and round-trips over `computer-call`
 * events so `sliccy:computer.register` keeps the realm alive via `onEvent`.
 */

import type {
  ComputerDescriptor,
  ComputerExecResult,
  ComputerFrame,
  ComputerInputEvent,
} from '@slicc/shared-ts';
import type { ComputerBackend, ComputerScreenshotOpts } from '../backend.js';

export type JshComputerCall = (
  op: 'screenshot' | 'text' | 'input' | 'exec',
  args: unknown[]
) => Promise<unknown>;

export class JshComputerBackend implements ComputerBackend {
  constructor(
    private descriptor: ComputerDescriptor,
    private readonly call: JshComputerCall
  ) {}

  describe(): ComputerDescriptor {
    return this.descriptor;
  }

  patch(partial: Partial<ComputerDescriptor>): void {
    this.descriptor = { ...this.descriptor, ...partial };
  }

  async screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame> {
    const result = (await this.call('screenshot', [opts])) as ComputerFrame;
    return result;
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
    // Realm unregister drops the subscription; the script may still be running.
  }
}
