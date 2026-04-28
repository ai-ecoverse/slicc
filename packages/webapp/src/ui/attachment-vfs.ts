/**
 * Helpers that off-load oversized chat attachments to the virtual
 * filesystem so the agent can read them with `read_file`/`bash cat`
 * instead of trying to inline a multi-megabyte payload in the prompt.
 */

import type { VirtualFS } from '../fs/index.js';

/** Directory used for off-loaded attachments. */
const ATTACHMENT_DIR = '/tmp';

/**
 * Replace anything outside `[A-Za-z0-9._-]` with `_` and collapse runs of
 * underscores. Keeps the suffix recognizable while staying safe across
 * mounted filesystems.
 */
export function sanitizeAttachmentName(name: string): string {
  const cleaned = name
    .replace(/[\\/:]+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/**
 * Build a unique `/tmp/...` path for `name`. The counter ensures we
 * never collide with another attachment dropped in the same millisecond.
 */
export function makeAttachmentPath(name: string, now: number, counter: number): string {
  const safe = sanitizeAttachmentName(name);
  const stamp = now.toString(36);
  const seq = counter.toString(36);
  return `${ATTACHMENT_DIR}/attachment-${stamp}-${seq}-${safe}`;
}

/**
 * Create an attachment writer bound to the supplied VFS. Returned
 * function writes the file's bytes to `/tmp` and yields the resulting
 * absolute VFS path.
 */
export function createAttachmentTmpWriter(fs: VirtualFS): (file: File) => Promise<string> {
  let counter = 0;
  return async (file: File): Promise<string> => {
    const buffer = new Uint8Array(await file.arrayBuffer());
    counter += 1;
    const path = makeAttachmentPath(file.name, Date.now(), counter);
    await fs.mkdir(ATTACHMENT_DIR, { recursive: true }).catch(() => {});
    await fs.writeFile(path, buffer);
    return path;
  };
}
