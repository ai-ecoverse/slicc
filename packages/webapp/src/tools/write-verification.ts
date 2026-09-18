import type { VirtualFS } from '../fs/index.js';
import { normalizePath } from '../fs/path-utils.js';
import { isNoOpWriteDevicePath } from '../fs/virtual-device-paths.js';

const VERIFY_FULL_READBACK_MAX_CHARS = 256 * 1024;

const VERIFY_SAMPLE_CHARS = 4096;

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
