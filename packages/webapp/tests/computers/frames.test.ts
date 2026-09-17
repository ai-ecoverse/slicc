import { describe, expect, it } from 'vitest';
import { jpegSize, MINIMAL_JPEG, pngBytesToJpeg } from '../../src/computers/encode-frame.js';
import { frozenFrameLine, frozenFramePath, writeFrozenFrame } from '../../src/computers/frames.js';

describe('encode-frame', () => {
  it('reads SOF0 width/height from a JPEG', () => {
    expect(jpegSize(MINIMAL_JPEG)).toEqual({ width: 1, height: 1 });
  });

  it('transcodes PNG payloads to JPEG when OffscreenCanvas is missing', async () => {
    const png = new Uint8Array(24);
    png[0] = 0x89;
    png[1] = 0x50;
    png[2] = 0x4e;
    png[3] = 0x47;
    png[19] = 8;
    png[23] = 4;
    const jpeg = await pngBytesToJpeg(png);
    expect(jpegSize(jpeg)).toEqual({ width: 1, height: 1 });
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
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
