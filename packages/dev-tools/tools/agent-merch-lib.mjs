import sharp from 'sharp';

export const PRINT_DENSITY = 300;

/**
 * Return a PNG whose alpha channel contains only fully transparent or fully
 * opaque pixels. Any pixel touched by browser antialiasing remains visible.
 */
export async function binaryAlphaPng(input) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alpha = info.channels - 1;
  for (let i = alpha; i < data.length; i += info.channels) data[i] = data[i] === 0 ? 0 : 255;
  return sharp(data, { raw: info })
    .withMetadata({ density: PRINT_DENSITY })
    .png({ adaptiveFiltering: true, compressionLevel: 9 })
    .toBuffer();
}

export function outputPixelWidth(grid, cell, scale) {
  return grid * cell * scale;
}
