/**
 * fd-level stdio in the realm: `fs.readSync(0, …)` walks the buffered stdin
 * and `fs.writeSync(1|2, …)` reaches the sinks. Emscripten programs read their
 * terminal this way (`fs.readSync(process.stdin.fd, buf, 0, 256)`).
 */

import { describe, expect, it } from 'vitest';
import { createNoFdOps, createStdioFdOps } from '../../../src/kernel/realm/realm-fs-stdio-fd.js';
import { makeCtx, runCode } from './cjs-realm-harness.js';

function sources(stdin: string) {
  const out: string[] = [];
  const err: string[] = [];
  const ops = createStdioFdOps({
    readStdinBytes: () => new TextEncoder().encode(stdin),
    writeStdout: (t) => out.push(t),
    writeStderr: (t) => err.push(t),
  });
  return { ops, out, err };
}

describe('stdio fd ops', () => {
  it('reads stdin in chunks until 0 (EOF)', () => {
    const { ops } = sources('hello world');
    const buf = new Uint8Array(4);
    const chunks: string[] = [];
    let n: number;
    while ((n = ops.readSync(0, buf, 0, 4)) > 0)
      chunks.push(new TextDecoder().decode(buf.subarray(0, n)));
    expect(chunks).toEqual(['hell', 'o wo', 'rld']);
  });

  it('honours offset / length, positional and options forms', () => {
    const { ops } = sources('abcdef');
    const buf = new Uint8Array(6);
    expect(ops.readSync(0, buf, 2, 2)).toBe(2);
    expect(ops.readSync(0, buf, { offset: 4, length: 2 })).toBe(2);
    expect(new TextDecoder().decode(buf.subarray(2))).toBe('abcd');
  });

  it('writes strings and buffer slices to stdout / stderr', () => {
    const { ops, out, err } = sources('');
    expect(ops.writeSync(1, 'héllo')).toBe(6);
    expect(ops.writeSync(2, new Uint8Array([0x61, 0x62, 0x63, 0x64]), 1, 2)).toBe(2);
    expect(out).toEqual(['héllo']);
    expect(err).toEqual(['bc']);
  });

  it('rejects any other fd with EBADF', () => {
    const { ops } = sources('x');
    expect(() => ops.readSync(3, new Uint8Array(1))).toThrow(
      expect.objectContaining({ code: 'EBADF' })
    );
    expect(() => ops.writeSync(0, 'x')).toThrow(expect.objectContaining({ code: 'EBADF' }));
    expect(() => createNoFdOps().readSync(0, new Uint8Array(1))).toThrow(
      expect.objectContaining({ code: 'EBADF' })
    );
  });
});

describe('fd-level stdio in the realm', () => {
  it("serves Emscripten's terminal read loop", async () => {
    const ctx = makeCtx({ stdin: 'line one\nline two\n' });
    const r = await runCode(
      [
        "const fs = require('fs');",
        'const buf = Buffer.alloc(5); let n, all = "";',
        'while ((n = fs.readSync(process.stdin.fd, buf, 0, 5)) > 0) all += buf.toString("utf8", 0, n);',
        'fs.writeSync(process.stdout.fd, all.toUpperCase());',
        'fs.writeSync(process.stderr.fd, "done\\n");',
      ].join('\n'),
      ctx
    );
    expect(r.stdout).toBe('LINE ONE\nLINE TWO\n');
    expect(r.stderr).toBe('done\n');
  });
});
