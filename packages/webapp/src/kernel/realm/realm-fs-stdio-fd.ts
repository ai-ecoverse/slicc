/**
 * `fs.readSync` / `fs.writeSync` for the standard streams. The realm has no
 * file-descriptor table, but fd 0/1/2 are the buffered stdin and the
 * stdout/stderr sinks, and fd-level stdio is how Emscripten programs talk to
 * their terminal (`fs.readSync(process.stdin.fd, buf, 0, 256)`).
 */

/** Positional `readSync` / `writeSync` options, as Node also accepts them. */
interface FdIoOptions {
  offset?: number;
  length?: number;
  position?: number | null;
}

export interface StdioFdSources {
  readStdinBytes(): Uint8Array;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export interface StdioFdOps {
  readSync(
    fd: number,
    buffer: ArrayBufferView,
    offset?: number | FdIoOptions,
    length?: number
  ): number;
  writeSync(fd: number, data: unknown, offsetOrPosition?: number | null, length?: number): number;
}

function ebadf(verb: string, fd: unknown): Error & { code: string } {
  return Object.assign(new Error(`EBADF: bad file descriptor, ${verb} ${String(fd)}`), {
    code: 'EBADF',
  });
}

function viewBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Bytes as the latin1 string (one char per byte) the stdout/stderr pipes carry. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

/** Without a stdio bridge every fd is unknown. */
export function createNoFdOps(): StdioFdOps {
  return {
    readSync: (fd) => {
      throw ebadf('read', fd);
    },
    writeSync: (fd) => {
      throw ebadf('write', fd);
    },
  };
}

export function createStdioFdOps(stdio: StdioFdSources): StdioFdOps {
  // stdin is consumed front to back; the cursor makes repeated reads advance.
  let stdinOffset = 0;
  return {
    readSync(fd, buffer, offsetOrOptions, maybeLength) {
      if (fd !== 0) throw ebadf('read', fd);
      const target = viewBytes(buffer);
      const opts: FdIoOptions =
        typeof offsetOrOptions === 'object' && offsetOrOptions !== null
          ? offsetOrOptions
          : { offset: offsetOrOptions, length: maybeLength };
      const offset = opts.offset ?? 0;
      const length = opts.length ?? target.length - offset;
      const source = stdio.readStdinBytes();
      const count = Math.max(0, Math.min(length, source.length - stdinOffset));
      target.set(source.subarray(stdinOffset, stdinOffset + count), offset);
      stdinOffset += count;
      return count;
    },
    writeSync(fd, data, offsetOrPosition, length) {
      const sink = fd === 1 ? stdio.writeStdout : fd === 2 ? stdio.writeStderr : undefined;
      if (!sink) throw ebadf('write', fd);
      if (typeof data === 'string') {
        sink(data);
        return new TextEncoder().encode(data).length;
      }
      if (!ArrayBuffer.isView(data))
        throw new TypeError('writeSync: data must be a string or buffer');
      const bytes = viewBytes(data);
      const start = typeof offsetOrPosition === 'number' ? offsetOrPosition : 0;
      const chunk = bytes.subarray(start, length === undefined ? undefined : start + length);
      sink(latin1(chunk));
      return chunk.length;
    },
  };
}
