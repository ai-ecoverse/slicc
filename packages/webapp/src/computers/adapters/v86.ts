/**
 * Kernel-native v86 computer backend. Wraps a live `VmRecord` already
 * registered by `v86 start`; `computer rm` detaches the descriptor
 * without powering the guest off.
 */

import type {
  ComputerCapabilities,
  ComputerDescriptor,
  ComputerFrame,
  ComputerInputEvent,
  ComputerMouseButton,
} from '@slicc/shared-ts';
import {
  captureFrame,
  dumpTextScreen,
  type VmRecord,
} from '../../shell/supplemental-commands/v86-vm.js';
import type { ComputerBackend, ComputerScreenshotOpts } from '../backend.js';
import { fitRgbaFrame } from '../encode-frame.js';
import { jpegFromRgba } from '../frames.js';
import { chordToScancodes } from '../keys.js';
import { type ComputerRegistry, getComputerRegistry } from '../registry.js';

export function v86ComputerId(name: string): string {
  return `v86:${name}`;
}

const CAPABILITIES: ComputerCapabilities = {
  screenshot: true,
  text: true,
  frames: 'poll',
  keyboard: true,
  mouse: 'relative',
  scroll: true,
  exec: false,
  inputAllowed: true,
};

const BUTTON_INDEX: Record<ComputerMouseButton, 0 | 1 | 2> = { 1: 0, 2: 1, 3: 2 };

export class V86ComputerBackend implements ComputerBackend {
  private lastX = 0;
  private lastY = 0;
  private seq = 0;

  constructor(private readonly record: VmRecord) {}

  describe(): ComputerDescriptor {
    const screen = this.record.screen;
    const size =
      screen.width > 0 && screen.height > 0 ? { width: screen.width, height: screen.height } : null;
    return {
      id: v86ComputerId(this.record.name),
      kind: 'v86',
      title: this.record.name,
      size,
      state: this.record.emulator.is_running() ? 'live' : 'paused',
      capabilities: CAPABILITIES,
      pid: this.record.pid,
    };
  }

  async screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame> {
    const frame = captureFrame(this.record);
    if (!frame) {
      throw new Error(
        `no graphical frame for '${this.record.name}' — the guest is in text mode; use \`computer text\``
      );
    }
    const fitted = fitRgbaFrame(frame, opts.maxWidth);
    const bytes = await jpegFromRgba(fitted);
    this.seq += 1;
    return {
      seq: this.seq,
      mime: 'image/jpeg',
      width: fitted.width,
      height: fitted.height,
      bytes,
    };
  }

  async text(): Promise<string | null> {
    return dumpTextScreen(this.record);
  }

  async input(events: ComputerInputEvent[]): Promise<void> {
    for (const event of events) await this.apply(event);
  }

  async close(): Promise<void> {
    // Detach only — `v86 stop` / ProcessManager abort power the guest off.
  }

  private async apply(event: ComputerInputEvent): Promise<void> {
    switch (event.type) {
      case 'mousemove':
        this.applyMousemove(event);
        return;
      case 'button':
        await this.applyButton(event);
        return;
      case 'click':
        await this.applyClick(event);
        return;
      case 'scroll':
        await this.applyScroll(event);
        return;
      case 'drag':
        await this.applyDrag(event);
        return;
      case 'key':
        this.applyKey(event);
        return;
      case 'text':
        this.record.emulator.keyboard_send_text(event.text);
        return;
      case 'wait':
        await delay(Math.max(0, event.ms));
        return;
      default: {
        const _never: never = event;
        void _never;
      }
    }
  }

  private applyMousemove(event: Extract<ComputerInputEvent, { type: 'mousemove' }>): void {
    const emu = this.record.emulator;
    if (event.relative) {
      emu.bus.send('mouse-delta', [event.x, -event.y]);
      this.lastX += event.x;
      this.lastY += event.y;
      return;
    }
    // PS/2 is relative-only. Re-home to the top-left (same sweep as the
    // old `v86 mouse --to`) so the first screenshot-space click after
    // register — and any later guest clip — lands at the requested coords
    // instead of `event - lastX` from a stale origin.
    this.rehomePointer();
    emu.bus.send('mouse-delta', [event.x, -event.y]);
    this.lastX = event.x;
    this.lastY = event.y;
  }

  private rehomePointer(): void {
    this.record.emulator.bus.send('mouse-delta', [-16384, 16384]);
    this.lastX = 0;
    this.lastY = 0;
  }

  private async maybeMoveTo(x: number | undefined, y: number | undefined): Promise<void> {
    if (x === undefined || y === undefined) return;
    this.applyMousemove({ type: 'mousemove', x, y });
  }

  private async applyButton(event: Extract<ComputerInputEvent, { type: 'button' }>): Promise<void> {
    await this.maybeMoveTo(event.x, event.y);
    this.sendButtons(event.button, event.down);
  }

  private async applyClick(event: Extract<ComputerInputEvent, { type: 'click' }>): Promise<void> {
    await this.maybeMoveTo(event.x, event.y);
    const count = Math.max(1, event.count);
    for (let i = 0; i < count; i++) {
      this.sendButtons(event.button, true);
      if (event.holdMs && event.holdMs > 0) await delay(event.holdMs);
      this.sendButtons(event.button, false);
    }
  }

  private async applyScroll(event: Extract<ComputerInputEvent, { type: 'scroll' }>): Promise<void> {
    await this.maybeMoveTo(event.x, event.y);
    this.record.emulator.bus.send('mouse-wheel', [event.dx, -event.dy]);
  }

  private async applyDrag(event: Extract<ComputerInputEvent, { type: 'drag' }>): Promise<void> {
    this.applyMousemove({ type: 'mousemove', x: event.x1, y: event.y1 });
    this.sendButtons(1, true);
    this.applyMousemove({ type: 'mousemove', x: event.x2, y: event.y2 });
    this.sendButtons(1, false);
  }

  private applyKey(event: Extract<ComputerInputEvent, { type: 'key' }>): void {
    const codes = chordToScancodes(event.keysym);
    if (!codes) throw new Error(`unknown keysym '${event.keysym}'`);
    if (event.down === false) {
      this.record.emulator.keyboard_send_scancodes(codes.filter((_, i) => i >= codes.length / 2));
      return;
    }
    if (event.down === true) {
      this.record.emulator.keyboard_send_scancodes(codes.slice(0, Math.ceil(codes.length / 2)));
      return;
    }
    this.record.emulator.keyboard_send_scancodes(codes);
  }

  private sendButtons(button: ComputerMouseButton, down: boolean): void {
    const state: [boolean, boolean, boolean] = [false, false, false];
    if (down) state[BUTTON_INDEX[button]] = true;
    this.record.emulator.bus.send('mouse-click', state);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerV86Computer(
  record: VmRecord,
  registry: ComputerRegistry | null = getComputerRegistry()
): ComputerDescriptor | null {
  if (!registry) return null;
  return registry.register(new V86ComputerBackend(record), { pid: record.pid });
}

export function unregisterV86Computer(
  name: string,
  registry: ComputerRegistry | null = getComputerRegistry()
): void {
  if (!registry) return;
  void registry.unregister(v86ComputerId(name));
}
