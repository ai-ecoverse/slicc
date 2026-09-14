import type { VirtualFS } from '../fs/index.js';
import { normalizePath } from '../fs/path-utils.js';
import { isNoOpWriteDevicePath } from '../fs/virtual-device-paths.js';

/** Full content readback limit before switching to bounded samples. */
const VERIFY_FULL_READBACK_MAX_CHARS = 256 * 1024;

/** Head/tail sample size for oversized durability checks. */
const VERIFY_SAMPLE_CHARS = 4096;

/**
 * Confirm a write actually landed before telling the agent it succeeded.
 *
 * `writeFile` resolving is not enough: ZenFS/OPFS can update an in-memory index
 * (or a mount backend can ack) while a subsequent reader still sees ENOENT.
 * Indexed metadata cannot catch that split-brain, so compare readable content.
 * Large writes use length plus bounded head/tail samples to avoid a second full
 * copy. No-op sink devices discard their payload by design and skip readback.
 *
 * @returns `null` when readable content matches (or the path is a sink), or an
 * error message suitable for a tool result or `FileError`.
 */
export async function verifyWriteLanded(
  fs: VirtualFS,
  path: string,
  content: string
): Promise<string | null> {
  if (isNoOpWriteDevicePath(normalizePath(path))) {
    return null;
  }
  try {
    const readBack = await fs.readTextFile(path);
    if (content.length <= VERIFY_FULL_READBACK_MAX_CHARS) {
      if (readBack !== content) {
        return (
          `Write did not land: ${path} content mismatch ` +
          `(expected ${content.length} chars, got ${readBack.length})`
        );
      }
      return null;
    }

    if (readBack.length !== content.length) {
      return (
        `Write did not land: ${path} content mismatch ` +
        `(expected ${content.length} chars, got ${readBack.length})`
      );
    }
    const sampleSize = VERIFY_SAMPLE_CHARS;
    if (
      readBack.slice(0, sampleSize) !== content.slice(0, sampleSize) ||
      readBack.slice(-sampleSize) !== content.slice(-sampleSize)
    ) {
      return `Write did not land: ${path} content mismatch (head/tail sample)`;
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Write did not land: ${path} is not readable (${message})`;
  }
}
