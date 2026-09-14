import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { binaryAlphaPng, outputPixelWidth, PRINT_DENSITY } from './agent-merch-lib.mjs';

describe('agent merch rendering', () => {
  it('normalizes every nonzero alpha value to fully opaque', async () => {
    const rgba = Buffer.from([0, 1, 127, 254, 255].flatMap((alpha) => [10, 20, 30, alpha]));
    const input = await sharp(rgba, { raw: { width: 5, height: 1, channels: 4 } })
      .png()
      .toBuffer();

    const output = await binaryAlphaPng(input);
    const pixels = await sharp(output).ensureAlpha().raw().toBuffer();
    const metadata = await sharp(output).metadata();

    expect([...pixels.filter((_, i) => i % 4 === 3)]).toEqual([0, 255, 255, 255, 255]);
    expect(metadata.density).toBe(PRINT_DENSITY);
  });

  it('calculates physical output width at device scale', () => {
    expect(outputPixelWidth(7, 428, 2)).toBe(5_992);
  });
});
