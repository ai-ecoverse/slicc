import { type FdTable, KernelError, pollFile } from './fd-table.js';

export interface SelectResult {
  read: number[];
  write: number[];

  hangup?: number[];
}

function ready(fds: FdTable, read: readonly number[], write: readonly number[]): SelectResult {
  const hangup = new Set<number>();
  const pick = (list: readonly number[], dir: 'readable' | 'writable') =>
    list.filter((fd) => {
      const state = pollFile(fds.get(fd).file);
      if (state.hangup) hangup.add(fd);
      return state[dir] || state.hangup;
    });
  const out: SelectResult = { read: pick(read, 'readable'), write: pick(write, 'writable') };
  if (hangup.size > 0) out.hangup = [...hangup];
  return out;
}

function interruption(signal: AbortSignal): { promise: Promise<never>; done(): void } {
  let fail = (): void => {};
  const promise = new Promise<never>((_, reject) => {
    fail = () => reject(new KernelError('EINTR'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });

  return { promise, done: () => signal.removeEventListener('abort', fail) };
}

export async function selectFds(
  fds: FdTable,
  read: readonly number[],
  write: readonly number[],
  timeoutMs: number,
  interrupt: AbortSignal
): Promise<SelectResult> {
  const deadline = timeoutMs < 0 ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  const interrupted = interruption(interrupt);
  interrupted.promise.catch(() => {});
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

    const round = new AbortController();
    const changes = [...new Set([...read, ...write])].flatMap((fd) => {
      const file = fds.get(fd).file;
      return file.changed === undefined ? [] : [file.changed(round.signal).catch(() => undefined)];
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry =
      deadline === Number.POSITIVE_INFINITY
        ? []
        : [new Promise<void>((resolve) => (timer = setTimeout(resolve, deadline - Date.now())))];
    try {
      await Promise.race([...changes, ...expiry, interrupted]);
    } finally {
      round.abort();
      clearTimeout(timer);
    }
  }
}
