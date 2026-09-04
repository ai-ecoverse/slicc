/**
 * Byte-exact VFS reads for playwright-cli handlers that inject file contents
 * into a page.
 *
 * `VirtualFS.readFile()` defaults to `encoding: 'utf-8'`, and that decode is
 * non-fatal: every byte >= 0x80 that is not part of a valid UTF-8 sequence
 * comes back as U+FFFD, which re-encodes to `EF BF BD`. Feeding that string
 * through `TextEncoder` and into a page `File` silently mangles every JPEG,
 * zip and mp4 while the command still exits 0 (#2883 for `drop`, #2878 for
 * `upload`, same family as #2818).
 */

import type { VirtualFS } from '../../../fs/index.js';

/**
 * Read a VFS file as raw bytes, never through a UTF-8 round-trip.
 *
 * If a backend ignores `encoding: 'binary'` and still hands back a string, a
 * payload that already contains U+FFFD is refused rather than injected as a
 * corrupt `File` — failing loudly beats a page that receives garbage.
 *
 * @throws Error when the content cannot be represented faithfully.
 */
export async function readVfsFileBytes(fs: VirtualFS, path: string): Promise<Uint8Array> {
  const content = await fs.readFile(path, { encoding: 'binary' });
  if (content instanceof Uint8Array) return content;
  if (typeof content !== 'string') {
    throw new Error(`cannot represent '${path}' faithfully: unexpected file content type`);
  }
  if (content.includes('\uFFFD')) {
    throw new Error(
      `cannot represent '${path}' faithfully: file was read as text (contains U+FFFD). ` +
        'Binary files must be read as bytes, not UTF-8.'
    );
  }
  return new TextEncoder().encode(content);
}
