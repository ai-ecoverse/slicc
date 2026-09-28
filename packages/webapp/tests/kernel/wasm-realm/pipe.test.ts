import { describe, expect, it } from 'vitest';
import { KernelPipe, PipeError } from '../../../src/kernel/wasm-realm/pipe.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function openPipe(capacity?: number): KernelPipe {
  const pipe = new KernelPipe(capacity);
  pipe.openRead();
  pipe.openWrite();
  return pipe;
}

describe('KernelPipe', () => {
  it('peeks across chunks without consuming, waits for data, and is empty at EOF', async () => {
    const pipe = openPipe();
    const waiting = pipe.peek(4);
    await pipe.write(bytes('ab'));
    expect(text(await waiting)).toBe('ab');
    await pipe.write(bytes('cd'));
    expect(text(await pipe.peek(3))).toBe('abc');
    expect(text(await pipe.peek(10))).toBe('abcd');
    expect(text(await pipe.read(10))).toBe('abcd');
    pipe.closeWrite();
    expect(await pipe.peek(4)).toEqual(new Uint8Array(0));
  });

  it('passes bytes through in order', async () => {
    const pipe = openPipe();
    await pipe.write(bytes('hello '));
    await pipe.write(bytes('world'));
    expect(text(await pipe.read(64))).toBe('hello world');
  });

  it('reads at most max bytes and keeps the rest', async () => {
    const pipe = openPipe();
    await pipe.write(bytes('abcdef'));
    expect(text(await pipe.read(4))).toBe('abcd');
    expect(text(await pipe.read(4))).toBe('ef');
  });

  it('blocks a reader until data arrives', async () => {
    const pipe = openPipe();
    let got: string | undefined;
    const reading = pipe.read(16).then((b) => {
      got = text(b);
    });
    await Promise.resolve();
    expect(got).toBeUndefined();
    await pipe.write(bytes('late'));
    await reading;
    expect(got).toBe('late');
  });

  it('drains, then reports EOF once the last writer closes', async () => {
    const pipe = openPipe();
    pipe.openWrite(); // a second writer, e.g. inherited across a spawn
    await pipe.write(bytes('x'));
    pipe.closeWrite();
    expect(text(await pipe.read(16))).toBe('x');
    let eof: Uint8Array | undefined;
    const reading = pipe.read(16).then((b) => {
      eof = b;
    });
    await Promise.resolve();
    expect(eof).toBeUndefined(); // one writer is still open
    pipe.closeWrite();
    await reading;
    expect(eof).toHaveLength(0);
  });

  it('blocks a writer while the buffer is full', async () => {
    const pipe = openPipe(4);
    let done = false;
    const writing = pipe.write(bytes('abcdefgh')).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(pipe.buffered).toBe(4);
    expect(text(await pipe.read(8))).toBe('abcd');
    await writing;
    expect(done).toBe(true);
    expect(text(await pipe.read(8))).toBe('efgh');
  });

  it('fails a write with EPIPE once no reader is left, even a blocked one', async () => {
    const pipe = openPipe(2);
    const blocked = pipe.write(bytes('abcd'));
    await Promise.resolve();
    pipe.closeRead();
    await expect(blocked).rejects.toBeInstanceOf(PipeError);
    await expect(pipe.write(bytes('x'))).rejects.toMatchObject({ code: 'EPIPE' });
  });

  it('ends `yes | head -1`: the producer sees EPIPE after the consumer leaves', async () => {
    const pipe = openPipe(16);
    const producer = (async () => {
      try {
        for (;;) await pipe.write(bytes('y\n'));
      } catch (e) {
        return (e as PipeError).code;
      }
    })();
    const line = text(await pipe.read(2));
    pipe.closeRead();
    expect(line).toBe('y\n');
    expect(await producer).toBe('EPIPE');
  });
});
