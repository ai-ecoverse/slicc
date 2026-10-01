/**
 * `agent --image`: read, type-check and base64 the prompt images. Split from
 * `agent-command.ts` and imported only when `--image` is given, so none of it
 * sits on the kernel worker's boot-critical graph.
 */
import { uint8ToBase64 } from '@slicc/shared-ts';
import type { CommandContext } from 'just-bash';
import { detectMimeType } from './shared.js';

/**
 * A prompt image, restated from pi-ai's `ImageContent` (`core/types.ts`):
 * `shell/` sits below `core/` in the layer stack.
 */
export interface ImageContent {
  type: 'image';
  /** Base64 of the file's raw bytes. */
  data: string;
  mimeType: string;
}

/**
 * The image type from its leading bytes — PNG, JPEG, GIF or WebP, the formats
 * the model APIs take. A file extension is not trusted: a mislabelled file
 * would only fail later, inside the spawned run.
 */
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

/**
 * Read each `--image` file as raw bytes (never through a UTF-8 string) and
 * base64 it for the prompt. Fails on the first missing or non-image file.
 */
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
