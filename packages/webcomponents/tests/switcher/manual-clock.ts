import type { AvatarClock } from '../../src/switcher/slicc-agent-avatar.js';

export class ManualClock implements AvatarClock {
  time = 0;
  #frames = new Map<number, (now: number) => void>();
  #timers = new Map<number, { at: number; every?: number; callback: () => void }>();
  #handle = 1;

  now(): number {
    return this.time;
  }

  requestFrame(callback: (now: number) => void): number {
    const handle = this.#handle++;
    this.#frames.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.#frames.delete(handle);
  }

  delay(callback: () => void, ms: number): number {
    const handle = this.#handle++;
    this.#timers.set(handle, { at: this.time + ms, callback });
    return handle;
  }

  cancelDelay(handle: number): void {
    this.#timers.delete(handle);
  }

  repeat(callback: () => void, ms: number): number {
    const handle = this.#handle++;
    this.#timers.set(handle, { at: this.time + ms, every: ms, callback });
    return handle;
  }

  cancelRepeat(handle: number): void {
    this.#timers.delete(handle);
  }

  get pendingFrames(): number {
    return this.#frames.size;
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }

  advance(ms: number, step = 16): void {
    const end = this.time + ms;
    while (this.time < end) {
      this.time = Math.min(end, this.time + step);
      for (const [handle, timer] of [...this.#timers]) {
        if (timer.at > this.time) continue;
        if (timer.every === undefined) this.#timers.delete(handle);
        else timer.at = this.time + timer.every;
        timer.callback();
      }
      const due = [...this.#frames.values()];
      this.#frames.clear();
      for (const callback of due) callback(this.time);
    }
  }
}
