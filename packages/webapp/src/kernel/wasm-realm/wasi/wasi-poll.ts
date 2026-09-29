/**
 * `wasi-poll.ts` — `poll_oneoff`: clock subscriptions become the timeout,
 * subscriptions on kernel descriptors become one `fd-select` (interruptible
 * by a caught signal, like the Emscripten adapter's `pselect`), and
 * descriptors the worker holds (files, directories, devices) never wait.
 * Go's scheduler sleeps and waits here (`time.Sleep`).
 */
import { E, EVENT_FD_READWRITE_HANGUP, EVENTTYPE, SIZE, SUBCLOCK_ABSTIME } from './wasi-abi.js';
import type { WasiFds, WasiKernel } from './wasi-fds.js';
import type { WasiMemory } from './wasi-memory.js';

interface Subscription {
  userdata: bigint;
  type: number;
  fd: number;
  /** A clock's deadline (performance.now() ms). */
  deadline: number;
}

interface PollEvent {
  userdata: bigint;
  error: number;
  type: number;
  /** The other end is gone (a writer that closed, a reader that left). */
  hangup?: boolean;
}

/** Nanoseconds of clock `id` now: realtime is the epoch's, the others count from `origin`. */
export type ClockNow = (id: number) => bigint;

function readSubscriptions(mem: WasiMemory, ptr: number, n: number, now: ClockNow): Subscription[] {
  const v = mem.view();
  const at = performance.now();
  const subs: Subscription[] = [];
  for (let i = 0; i < n; i++) {
    const p = ptr + i * SIZE.SUBSCRIPTION;
    const type = v.getUint8(p + 8);
    const sub = { userdata: v.getBigUint64(p, true), type, fd: -1, deadline: Infinity };
    if (type === EVENTTYPE.CLOCK) {
      const id = v.getUint32(p + 16, true);
      let ms = Number(v.getBigUint64(p + 24, true)) / 1e6;
      if (v.getUint16(p + 40, true) & SUBCLOCK_ABSTIME) ms -= Number(now(id)) / 1e6;
      sub.deadline = at + Math.max(0, ms);
    } else {
      sub.fd = v.getUint32(p + 16, true);
    }
    subs.push(sub);
  }
  return subs;
}

function writeEvents(mem: WasiMemory, ptr: number, events: readonly PollEvent[]): void {
  const v = mem.view();
  events.forEach((ev, i) => {
    const p = ptr + i * SIZE.EVENT;
    mem.bytes(p, SIZE.EVENT).fill(0);
    v.setBigUint64(p, ev.userdata, true);
    v.setUint16(p + 8, ev.error, true);
    v.setUint8(p + 10, ev.type);
    // fd_readwrite.nbytes: unknown, 1 is enough for a caller to try.
    if (ev.type !== EVENTTYPE.CLOCK) {
      v.setBigUint64(p + 16, 1n, true);
      if (ev.hangup) v.setUint16(p + 24, EVENT_FD_READWRITE_HANGUP, true);
    }
  });
}

/** Split the subscriptions: kernel fds to select on, and events known now (bad fds, held fds). */
function classify(
  fds: WasiFds,
  subs: readonly Subscription[]
): { events: PollEvent[]; read: number[]; write: number[] } {
  const events: PollEvent[] = [];
  const read: number[] = [];
  const write: number[] = [];
  for (const s of subs) {
    if (s.type === EVENTTYPE.CLOCK) continue;
    const e = fds.find(s.fd);
    if (!e) events.push({ userdata: s.userdata, error: E.BADF, type: s.type });
    else if (e.type !== 'kernel')
      events.push({ userdata: s.userdata, error: E.SUCCESS, type: s.type });
    else (s.type === EVENTTYPE.FD_READ ? read : write).push(s.fd);
  }
  return { events, read, write };
}

/** The subscriptions `fd-select` found ready. */
function readyEvents(
  subs: readonly Subscription[],
  ready: { read: number[]; write: number[]; hangup?: number[] }
): PollEvent[] {
  return subs
    .filter(
      (s) =>
        (s.type === EVENTTYPE.FD_READ && ready.read.includes(s.fd)) ||
        (s.type === EVENTTYPE.FD_WRITE && ready.write.includes(s.fd))
    )
    .map((s) => ({
      userdata: s.userdata,
      error: E.SUCCESS,
      type: s.type,
      hangup: ready.hangup?.includes(s.fd) === true,
    }));
}

export function pollOneoff(
  deps: { mem: WasiMemory; fds: WasiFds; kernel: WasiKernel; now: ClockNow },
  inPtr: number,
  outPtr: number,
  nsubs: number,
  neventsPtr: number
): number {
  if (nsubs === 0) return E.INVAL;
  const { mem, kernel } = deps;
  const subs = readSubscriptions(mem, inPtr, nsubs, deps.now);
  const { events, read, write } = classify(deps.fds, subs);
  if (read.length > 0 || write.length > 0 || events.length === 0) {
    // Wait for a descriptor or the earliest clock (-1: forever); not at all when one is ready.
    const earliest = Math.min(...subs.map((s) => s.deadline));
    let timeoutMs = -1;
    if (events.length > 0) timeoutMs = 0;
    else if (earliest !== Infinity)
      timeoutMs = Math.max(0, Math.ceil(earliest - performance.now()));
    const ready = kernel.call({ op: 'fd-select', read, write, timeoutMs });
    events.push(
      ...readyEvents(subs, ready as { read: number[]; write: number[]; hangup?: number[] })
    );
  }
  const after = performance.now();
  // A deadline within half a millisecond counts: select's timer rounds.
  for (const s of subs) {
    if (s.type === EVENTTYPE.CLOCK && s.deadline <= after + 0.5) {
      events.push({ userdata: s.userdata, error: E.SUCCESS, type: s.type });
    }
  }
  writeEvents(mem, outPtr, events);
  mem.view().setUint32(neventsPtr, events.length, true);
  return E.SUCCESS;
}
