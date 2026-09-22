import { describe, expect, it } from 'vitest';
import {
  fitComputerFrame,
  jpegSize,
  MINIMAL_JPEG,
  pngBytesToJpeg,
  pngSize,
} from '../../src/computers/encode-frame.js';
import {
  computerTargetLine,
  frozenFrameExtension,
  frozenFrameLine,
  frozenFramePath,
  writeFrozenFrame,
} from '../../src/computers/frames.js';

function pngWithSpuriousSofMarker(): Uint8Array {
  const head = new Uint8Array(24);
  head[0] = 0x89;
  head[1] = 0x50;
  head[2] = 0x4e;
  head[3] = 0x47;
  head[19] = 200;
  head[23] = 100;
  const body = Uint8Array.of(0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x80, 0x01, 0x90, 0x03);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

describe('encode-frame', () => {
  it('reads SOF0 width/height from a JPEG', () => {
    expect(jpegSize(MINIMAL_JPEG)).toEqual({ width: 1, height: 1 });
  });

  it('walks past APP0 to the SOF segment', () => {
    const jpeg = Uint8Array.of(
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x06,
      0x4a,
      0x46,
      0x49,
      0x46,
      0xff,
      0xc2,
      0x00,
      0x0b,
      0x08,
      0x01,
      0x90,
      0x02,
      0x80,
      0x01,
      0x01,
      0x11,
      0x00,
      0xff,
      0xd9
    );
    expect(jpegSize(jpeg)).toEqual({ width: 640, height: 400 });
  });

  it('does not mistake a PNG body byte pair for a SOF marker', () => {
    const png = pngWithSpuriousSofMarker();
    expect(pngSize(png)).toEqual({ width: 200, height: 100 });
    expect(jpegSize(png)).toBeNull();
  });

  it('transcodes a PNG that carries a spurious SOF pair', async () => {
    const jpeg = await pngBytesToJpeg(pngWithSpuriousSofMarker());
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    expect(pngSize(jpeg)).toBeNull();
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

  it('resamples a 640-wide JPEG when a canvas encoder is supplied', async () => {
    const wide = Uint8Array.of(
      0xff,
      0xd8,
      0xff,
      0xc0,
      0x00,
      0x0b,
      0x08,
      0x01,
      0x90,
      0x02,
      0x80,
      0x01,
      0x01,
      0x11,
      0x00,
      0xff,
      0xd9
    );
    expect(jpegSize(wide)).toEqual({ width: 640, height: 400 });
    const scaled = Uint8Array.of(
      0xff,
      0xd8,
      0xff,
      0xc0,
      0x00,
      0x0b,
      0x08,
      0x01,
      0x2c,
      0x01,
      0xe0,
      0x01,
      0x01,
      0x11,
      0x00,
      0xff,
      0xd9
    );
    const fitted = await fitComputerFrame(
      { seq: 1, mime: 'image/jpeg', width: 640, height: 400, bytes: wide },
      480,
      async () => scaled
    );
    expect(fitted).toMatchObject({ width: 480, height: 300, mime: 'image/jpeg' });
    expect(fitted.overCap).toBeUndefined();
    expect(fitted.bytes).toBe(scaled);
  });

  it('passes over-cap pixels through unchanged when resample is unavailable', async () => {
    const wide = Uint8Array.of(
      0xff,
      0xd8,
      0xff,
      0xc0,
      0x00,
      0x0b,
      0x08,
      0x01,
      0x90,
      0x02,
      0x80,
      0x01,
      0x01,
      0x11,
      0x00,
      0xff,
      0xd9
    );
    const fitted = await fitComputerFrame(
      { seq: 1, mime: 'image/jpeg', width: 640, height: 400, bytes: wide },
      480
    );
    expect(fitted.width).toBe(640);
    expect(fitted.height).toBe(400);
    expect(fitted.overCap).toBe(true);
    expect(fitted.bytes).toEqual(wide);
    expect(jpegSize(fitted.bytes)).toEqual({ width: 640, height: 400 });
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

  it('names the file from the bytes, not from frame.mime', async () => {
    const written = new Map<string, Uint8Array | string>();
    const fs = {
      mkdir: async () => {},
      writeFile: async (path: string, data: Uint8Array | string) => {
        written.set(path, data);
      },
      resolvePath: (_cwd: string, path: string) => path,
    };
    const png = pngWithSpuriousSofMarker();

    const path = await writeFrozenFrame({
      fs,
      cwd: '/',
      env: new Map([['TMPDIR', '/tmp/cone']]),
      name: 'tab-T1',
      seq: 7,
      frame: { seq: 7, mime: 'image/jpeg', width: 200, height: 100, bytes: png },
    });
    expect(path).toBe('/tmp/cone/computer/tab-T1/7.png');
    expect(pngSize(written.get(path) as Uint8Array)).toEqual({ width: 200, height: 100 });
    expect(frozenFrameExtension(png)).toBe('png');
    expect(frozenFrameExtension(MINIMAL_JPEG)).toBe('jpg');
    expect(frozenFramePath('/tmp/cone', 'tab-T1', 7, 'png')).toBe(
      '/tmp/cone/computer/tab-T1/7.png'
    );
  });

  it('formats the shell target: stamp', () => {
    expect(computerTargetLine('jsh:fake')).toBe('target: jsh:fake');
  });
});
