import { describe, expect, it } from 'vitest';
import { jpegSize, MINIMAL_JPEG } from '../../src/computers/encode-frame.js';
import { frozenFrameLine, frozenFramePath, writeFrozenFrame } from '../../src/computers/frames.js';

describe('encode-frame', () => {
  it('reads SOF0 width/height from a JPEG', () => {
    expect(jpegSize(MINIMAL_JPEG)).toEqual({ width: 1, height: 1 });
  });
});

describe('frozen frames', () => {
  it('writes JPEG bytes under $TMPDIR/computer/<name>/<seq>.jpg', async () => {
    const written = new Map<string, Uint8Array | string>();
    const fs = {
      mkdir: async () => {},
      writeFile: async (path: string, data: Uint8Array | string) => {
        written.set(path, data);
      },
      resolvePath: (_cwd: string, path: string) => path,
    };
    const env = new Map([['TMPDIR', '/tmp/cone']]);
    const path = await writeFrozenFrame({
      fs,
      cwd: '/',
      env,
      name: 'vm0',
      seq: 3,
      frame: {
        seq: 3,
        mime: 'image/jpeg',
        width: 1,
        height: 1,
        bytes: MINIMAL_JPEG,
      },
    });
    expect(path).toBe('/tmp/cone/computer/vm0/3.jpg');
    expect(written.get(path)).toBe(MINIMAL_JPEG);
    expect(frozenFrameLine(path)).toBe('screen: /tmp/cone/computer/vm0/3.jpg');
    expect(frozenFramePath('/tmp/cone', 'vm0', 3)).toBe('/tmp/cone/computer/vm0/3.jpg');
  });
});
