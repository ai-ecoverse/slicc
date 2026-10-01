import { uint8ToBase64 } from '@slicc/shared-ts';
import type { CommandContext } from 'just-bash';
import { detectMimeType } from './shared.js';

export interface ImageContent {
  type: 'image';

  data: string;
  mimeType: string;
}

function sniffImageMime(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 8) === 'PNG\r\n\x1a\n') {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export async function readImages(
  fs: CommandContext['fs'],
  files: ReadonlyArray<{ arg: string; path: string }>
): Promise<{ images: ImageContent[] } | { error: string }> {
  const images: ImageContent[] = [];
  for (const { arg, path } of files) {
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFileBuffer(path);
    } catch {
      return { error: `agent: --image: file not found: ${arg}\n` };
    }
    const mimeType = sniffImageMime(bytes);
    if (mimeType === null) {
      return {
        error: `agent: --image: unsupported image type (${detectMimeType(arg)}): ${arg} — use PNG, JPEG, GIF or WebP\n`,
      };
    }
    images.push({ type: 'image', data: uint8ToBase64(bytes), mimeType });
  }
  return { images };
}
