/**
 * `select.ts` — select(2) / pselect(2) over kernel descriptors (#3530).
 *
 * Which of `read` / `write` are ready, waiting until one is, the timeout
 * passes, or a caught signal interrupts (EINTR). A descriptor at end of file
 * or whose other end is gone counts as ready: the call that follows reports
 * it. make's jobserver waits for a token (or SIGCHLD) this way.
 */
import { type FdTable, KernelError, pollFile } from './fd-table.js';

export interface SelectResult {
  read: number[];
  write: number[];
}

function ready(fds: FdTable, read: readonly number[], write: readonly number[]): SelectResult {
  return {
    read: read.filter((fd) => {
      const state = pollFile(fds.get(fd).file);
      return state.readable || state.hangup;
    }),
    write: write.filter((fd) => {
      const state = pollFile(fds.get(fd).file);
      return state.writable || state.hangup;
    }),
  };
}

/** Never resolves; rejects with EINTR once `signal` aborts. */
function interruption(signal: AbortSignal): { promise: Promise<never>; done(): void } {
  let fail = (): void => {};
  const promise = new Promise<never>((_, reject) => {
    fail = () => reject(new KernelError('EINTR'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  // The process's interrupt signal outlives this call: detach when it is over.
  return { promise, done: () => signal.removeEventListener('abort', fail) };
}

/** `timeoutMs` < 0 waits forever; 0 only polls. */
export async function selectFds(
  fds: FdTable,
  read: readonly number[],
  write: readonly number[],
  timeoutMs: number,
  interrupt: AbortSignal
): Promise<SelectResult> {
  const deadline = timeoutMs < 0 ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  const interrupted = interruption(interrupt);
  interrupted.promise.catch(() => {}); // raced below; unobserved when nothing interrupts
  try {
    return await waitReady(fds, read, write, deadline, interrupted.promise);
  } finally {
    interrupted.done();
  }
}

async function waitReady(
  fds: FdTable,
  read: readonly number[],
  write: readonly number[],
  deadline: number,
  interrupted: Promise<never>
): Promise<SelectResult> {
  for (;;) {
    const now = ready(fds, read, write);
    if (now.read.length > 0 || now.write.length > 0 || Date.now() >= deadline) return now;
    // Wait for any descriptor to change, the timeout, or a signal; then look again.
    const round = new AbortController();
    const changes = [...new Set([...read, ...write])].flatMap((fd) => {
      const { changed } = fds.get(fd).file;
      return changed === undefined ? [] : [changed(round.signal).catch(() => undefined)];
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry =
      deadline === Number.POSITIVE_INFINITY
        ? []
        : [new Promise<void>((resolve) => (timer = setTimeout(resolve, deadline - Date.now())))];
    try {
      await Promise.race([...changes, ...expiry, interrupted]);
    } finally {
      round.abort(); // drop the other waiters
      clearTimeout(timer);
    }
  }
}
