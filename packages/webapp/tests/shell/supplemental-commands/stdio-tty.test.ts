import { unsafeBytesFromLatin1 } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { bytesAsStdout, stdinAsBytes } from '../../../src/shell/just-bash-compat.js';
import { stdinIsTty, stdoutIsTty } from '../../../src/shell/supplemental-commands/stdio-tty.js';

describe('stdio TTY hints', () => {
  it('defaults stdout to a TTY and honours an explicit flag', () => {
    const stdin = unsafeBytesFromLatin1('');
    expect(stdoutIsTty({ stdin })).toBe(true);
    expect(stdoutIsTty({ stdin, stdoutIsTTY: false })).toBe(false);
    expect(stdoutIsTty({ stdin, stdoutIsTTY: true })).toBe(true);
  });

  it('treats empty stdin as a TTY and a non-empty buffer as a pipe', () => {
    expect(stdinIsTty({ stdin: unsafeBytesFromLatin1('') })).toBe(true);
    expect(stdinIsTty({ stdin: unsafeBytesFromLatin1('RIFF') })).toBe(false);
  });

  it('uses a caller-supplied byte length instead of re-reading stdin', () => {
    const stdin = unsafeBytesFromLatin1('RIFF');
    expect(stdinIsTty({ stdin }, 0)).toBe(true);
    expect(stdinIsTty({ stdin }, 4)).toBe(false);
  });

  it('lets an explicit stdinIsTTY override the buffer heuristic', () => {
    expect(stdinIsTty({ stdin: unsafeBytesFromLatin1(''), stdinIsTTY: false })).toBe(false);
    expect(stdinIsTty({ stdin: unsafeBytesFromLatin1('RIFF'), stdinIsTTY: true })).toBe(true);
  });
});

describe('binary stdin/stdout helpers', () => {
  it('round-trips WAV-like bytes through stdin and stdout', () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 255]);
    const asStdin = unsafeBytesFromLatin1(Array.from(wav, (b) => String.fromCharCode(b)).join(''));
    expect(stdinAsBytes(asStdin)).toEqual(wav);

    const out = bytesAsStdout(wav);
    expect(out.stdoutKind).toBe('bytes');
    expect(out.stdoutEncoding).toBe('binary');
    const back = new Uint8Array(out.stdout.length);
    for (let i = 0; i < out.stdout.length; i++) back[i] = out.stdout.charCodeAt(i) & 0xff;
    expect(back).toEqual(wav);
  });

  it('round-trips empty bytes', () => {
    const empty = new Uint8Array();
    expect(stdinAsBytes(unsafeBytesFromLatin1(''))).toEqual(empty);
    const out = bytesAsStdout(empty);
    expect(out.stdout).toBe('');
    expect(out.stdoutKind).toBe('bytes');
  });
});
