import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflate } from 'pako';
import { describe, expect, it } from 'vitest';
import { jpegSize, pngSize } from '../../src/computers/encode-frame.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const EXAMPLE = resolve(
  repoRoot,
  'packages/vfs-root/workspace/skills/jshd/examples/fake-computer.jsh'
);

interface FakeComputerHandlers {
  screenshot: () => Promise<{
    seq: number;
    mime: string;
    width: number;
    height: number;
    bytes: Uint8Array;
  }>;
  input: (events: unknown[]) => Promise<void>;
  softKeys?: Array<{ label: string; keysym: string }>;
}

function loadExample(): FakeComputerHandlers {
  const source = readFileSync(EXAMPLE, 'utf8').replace(/^#!.*\n/, '');
  let handlers: FakeComputerHandlers | null = null;
  const requireFn = (id: string) => {
    if (id !== 'sliccy:computer') throw new Error(`unexpected require('${id}')`);
    return {
      register(next: FakeComputerHandlers) {
        handlers = next;
        return () => undefined;
      },
    };
  };
  const run = new Function('require', source);
  run(requireFn);
  if (!handlers) throw new Error('fake-computer.jsh did not register');
  return handlers;
}

function inflateIdat(bytes: Uint8Array): Uint8Array {
  let offset = 8;
  const pieces: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const len =
      (bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!;
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!
    );
    const data = bytes.subarray(offset + 8, offset + 8 + len);
    if (type === 'IDAT') pieces.push(data);
    if (type === 'IEND') break;
    offset += 12 + len;
  }
  let total = 0;
  for (const p of pieces) total += p.length;
  const zlib = new Uint8Array(total);
  let o = 0;
  for (const p of pieces) {
    zlib.set(p, o);
    o += p.length;
  }
  return inflate(zlib);
}

function sampleRgb(raw: Uint8Array, x: number, y: number): [number, number, number] {
  const i = y * (1 + 640 * 3) + 1 + x * 3;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
}

describe('fake-computer.jsh example', () => {
  it('emits a decodable 640×400 frame', async () => {
    const handlers = loadExample();
    const frame = await handlers.screenshot();
    expect(frame.width).toBe(640);
    expect(frame.height).toBe(400);
    expect(frame.seq).toBe(1);
    if (frame.mime === 'image/png') {
      expect(pngSize(frame.bytes)).toEqual({ width: 640, height: 400 });
      const raw = inflateIdat(frame.bytes);
      expect(raw.byteLength).toBe(400 * (1 + 640 * 3));
    } else {
      expect(frame.mime).toBe('image/jpeg');
      expect(jpegSize(frame.bytes)).toEqual({ width: 640, height: 400 });
      expect(frame.bytes[0]).toBe(0xff);
      expect(frame.bytes[1]).toBe(0xd8);
      expect(frame.bytes.byteLength).toBeGreaterThan(32);
    }
  });

  it('paints a marker at the last click coordinate', async () => {
    const handlers = loadExample();
    await handlers.input([{ type: 'click', button: 1, x: 100, y: 100 }]);
    const frame = await handlers.screenshot();
    if (frame.mime !== 'image/png') return;
    const raw = inflateIdat(frame.bytes);
    const x = 100;
    const y = 100;
    const i = y * (1 + 640 * 3) + 1 + x * 3;
    expect([raw[i], raw[i + 1], raw[i + 2]]).toEqual([245, 197, 24]);
  });

  it('declares Home/Back/Menu soft keys that move the marker or change the background', async () => {
    const handlers = loadExample();
    expect(handlers.softKeys).toEqual([
      { label: 'Home', keysym: 'Home' },
      { label: 'Back', keysym: 'Escape' },
      { label: 'Menu', keysym: 'Menu' },
    ]);

    await handlers.input([{ type: 'key', keysym: 'Home' }]);
    const home = await handlers.screenshot();
    if (home.mime !== 'image/png') return;
    const homeRaw = inflateIdat(home.bytes);
    expect(sampleRgb(homeRaw, 320, 200)).toEqual([245, 197, 24]);
    expect(sampleRgb(homeRaw, 400, 80)).toEqual([26, 31, 46]);

    await handlers.input([{ type: 'key', keysym: 'Menu' }]);
    const menu = await handlers.screenshot();
    const menuRaw = inflateIdat(menu.bytes);
    expect(sampleRgb(menuRaw, 400, 80)).toEqual([72, 24, 48]);

    await handlers.input([{ type: 'key', keysym: 'Escape' }]);
    const back = await handlers.screenshot();
    const backRaw = inflateIdat(back.bytes);
    expect(sampleRgb(backRaw, 48, 352)).toEqual([245, 197, 24]);
  });
});
